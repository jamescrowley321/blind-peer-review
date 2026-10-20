import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABELS, QUESTIONS, STATE_VARIANTS, THRESHOLDS, baselineRuns, buildGateState, labelRound, lensCosts, lensSummary, offSurface, parseGateAnswers, questionSha256, scoreGate, timeSplit } from "./gate.mjs";
import { applyAdjudications, call, compose, score, worksheet } from "../gate.mjs";

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

test("labels: findings come from contract JSON, tagged entries or severity headings; NITPICK alone and tag mentions are not findings", () => {
  const one = (o) => labelRound({ outputs: [o] }).red_team;
  assert.equal(one(inline("Red Team", "MUST FIX", "[MUST FIX] token replay")), LABELS.WITH_FINDINGS);
  assert.equal(one({ ...lensReview("Red Team", "No [MUST FIX] or [SHOULD FIX] findings."), verdict: "BLOCK", severity: "MUST FIX" }), LABELS.NO_FINDINGS);
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
  assert.equal(scoreGate([row("a", LABELS.SKIPPED, 0.5, true), { ...row("b", LABELS.SKIPPED, 0.5, true), lensCosts: { red_team: 0.1 } }]).red_team.medianLensCostUsd, 0.08);
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
  assert.throws(() => applyAdjudications(rows, { fuond: { red_team: "real" } }), /unknown case fuond/);
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

test("off-surface: candidate rate among findings; precision and recall only against human adjudications", () => {
  const rows = [
    row("noise", LABELS.WITH_FINDINGS, 0.01, false),
    row("real-low", LABELS.WITH_FINDINGS, 0.08, false),
    row("unjudged", LABELS.WITH_FINDINGS, 0.03, false),
    row("noise-high", LABELS.WITH_FINDINGS, 0.4, true),
    row("skip", LABELS.SKIPPED, 0.01, false),
    row("failed", LABELS.WITH_FINDINGS, null, false),
  ];
  const at = (s, t) => s.thresholds.find((x) => x.threshold === t);
  const raw = offSurface(rows).red_team;
  assert.equal(raw.withFindings, 4);
  assert.equal(raw.offSurface, null);
  assert.deepEqual(at(raw, 0.1), { threshold: 0.1, candidates: 3, candidateRate: 0.75 });

  const judged = offSurface(rows, { noise: { red_team: "off_surface" }, "real-low": { red_team: "real" }, "noise-high": { red_team: "off_surface" } }).red_team;
  assert.equal(judged.adjudicated, 3);
  assert.equal(judged.offSurface, 2);
  assert.deepEqual(at(judged, 0.1), { threshold: 0.1, candidates: 3, candidateRate: 0.75, truePositives: 1, precision: 0.5, recall: 0.5 });
  assert.deepEqual(at(judged, 0.02), { threshold: 0.02, candidates: 1, candidateRate: 0.25, truePositives: 1, precision: 1, recall: 0.5 });
  assert.equal(offSurface(rows, {}).owasp_web.thresholds[0].precision, null);
});

test("worksheet: lists with_findings cases blind; --order p puts likely noise first without printing p", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-ws-"));
  const harvest = join(dir, "harvest");
  mkdirSync(harvest);
  const many = Array.from({ length: 5 }, (_, i) => `- [SHOULD FIX] finding ${i} in a1`).join("\n");
  const rounds = [
    { headSha: "a1", body: "Change", outputs: [lensReview("Red Team", "Five gaps.", many)] },
    { headSha: "c3", body: "Change", outputs: [lensReview("Red Team", "No [MUST FIX] findings.", "### SHOULD FIX\n- session not rotated")] },
    { headSha: "b2", body: "Change", outputs: [piJson("Viper", "One gap.", [{ severity: "MUST FIX", location: "auth.js:4", detail: "token replay" }, { severity: "NITPICK", detail: "style" }])] },
  ];
  writeFileSync(join(harvest, "r-1.json"), JSON.stringify({ title: "feat: thing", rounds }));
  const decisions = join(dir, "decisions.jsonl");
  writeFileSync(decisions, ["a1", "b2", "c3"].map((h) => JSON.stringify({ caseId: `r-1@${h}`, snapshotId: "r-1", headSha: h, accepted: true, flags: [], diffstat: [{ path: `${h}.js`, added: 1, removed: 0 }] })).join("\n") + "\n");
  const work = join(dir, "work");
  compose({ harvest, decisions, work });
  const result = (p) => JSON.stringify({ probabilities: { red_team: p, owasp_web: 0.5, owasp_llm: 0.5 }, usage: null });
  writeFileSync(join(work, "r-1@a1.result.json"), result(0.9));
  writeFileSync(join(work, "r-1@b2.result.json"), result(0.04));

  writeFileSync(join(work, "r-1@c3.result.json"), result(0.5));
  assert.deepEqual(worksheet({ harvest, decisions, work }), { items: 3 });
  const byCase = readFileSync(join(work, "adjudication-worksheet.md"), "utf8");
  assert.ok(byCase.indexOf("r-1@a1") < byCase.indexOf("r-1@b2"));
  assert.match(byCase, /- \[SHOULD FIX\] finding 4 in a1/);
  assert.match(byCase, /- \[MUST FIX\] `auth.js:4` — token replay/);
  assert.doesNotMatch(byCase, /style/);
  assert.match(byCase, /- session not rotated/);
  assert.doesNotMatch(byCase, /- \[MUST FIX\] findings/);
  assert.deepEqual(JSON.parse(readFileSync(join(work, "adjudications.template.json"), "utf8")), { "r-1@a1": { red_team: "" }, "r-1@c3": { red_team: "" }, "r-1@b2": { red_team: "" } });

  worksheet({ harvest, decisions, work, order: "p" });
  const byP = readFileSync(join(work, "adjudication-worksheet.md"), "utf8");
  assert.ok(byP.indexOf("r-1@b2") < byP.indexOf("r-1@a1"));
  assert.doesNotMatch(byP, /0\.04|0\.9/);
  assert.throws(() => worksheet({ harvest, decisions, work, order: "random" }), /--order/);
});

test("diffstat variant: state and questions carry no PR body; full stays the frozen default", () => {
  const round = { body: "BODY-SENTINEL-7f3a", outputs: [] };
  const { state } = buildGateState(round, { diffstat: [{ path: "prompt.md", added: 1, removed: 0 }] }, "diffstat");
  assert.deepEqual(state, { diffstat: "prompt.md +1 -0" });
  for (const q of Object.values(STATE_VARIANTS.diffstat)) assert.doesNotMatch(q.instructions, /prBody/);
  assert.equal(QUESTIONS, STATE_VARIANTS.full);
  assert.notEqual(questionSha256(STATE_VARIANTS.diffstat), questionSha256(QUESTIONS));
});

test("combined arm gates out only when the baseline and Jev both say no surface", () => {
  const rows = [
    row("both-no", LABELS.SKIPPED, 0.01, false),
    row("baseline-yes", LABELS.WITH_FINDINGS, 0.01, true),
    row("jev-yes", LABELS.NO_FINDINGS, 0.9, false),
  ];
  const at = scoreGate(rows).red_team.combined.find((c) => c.threshold === 0.1);
  assert.deepEqual(at, { threshold: 0.1, gatedOut: 1, missedFindings: 0, missedCaseIds: [], agreeSkip: 3, disagreeSkip: 0 });
});

test("time split: threshold chosen on earlier rows is frozen and reported on later rows", () => {
  const dated = (r, reviewedAt) => ({ ...r, reviewedAt });
  const rows = [
    dated(row("old-skip", LABELS.SKIPPED, 0.01, false), "2026-05-01T00:00:00Z"),
    dated(row("old-found", LABELS.WITH_FINDINGS, 0.25, true), "2026-05-02T00:00:00Z"),
    dated(row("new-skip", LABELS.SKIPPED, 0.1, false), "2026-09-01T00:00:00Z"),
    dated(row("new-found", LABELS.WITH_FINDINGS, 0.15, false), "2026-09-02T00:00:00Z"),
  ];
  const s = timeSplit(rows, "2026-08-01T00:00:00Z").red_team;
  assert.equal(s.trainCases, 2);
  assert.equal(s.testCases, 2);
  assert.equal(s.jev.threshold, 0.2);
  assert.deepEqual(s.jev.test, { gatedOut: 2, missedFindings: 1, missedCaseIds: ["new-found"], agreeSkip: 1, disagreeSkip: 1 });
  assert.equal(s.combined.threshold, 0.5);
  assert.equal(s.combined.test.missedFindings, 1);
  assert.equal(timeSplit([dated(row("f", LABELS.WITH_FINDINGS, 0.01, false), "2026-05-01T00:00:00Z")], "2026-08-01T00:00:00Z").red_team.jev.threshold, null);
  const noTrain = timeSplit([dated(row("late", LABELS.SKIPPED, 0.01, false), "2026-09-01T00:00:00Z")], "2026-08-01T00:00:00Z").red_team;
  assert.deepEqual([noTrain.trainCases, noTrain.jev.threshold, noTrain.combined.threshold], [0, null, null]);
  const offset = timeSplit([dated(row("utc-late", LABELS.SKIPPED, 0.01, false), "2026-07-31T23:30:00Z")], "2026-08-01T01:00:00+02:00").red_team;
  assert.equal(offset.testCases, 1);
  assert.throws(() => timeSplit(rows, "not a date"), /splitAt/);
  assert.throws(() => timeSplit([row("undated", LABELS.SKIPPED, 0.1, false)], "2026-08-01T00:00:00Z"), /reviewedAt/);
});

test("compose --state diffstat: plan records the variant, sends no PR body, and readPlan checks its own questions", async () => {
  const { harvest, decisions, work } = fixtureCorpus();
  const plan = compose({ harvest, decisions, work, stateVariant: "diffstat" });
  assert.equal(plan.stateVariant, "diffstat");
  assert.deepEqual(Object.keys(plan.cases[0].state), ["diffstat"]);
  assert.equal(typeof plan.cases[0].reviewedAt, "object");
  const fetchImpl = async () => new Response(JSON.stringify({ model: "typesafe/jev-1.13-x", answers, usage: { cost: 0.0001 } }), { status: 200 });
  await call(work, { key: "k", log: () => {}, fetchImpl });
  assert.equal(score(work).stateVariant, "diffstat");
  assert.throws(() => compose({ harvest, decisions, work: join(work, "x"), stateVariant: "body" }), /state variant/);
});
