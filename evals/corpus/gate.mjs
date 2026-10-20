#!/usr/bin/env node
// Jev as a pre-gate for the conditional lenses (#166).
//
// Usage:
//   node evals/corpus/gate.mjs --phase compose --harvest <dir> --decisions <decisions.jsonl> --work <new-dir> [--limit N]
//   OPENROUTER_API_KEY=… node evals/corpus/gate.mjs --phase call --work <dir>
//   node evals/corpus/gate.mjs --phase score --work <dir> [--adjudications <file.json>]
//   node evals/corpus/gate.mjs --phase worksheet --harvest <dir> --decisions <decisions.jsonl> --work <dir> [--order case|p]
//
// compose freezes questions, baseline, labels and every case's state; call
// spends credits and refuses to run twice; score is free and re-runnable.
// worksheet writes the blind adjudication worksheet and template; --order p
// lists likely off-surface findings first but never prints Jev's answers.
// Offline measurement only: nothing here changes what the action runs.
//
// Measuring a lens prompt change (#170): compose a new --work directory from
// the same harvest and decisions with the revised lens outputs, run call and
// score, and compare summary.offSurface and summary.adjudicated per lens with
// the earlier run. Fewer off-surface candidates with no drop in adjudicated
// real findings is an improvement; anything else is not.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BASELINE, GATED, LABELS, QUESTIONS, baselineRuns, buildGateState, labelRound, lensCosts, lensSummary, offSurface, parseGateAnswers, questionSha256, scoreGate } from "./lib/gate.mjs";
import { FATAL, MODEL, screenCase } from "./lib/jev.mjs";
import { SEVERITY_HEADING, extractLensJson, mustFixItems } from "./lib/review-formats.mjs";

const safe = (caseId) => caseId.replace(/[^\w.@-]/g, "_");
const baselineSource = () => Object.fromEntries(Object.entries(BASELINE).map(([k, re]) => [k, re.source]));

