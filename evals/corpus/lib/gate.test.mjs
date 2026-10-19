import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABELS, QUESTIONS, THRESHOLDS, baselineRuns, buildGateState, labelRound, lensCosts, lensSummary, parseGateAnswers, scoreGate } from "./gate.mjs";
import { applyAdjudications, call, compose, score } from "../gate.mjs";

const FOOTER = "\n---\n[View action run](https://github.com/o/r/actions/runs/1) | Model: m | Tokens: 12.1K | Cost: $0.02 | Pi SDK v0.82.1";
const piJson = (lens, summary, findings = []) => ({ pipeline: "pi-lens-json-comment", lens, verdict: "PASS", body: `${JSON.stringify({ lens, summary, findings })}${FOOTER}` });
const lensReview = (lens, summary, items = "No findings.") => ({ pipeline: "bpr-action-lens-review", lens, verdict: "PASS", body: `## ${lens}\n> ${summary}\n${items}` });
const inline = (lens, severity, body = "See the review summary.") => ({ pipeline: "bpr-action-inline", lens, severity, body });

test("labels: self-skip, findings, no findings, placeholders and absent lenses", () => {
  const round = {
    outputs: [
      piJson("Viper", "Viper skipped — no auth/crypto/token/session/login/parsing/infra changes."),
      inline("Viper", null),
      lensReview("OWASP Web Top 10", "One A05 gap.", "- [SHOULD FIX] `action.yml:3` — floor dropped"),
      lensReview("OWASP LLM Top 10", "No LLM risks found in this change."),
    ],
  };
  assert.deepEqual(labelRound(round), { red_team: LABELS.SKIPPED, owasp_web: LABELS.WITH_FINDINGS, owasp_llm: LABELS.NO_FINDINGS });
  assert.deepEqual(labelRound({ outputs: [inline("Red Team", null)] }), { red_team: null, owasp_web: null, owasp_llm: null });
});

test("labels: findings come from verdict, severity fields, contract JSON or tags; NITPICK alone is not a finding", () => {
  const one = (o) => labelRound({ outputs: [o] }).red_team;
  assert.equal(one({ ...lensReview("Red Team", "Chain found."), verdict: "BLOCK" }), LABELS.WITH_FINDINGS);
  assert.equal(one(inline("Red Team", "MUST FIX", "[MUST FIX] token replay")), LABELS.WITH_FINDINGS);
  assert.equal(one(piJson("Red Team", "Chain found.", [{ severity: "SHOULD FIX" }])), LABELS.WITH_FINDINGS);
  assert.equal(one(piJson("Red Team", "Minor only.", [{ severity: "NITPICK" }])), LABELS.NO_FINDINGS);
  assert.equal(one({ ...piJson("Red Team", "No [MUST FIX] or [SHOULD FIX] findings."), severity: "MUST FIX", verdict: "BLOCK" }), LABELS.NO_FINDINGS);
  assert.equal(one({ pipeline: "ralph-bmad-lens-paste", lens: "Red Team (Viper)", body: "## Review\n- [SHOULD FIX] x" }), LABELS.WITH_FINDINGS);
  const pasted = (body) => one({ pipeline: "ralph-bmad-lens-paste", lens: "Red Team (Viper)", body });
  assert.equal(pasted("## Review: Red Team\n### SHOULD FIX\n- `auth.py:12` token reused across tenants"), LABELS.WITH_FINDINGS);
  assert.equal(pasted("## Review: Red Team\n### BLOCK (must fix before merge)\nNo BLOCK findings.\n### WARN\nNone."), LABELS.NO_FINDINGS);
});

test("labels: only a leading skip in the summary is a self-skip, not a finding that mentions skipping", () => {
  const one = (summary) => labelRound({ outputs: [lensReview("Red Team", summary)] }).red_team;
  assert.equal(one("Skipped — no auth surface."), LABELS.SKIPPED);
  assert.equal(one("Red Team skipped — no auth surface."), LABELS.SKIPPED);
  assert.equal(labelRound({ outputs: [lensReview("OWASP Web Top 10", "OWASP Web Top 10 skipped — no HTTP surface.")] }).owasp_web, LABELS.SKIPPED);
  assert.equal(one("Attackers can skip token validation on this path."), LABELS.NO_FINDINGS);
  assert.equal(one("The self-skip check can hide an authentication bypass."), LABELS.NO_FINDINGS);
  assert.equal(labelRound({ outputs: [lensReview("Red Team", "The self-skip check can hide an auth bypass.", "- [MUST FIX] `a.js:1` bypass")] }).red_team, LABELS.WITH_FINDINGS);
});

test("labels: a skip and a finding for the same lens in one round is a conflict", () => {
  const round = { outputs: [piJson("OWASP Web Top 10", "Skipped — no web/HTTP surface."), inline("OWASP Web Top 10", "SHOULD FIX", "[SHOULD FIX] x")] };
  assert.equal(labelRound(round).owasp_web, LABELS.CONFLICT);
});

