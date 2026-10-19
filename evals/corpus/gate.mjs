#!/usr/bin/env node
// Jev as a pre-gate for the conditional lenses (#166).
//
// Usage:
//   node evals/corpus/gate.mjs --phase compose --harvest <dir> --decisions <decisions.jsonl> --work <new-dir> [--limit N]
//   OPENROUTER_API_KEY=… node evals/corpus/gate.mjs --phase call --work <dir>
//   node evals/corpus/gate.mjs --phase score --work <dir> [--adjudications <file.json>]
//
// compose freezes questions, baseline, labels and every case's state; call
// spends credits and refuses to run twice; score is free and re-runnable.
// Offline measurement only: nothing here changes what the action runs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BASELINE, GATED, LABELS, QUESTIONS, baselineRuns, buildGateState, labelRound, lensCosts, parseGateAnswers, questionSha256, scoreGate } from "./lib/gate.mjs";
import { FATAL, MODEL, screenCase } from "./lib/jev.mjs";

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
    usage: { reportedCostUsd: costs.reduce((a, b) => a + b, 0), missingUsageCalls: rows.length - costs.length, costUsd: costs.length === rows.length ? costs.reduce((a, b) => a + b, 0) : null },
  };
  writeFileSync(join(work, "gate.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  writeFileSync(join(work, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
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
  } else {
    throw new Error("--phase must be compose, call or score");
  }
}