export function compose({ harvest, decisions, work, limit = null }) {
  const planPath = join(work, "plan.json");
  if (existsSync(planPath)) throw new Error("Refusing to overwrite an existing plan; use a new --work directory");
  const accepted = readFileSync(decisions, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((d) => d.accepted);
  const cases = [];
  for (const d of accepted) {
    const snapshot = JSON.parse(readFileSync(join(harvest, `${d.snapshotId}.json`), "utf8"));
    const round = snapshot.rounds.find((r) => r.headSha === d.headSha);
    if (!round) throw new Error(`round for ${d.caseId} not found in harvest`);
    const labels = labelRound(round);
    if (Object.values(labels).every((l) => l === null)) continue;
    const { state, truncated } = buildGateState(round, d);
    cases.push({ caseId: d.caseId, flags: d.flags, labels, baseline: baselineRuns(snapshot.title, d.diffstat), lensCosts: lensCosts(round), truncated, state });
    if (limit !== null && cases.length >= limit) break;
  }
  const plan = { schemaVersion: 1, model: MODEL, questionSha256: questionSha256(), questions: QUESTIONS, baseline: baselineSource(), cases };
  mkdirSync(work, { recursive: true });
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  return plan;
}

export function readPlan(work) {
  const plan = JSON.parse(readFileSync(join(work, "plan.json"), "utf8"));
  if (plan.questionSha256 !== questionSha256() || plan.questionSha256 !== questionSha256(plan.questions)) {
    throw new Error("Questions changed since compose; compose a new run");
  }
  if (JSON.stringify(plan.baseline) !== JSON.stringify(baselineSource())) throw new Error("Baseline changed since compose; compose a new run");
  return plan;
}

export async function call(work, { key = process.env.OPENROUTER_API_KEY, log = console.log, ...transport } = {}) {
  const plan = readPlan(work);
  if (!key) throw new Error("OPENROUTER_API_KEY required for the call phase");
  try { writeFileSync(join(work, ".started"), "", { flag: "wx" }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Refusing to repeat a paid run; compose a new --work directory");
    throw error;
  }
  for (const c of plan.cases) {
    const record = await screenCase(c.state, plan.questions, { key, title: "eval-corpus-lens-gate", parse: parseGateAnswers, ...transport });
    writeFileSync(join(work, `${safe(c.caseId)}.result.json`), JSON.stringify(record, null, 2) + "\n");
    log(`${c.caseId}: ${record.error ?? "ok"}`);
    if (FATAL.has(record.status)) throw new Error(`Fatal provider response ${record.status}; run abandoned`);
  }
}

const ADJUDICATED = new Set(["real", "off_surface"]);

/**
 * Adjudications: { "<caseId>": { "<lens>": "real" | "off_surface" } }, written
 * by a human for with_findings cases. off_surface means the lens reported a
 * finding outside its own surface; gating that out is not a miss.
 */
export function applyAdjudications(rows, adjudications) {
  if (!adjudications) return rows;
  const known = new Set(rows.map((r) => r.caseId));
  for (const [caseId, byLens] of Object.entries(adjudications)) {
    if (!known.has(caseId)) throw new Error(`adjudication for unknown case ${caseId}`);
    for (const [lens, verdict] of Object.entries(byLens)) {
      if (!(lens in GATED) || !ADJUDICATED.has(verdict)) throw new Error(`invalid adjudication ${caseId}/${lens}: ${verdict}`);
    }
  }
  return rows.map((r) => {
    const byLens = adjudications[r.caseId] ?? {};
    const labels = { ...r.labels };
    for (const [lens, verdict] of Object.entries(byLens)) {
      if (labels[lens] !== LABELS.WITH_FINDINGS) throw new Error(`adjudication for ${r.caseId}/${lens} but its label is ${labels[lens]}`);
      if (verdict === "off_surface") labels[lens] = LABELS.NO_FINDINGS;
    }
    return { ...r, labels };
  });
}

export function score(work, { adjudications = null } = {}) {
  const plan = readPlan(work);
  const rows = plan.cases.map((c) => {
    let result;
    try { result = JSON.parse(readFileSync(join(work, `${safe(c.caseId)}.result.json`), "utf8")); }
    catch { result = { error: "missing_result", usage: null }; }
    if (!result || typeof result !== "object") result = { error: "malformed_result", usage: null };
    if (!result.error) {
      try { parseGateAnswers(Object.fromEntries(Object.entries(result.probabilities ?? {}).map(([k, p]) => [k, { type: "noul", noul: p }])), plan.questions); }
      catch { result = { ...result, error: "malformed_result" }; }
    }
    return { caseId: c.caseId, flags: c.flags, labels: c.labels, baseline: c.baseline, lensCosts: c.lensCosts, truncated: c.truncated, probabilities: result.error ? null : result.probabilities, error: result.error ?? null, usage: result.usage ?? null };
  });
  const costs = rows.map((r) => r.usage?.cost).filter((x) => typeof x === "number" && Number.isFinite(x) && x >= 0);
  const summary = {
    model: plan.model,
    questionSha256: plan.questionSha256,
    cases: rows.length,
    failedCalls: rows.filter((r) => r.error).length,
    truncatedStates: rows.filter((r) => r.truncated).length,
    raw: scoreGate(rows),
    adjudicated: adjudications ? scoreGate(applyAdjudications(rows, adjudications)) : "none: with_findings counts every reported finding as real",
    offSurface: offSurface(rows, adjudications),
    usage: { reportedCostUsd: costs.reduce((a, b) => a + b, 0), missingUsageCalls: rows.length - costs.length, costUsd: costs.length === rows.length ? costs.reduce((a, b) => a + b, 0) : null },
  };
  writeFileSync(join(work, "gate.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  writeFileSync(join(work, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

const FINDING_LINE = /^\s*(?:[-*]\s+|\d+[.)]\s+)?(\[(?:MUST FIX|SHOULD FIX)\][^\n]{0,300})/gm;
const MAX_FILES = 8;
const SERIOUS = new Set(["MUST FIX", "SHOULD FIX"]);

// Same sources labelRound reads, in the same order: structured findings, then
// tagged entries, then severity headings. All of them, since one verdict
// covers the whole case.
function findingLines(output) {
  const body = output.body ?? "";
  const structured = Array.isArray(output.findings) ? output.findings : extractLensJson(body)?.findings;
  if (Array.isArray(structured)) return structured.filter((f) => SERIOUS.has(f?.severity)).map((f) => `[${f.severity}] ${f.location ? `\`${f.location}\` — ` : ""}${String(f.detail ?? f.title ?? "").slice(0, 300)}`);
  const tagged = [...body.matchAll(FINDING_LINE)].map((m) => m[1]);
  if (tagged.length) return tagged;
  return (mustFixItems(body, SEVERITY_HEADING) ?? []).map((it) => it.text.slice(0, 300));
}

/**
 * Blind adjudication worksheet for with_findings cases. order "p" sorts each
 * lens's cases by Jev's probability, lowest first, so likely noise is read
 * first; the probability itself is never written.
 */
export function worksheet({ harvest, decisions, work, order = "case" }) {
  if (order !== "case" && order !== "p") throw new Error("--order must be case or p");
  const plan = readPlan(work);
  const byId = Object.fromEntries(readFileSync(decisions, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((d) => [d.caseId, d]));
  const p = (caseId, lens) => {
    try { return JSON.parse(readFileSync(join(work, `${safe(caseId)}.result.json`), "utf8"))?.probabilities?.[lens] ?? Infinity; }
    catch { return Infinity; }
  };
  let md = "# Lens-gate adjudication (#166)\n\nFor each case: was the finding inside the lens's own surface (`real`) or outside it (`off_surface`)? Fill `adjudications.json` from the template. Do not look at Jev output first.\n";
  const template = {};
  let items = 0;
  for (const [lens, re] of Object.entries(GATED)) {
    md += `\n## ${lens}\n`;
    let cases = plan.cases.filter((c) => c.labels[lens] === LABELS.WITH_FINDINGS);
    if (order === "p") cases = cases.map((c) => [p(c.caseId, lens), c]).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    for (const c of cases) {
      const d = byId[c.caseId];
      if (!d) throw new Error(`decision for ${c.caseId} not found`);
      const snapshot = JSON.parse(readFileSync(join(harvest, `${d.snapshotId}.json`), "utf8"));
      const round = snapshot.rounds.find((r) => r.headSha === d.headSha);
      if (!round) throw new Error(`round for ${c.caseId} not found in harvest`);
      const outputs = round.outputs.filter((o) => typeof o.lens === "string" && re.test(o.lens) && !/^\s*See the review summary/i.test(o.body ?? ""));
      const findings = [...new Set(outputs.flatMap(findingLines))];
      const files = (d.diffstat ?? []).map((f) => f.path);
      const more = files.length > MAX_FILES ? ` (+${files.length - MAX_FILES})` : "";
      const lines = findings.length ? findings.map((f) => `- ${f}`).join("\n") : `- ${(lensSummary(outputs[0]?.body) ?? "").slice(0, 300)}`;
      md += `\n### ${c.caseId} — ${snapshot.title}\nFiles: ${files.slice(0, MAX_FILES).join(", ")}${more}\n\n${lines}\n`;
      (template[c.caseId] ??= {})[lens] = "";
      items++;
    }
  }
  writeFileSync(join(work, "adjudication-worksheet.md"), md);
  writeFileSync(join(work, "adjudications.template.json"), JSON.stringify(template, null, 2) + "\n");
  return { items };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const phase = flag("--phase");
  const work = flag("--work") && resolve(flag("--work"));
  if (!work) throw new Error("Use --work <dir>");
  if (phase === "compose") {
    if (!flag("--harvest") || !flag("--decisions")) throw new Error("compose needs --harvest and --decisions");
    const limit = flag("--limit") ? Number(flag("--limit")) : null;
    if (limit !== null && !(Number.isSafeInteger(limit) && limit > 0)) throw new Error("--limit must be a positive integer");
    const plan = compose({ harvest: resolve(flag("--harvest")), decisions: resolve(flag("--decisions")), work, limit });
    console.log(`Composed ${plan.cases.length} cases (${plan.cases.filter((c) => c.truncated).length} truncated); no credits spent.`);
  } else if (phase === "call") {
    await call(work);
  } else if (phase === "score") {
    const adjudications = flag("--adjudications") ? JSON.parse(readFileSync(resolve(flag("--adjudications")), "utf8")) : null;
    console.log(JSON.stringify(score(work, { adjudications }), null, 2));
  } else if (phase === "worksheet") {
    if (!flag("--harvest") || !flag("--decisions")) throw new Error("worksheet needs --harvest and --decisions");
    const { items } = worksheet({ harvest: resolve(flag("--harvest")), decisions: resolve(flag("--decisions")), work, order: flag("--order") ?? "case" });
    console.log(`Wrote ${items} worksheet items.`);
  } else {
    throw new Error("--phase must be compose, call, score or worksheet");
  }
}