test("lens summary reads contract JSON first, then the quoted line under the heading", () => {
  assert.equal(lensSummary(piJson("Viper", "Viper skipped.").body), "Viper skipped.");
  assert.equal(lensSummary("## Red Team\n> No exploitable findings.\nNo findings."), "No exploitable findings.");
  assert.equal(lensSummary("free text"), null);
});

test("lens cost comes from the pi footer; absent is null, never zero", () => {
  assert.deepEqual(lensCosts({ outputs: [piJson("Viper", "s")] }), { red_team: 0.02, owasp_web: null, owasp_llm: null });
});

test("Jev state holds only the PR body and diffstat, never review text", () => {
  const round = { body: "b".repeat(30_000), outputs: [lensReview("Red Team", "SECRET-REVIEW-TEXT")] };
  const { state, truncated } = buildGateState(round, { diffstat: [{ path: "a.js", added: 1, removed: 2 }] });
  assert.deepEqual(Object.keys(state), ["prBody", "diffstat"]);
  assert.doesNotMatch(JSON.stringify(state), /SECRET-REVIEW-TEXT/);
  assert.equal(state.diffstat, "a.js +1 -2");
  assert.equal(truncated, true);
  const many = Array.from({ length: 301 }, (_, i) => ({ path: `f${i}`, added: 1, removed: 0 }));
  assert.equal(buildGateState({ body: "x", outputs: [] }, { diffstat: many }).truncated, true);
  assert.equal(buildGateState({ body: "x", outputs: [] }, { diffstat: many.slice(0, 300) }).truncated, false);
  for (const q of Object.values(QUESTIONS)) assert.doesNotMatch(q.instructions, /review|finding/i);
});

test("baseline runs a lens when the title or any changed path matches its surface", () => {
  assert.deepEqual(baselineRuns("chore: release 1.5.0", [{ path: "CHANGELOG.md" }]), { red_team: false, owasp_web: false, owasp_llm: false });
  assert.deepEqual(baselineRuns("docs", [{ path: "src/auth/jwt.py" }, { path: "lenses/red_team.md" }]), { red_team: true, owasp_web: false, owasp_llm: true });
});

test("answers must be noul probabilities in [0, 1]; anything else fails the call", () => {
  const all = { red_team: { type: "noul", noul: 0.1 }, owasp_web: { type: "noul", noul: 0.9 }, owasp_llm: { type: "noul", noul: 0 } };
  assert.deepEqual(parseGateAnswers(all), { red_team: 0.1, owasp_web: 0.9, owasp_llm: 0 });
  for (const bad of [{ type: "choice", noul: 0.5 }, { type: "noul", noul: -0.1 }, { type: "noul", noul: "0.5" }]) {
    assert.throws(() => parseGateAnswers({ ...all, owasp_web: bad }), /invalid answer for owasp_web/);
  }
});

const row = (caseId, label, p, baselineRun) => ({
  caseId,
  labels: { red_team: label, owasp_web: null, owasp_llm: null },
  baseline: { red_team: baselineRun, owasp_web: true, owasp_llm: true },
  probabilities: p === null ? null : { red_team: p, owasp_web: 1, owasp_llm: 1 },
  lensCosts: { red_team: 0.06 },
});

test("scoring: calls avoided, missed findings and skip agreement per arm; best zero-miss threshold is in-sample", () => {
  const rows = [
    row("skip-a", LABELS.SKIPPED, 0.01, false),
    row("skip-b", LABELS.SKIPPED, 0.12, true),
    row("quiet", LABELS.NO_FINDINGS, 0.25, false),
    row("found", LABELS.WITH_FINDINGS, 0.35, false),
    row("conflict", LABELS.CONFLICT, 0.01, false),
    row("failed", LABELS.SKIPPED, null, false),
  ];
  const s = scoreGate(rows).red_team;
  assert.deepEqual(s.labels, { skipped: 3, noFindings: 1, withFindings: 1 });
  assert.equal(s.excludedConflicts, 1);
  assert.equal(s.medianLensCostUsd, 0.06);
  assert.deepEqual(s.baseline, { gatedOut: 4, missedFindings: 1, missedCaseIds: ["found"], agreeSkip: 2, disagreeSkip: 3 });
  assert.equal(s.jevCases, 4);
  assert.deepEqual(s.baselineOnJevCases, { gatedOut: 3, missedFindings: 1, missedCaseIds: ["found"], agreeSkip: 1, disagreeSkip: 3 });
  const at = (t) => s.jev.find((j) => j.threshold === t);
  assert.deepEqual(at(0.15), { threshold: 0.15, gatedOut: 2, missedFindings: 0, missedCaseIds: [], agreeSkip: 4, disagreeSkip: 0 });
  assert.equal(at(0.4).missedFindings, 1);
  assert.deepEqual(s.jevBestZeroMissInSample, { threshold: 0.3, gatedOut: 3 });
  assert.equal(s.jev.length, THRESHOLDS.length);
});

