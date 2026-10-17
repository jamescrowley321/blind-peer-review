import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, QUESTIONS, SLICES, buildState, decide, distributions, parseAnswers, questionSha256 } from "./screening.mjs";
import { screenCase } from "./jev.mjs";
import { call, compose, score } from "../screen.mjs";

const ALL = Object.fromEntries(Object.keys(QUESTIONS).map((q) => [q, { type: "noul", noul: 0.9 }]));
const ok = (answers = ALL, usage = { cost: 0.00001 }) => async () => new Response(JSON.stringify({ model: "typesafe/jev-1.13-x", answers, usage }), { status: 200 });

test("no screening question mentions tests being present or missing", () => {
  for (const [name, q] of Object.entries(QUESTIONS)) {
    assert.equal(q.type, "noul");
    assert.doesNotMatch(q.instructions, /\btests?\b|missing|present|absent/i, name);
  }
  assert.deepEqual(Object.keys(SLICES.requiredTest).length, 4);
});

test("answers must be noul probabilities in [0, 1]; anything else fails the call", () => {
  assert.equal(parseAnswers(ALL).has_explicit_acs, 0.9);
  for (const bad of [{ type: "choice", noul: 0.5 }, { type: "noul", noul: 1.2 }, { type: "noul", noul: "0.5" }, { type: "noul" }]) {
    assert.throws(() => parseAnswers({ ...ALL, acs_testable: bad }), /invalid answer for acs_testable/);
  }
  assert.throws(() => parseAnswers({}), /invalid answer/);
});

test("state is capped per field and truncation is reported", () => {
  const round = { body: "b".repeat(LIMITS.prBody + 5), outputs: [{ pipeline: "p", lens: "Cold Read", body: "r" }] };
  const decision = { diffstat: Array.from({ length: LIMITS.diffstatFiles + 2 }, (_, i) => ({ path: `f${i}`, added: 1, removed: 0 })) };
  const { state, truncated } = buildState(round, decision);
  assert.equal(truncated, true);
  assert.match(state.prBody, /\[truncated\]$/);
  assert.match(state.reviewText, /^--- p \/ Cold Read ---\nr$/);
  assert.match(state.diffstat, /\[2 more files\]$/);
  assert.equal(buildState({ body: "x", outputs: [] }, { diffstat: [] }).truncated, false);
});

test("decisions: no thresholds means human review; thresholds split accept / reject / human per slice", () => {
  const p = { has_explicit_acs: 0.1, acs_testable: 0.5, review_cites_code: 0.95, diff_mostly_substantive: 0.9 };
  assert.deepEqual(decide(p), { general: "human_review", requiredTest: "human_review" });
  assert.deepEqual(decide(null), { general: "failed", requiredTest: "failed" });
  const t = Object.fromEntries(Object.keys(QUESTIONS).map((q) => [q, { accept: 0.8, reject: 0.2 }]));
  assert.deepEqual(decide(p, t), { general: "accept", requiredTest: "reject" });
  assert.deepEqual(decide({ ...p, has_explicit_acs: 0.5 }, t), { general: "accept", requiredTest: "human_review" });
  assert.throws(() => decide(p, { review_cites_code: { accept: 0.8, reject: 0.2 } }), /incomplete/);
  assert.throws(() => decide(p, { ...t, acs_testable: { accept: 0.2, reject: 0.8 } }), /incomplete/);
});

test("distributions bin each question's probabilities and skip failed rows", () => {
  const d = distributions([{ probabilities: { has_explicit_acs: 1, acs_testable: 0, review_cites_code: 0.55, diff_mostly_substantive: 0.99 } }, { probabilities: null }]);
  assert.deepEqual([d.has_explicit_acs[9], d.acs_testable[0], d.review_cites_code[5], d.diff_mostly_substantive[9]], [1, 1, 1, 1]);
});