test("adjudication: off_surface findings stop counting as misses; invalid entries are refused", () => {
  const rows = [row("found", LABELS.WITH_FINDINGS, 0.01, false)];
  assert.equal(applyAdjudications(rows, { found: { red_team: "off_surface" } })[0].labels.red_team, LABELS.NO_FINDINGS);
  assert.equal(applyAdjudications(rows, { found: { red_team: "real" } })[0].labels.red_team, LABELS.WITH_FINDINGS);
  assert.throws(() => applyAdjudications(rows, { found: { red_team: "maybe" } }), /invalid adjudication/);
  assert.throws(() => applyAdjudications(rows, { found: { cold_read: "real" } }), /invalid adjudication/);
  assert.throws(() => applyAdjudications([row("quiet", LABELS.NO_FINDINGS, 0.5, true)], { quiet: { red_team: "real" } }), /label is no_findings/);
});

function fixtureCorpus() {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const harvest = join(dir, "harvest");
  mkdirSync(harvest);
  const rounds = [
    { headSha: "a1", body: "Bump version", outputs: [piJson("Viper", "Viper skipped — no auth changes.")] },
    { headSha: "b2", body: "Cold read only", outputs: [lensReview("Cold Read", "Fine.")] },
  ];
  writeFileSync(join(harvest, "r-1.json"), JSON.stringify({ title: "chore: release", rounds }));
  const decisions = join(dir, "decisions.jsonl");
  writeFileSync(decisions, [
    { caseId: "r-1@a1", snapshotId: "r-1", headSha: "a1", accepted: true, flags: [], diffstat: [{ path: "CHANGELOG.md", added: 3, removed: 0 }] },
    { caseId: "r-1@b2", snapshotId: "r-1", headSha: "b2", accepted: true, flags: [], diffstat: [] },
    { caseId: "r-1@zz", snapshotId: "r-1", headSha: "zz", accepted: false, flags: [], diffstat: [] },
  ].map((d) => JSON.stringify(d)).join("\n") + "\n");
  return { harvest, decisions, work: join(dir, "work") };
}

const answers = { red_team: { type: "noul", noul: 0.03 }, owasp_web: { type: "noul", noul: 0.5 }, owasp_llm: { type: "noul", noul: 0.5 } };

test("compose → call → score: rounds with no gated lens are dropped; reruns and changed questions are refused", async () => {
  const { harvest, decisions, work } = fixtureCorpus();
  const plan = compose({ harvest, decisions, work });
  assert.deepEqual(plan.cases.map((c) => c.caseId), ["r-1@a1"]);
  assert.deepEqual(plan.cases[0].labels, { red_team: LABELS.SKIPPED, owasp_web: null, owasp_llm: null });
  assert.deepEqual(Object.keys(plan.cases[0].state), ["prBody", "diffstat"]);
  assert.throws(() => compose({ harvest, decisions, work }), /Refusing to overwrite/);

  let sentTitle;
  const fetchImpl = async (_url, init) => {
    sentTitle = init.headers["X-Title"];
    return new Response(JSON.stringify({ model: "typesafe/jev-1.13-x", answers, usage: { cost: 0.0001 } }), { status: 200 });
  };
  await call(work, { key: "k", log: () => {}, fetchImpl });
  assert.equal(sentTitle, "eval-corpus-lens-gate");
  await assert.rejects(call(work, { key: "k", log: () => {}, fetchImpl }), /Refusing to repeat a paid run/);

  const summary = score(work);
  assert.equal(summary.failedCalls, 0);
  assert.equal(summary.usage.costUsd, 0.0001);
  assert.equal(summary.raw.red_team.jev.find((j) => j.threshold === 0.05).gatedOut, 1);
  assert.match(summary.adjudicated, /^none/);
  assert.ok(existsSync(join(work, "gate.jsonl")));

  const planPath = join(work, "plan.json");
  const tampered = JSON.parse(readFileSync(planPath, "utf8"));
  tampered.questions.red_team.instructions += " edited";
  writeFileSync(planPath, JSON.stringify(tampered));
  assert.throws(() => score(work), /Questions changed/);
});

test("score: a null result file or one without valid probabilities counts as a failed call, with usage unknown", async () => {
  const { harvest, decisions, work } = fixtureCorpus();
  compose({ harvest, decisions, work });
  writeFileSync(join(work, "r-1@a1.result.json"), JSON.stringify({ probabilities: {}, usage: null }));
  assert.equal(score(work).failedCalls, 1);
  writeFileSync(join(work, "r-1@a1.result.json"), "null");
  const summary = score(work);
  assert.equal(summary.failedCalls, 1);
  assert.equal(summary.usage.costUsd, null);
  assert.equal(summary.raw.red_team.jevCases, 0);
});