test("transport: retries 429 with retry-after and transport errors, records status-only failures", async () => {
  const waits = [];
  let n = 0;
  const flaky = async () => (++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "3" } }) : ok()());
  const r = await screenCase({}, QUESTIONS, { key: "k", fetchImpl: flaky, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual([r.attempts, r.error, waits], [2, undefined, [3000]]);
  const down = await screenCase({}, QUESTIONS, { key: "k", fetchImpl: async () => { throw new TypeError("fetch failed"); }, retries: 1, sleep: async () => {} });
  assert.deepEqual([down.attempts, down.error, down.usage], [2, "transport_failure", null]);
  const billing = await screenCase({}, QUESTIONS, { key: "k", fetchImpl: async () => new Response("private billing state", { status: 402 }) });
  assert.deepEqual([billing.status, billing.error], [402, "http_402"]);
  assert.equal(JSON.stringify(billing).includes("billing state"), false);
  const bad = await screenCase({}, QUESTIONS, { key: "k", fetchImpl: ok({ ...ALL, acs_testable: { type: "noul", noul: 2 } }) });
  assert.deepEqual([bad.error, bad.usage.cost], ["invalid answer for acs_testable", 0.00001]);
  await assert.rejects(screenCase({}, QUESTIONS, { key: "" }), /required/);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "corpus-screen-"));
  const harvest = join(dir, "harvest");
  mkdirSync(harvest);
  const round = (sha) => ({ headSha: sha, body: "## Acceptance criteria\n- AC-1", outputs: [{ pipeline: "bpr-local-per-lens", lens: "Cold Read", body: "src/a.js:3 is wrong" }] });
  writeFileSync(join(harvest, "repo-1.json"), JSON.stringify({ id: "repo-1", rounds: [round("a".repeat(40)), round("b".repeat(40))] }));
  const decisions = join(dir, "decisions.jsonl");
  const d = (sha, accepted) => JSON.stringify({ caseId: `repo-1@${sha.slice(0, 12)}`, snapshotId: "repo-1", headSha: sha, accepted, flags: [], notes: [], diffstat: [{ path: "src/a.js", added: 2, removed: 1 }] });
  writeFileSync(decisions, `${d("a".repeat(40), true)}\n${d("b".repeat(40), false)}\n`);
  return { harvest, decisions, work: join(dir, "work") };
}

test("compose → call → score end to end, with frozen questions and refusal to repeat a paid run", async () => {
  const f = fixture();
  const plan = compose(f);
  assert.deepEqual([plan.cases.length, plan.questionSha256], [1, questionSha256()]);
  assert.throws(() => compose(f), /Refusing to overwrite/);
  await assert.rejects(call(f.work, { key: "" }), /OPENROUTER_API_KEY/);
  await call(f.work, { key: "k", fetchImpl: ok(), log: () => {} });
  await assert.rejects(call(f.work, { key: "k", fetchImpl: ok(), log: () => {} }), /Refusing to repeat/);
  const s = score(f.work);
  assert.deepEqual([s.cases, s.failedCalls, s.decisions.general, s.usage.costUsd], [1, 0, { human_review: 1 }, 0.00001]);
  const row = JSON.parse(readFileSync(join(f.work, "screen.jsonl"), "utf8"));
  assert.equal(row.probabilities.review_cites_code, 0.9);
});

test("a fatal provider status abandons the run; missing results score as failures with unknown cost", async () => {
  const f = fixture();
  compose(f);
  await assert.rejects(call(f.work, { key: "k", fetchImpl: async () => new Response("", { status: 401 }), log: () => {} }), /Fatal provider response 401/);
  const f2 = fixture();
  compose(f2);
  const s = score(f2.work);
  assert.deepEqual([s.failedCalls, s.decisions.general, s.usage.costUsd, s.usage.missingUsageCalls], [1, { failed: 1 }, null, 1]);
});

test("a plan whose questions were edited after compose is refused", () => {
  const f = fixture();
  compose(f);
  const planPath = join(f.work, "plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.questions.has_explicit_acs.instructions += " (tuned)";
  writeFileSync(planPath, JSON.stringify(plan));
  assert.throws(() => score(f.work), /Questions changed/);
  assert.equal(existsSync(join(f.work, ".started")), false);
});
