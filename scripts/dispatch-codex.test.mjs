// dispatch-codex.test.mjs — the pure logic of out-of-host lens dispatch.
// Run: node --test scripts/dispatch-codex.test.mjs
//
// The process-spawning half is exercised for real against a live `codex`; what
// is unit-tested here is everything a wrong answer would silently corrupt: which
// lenses run, which persona file each one gets, and whether the verdict fails
// closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chooseLenses, personaPath, adjudicate } from "./dispatch-codex.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("../lenses/manifest.json", import.meta.url), "utf8"),
);

// ── which lenses run ──

test("with no --lens, runs exactly the manifest's default set", () => {
  // Read from the shipped manifest, not restated: a lens flipped to
  // default_enabled must change this without anyone editing the test.
  const expected = manifest.lenses.filter((l) => l.default_enabled).map((l) => l.key);
  assert.deepEqual(chooseLenses(manifest, null), expected);
  assert.ok(expected.length >= 5, "the default set collapsed");
});

test("opt-in lenses are not run by default", () => {
  const defaults = chooseLenses(manifest, null);
  for (const l of manifest.lenses.filter((x) => !x.default_enabled)) {
    assert.ok(!defaults.includes(l.key), `${l.key} is opt-in but ran by default`);
  }
});

test("--lens selects exactly what was asked for, in order", () => {
  assert.deepEqual(chooseLenses(manifest, "security,cold_read"), ["security", "cold_read"]);
});

test("--lens tolerates whitespace and empty entries", () => {
  assert.deepEqual(chooseLenses(manifest, " security , , cold_read "), ["security", "cold_read"]);
});

test("an unknown lens is refused by name, not silently skipped", () => {
  // Silently dropping it would run a smaller review than the caller asked for
  // and still report PASS.
  assert.throws(() => chooseLenses(manifest, "security,nope"), /unknown lens\(es\): nope/);
});

test("a --lens value that selects nothing is an error", () => {
  assert.throws(() => chooseLenses(manifest, " , "), /no lenses selected/);
});

// ── which persona each lens gets ──

test("a repo-local override wins over the base persona", () => {
  const p = personaPath("/repo", "/vendor/lenses", "security", (f) => f === "/repo/.blind-peer-review/lenses/security.md");
  assert.equal(p, "/repo/.blind-peer-review/lenses/security.md");
});

test("without an override, the base persona is used", () => {
  const p = personaPath("/repo", "/vendor/lenses", "security", () => false);
  assert.equal(p, "/vendor/lenses/security.md");
});

test("an override for a DIFFERENT lens does not capture this one", () => {
  const p = personaPath("/repo", "/vendor/lenses", "security", (f) => f === "/repo/.blind-peer-review/lenses/red_team.md");
  assert.equal(p, "/vendor/lenses/security.md");
});

// ── the verdict fails closed ──

const ok = (key, findings) => ({ key, ok: true, result: { lens: key, summary: "", findings } });
const must = { severity: "MUST FIX", location: "a.ts:1", detail: "d", recommendation: "r" };
const should = { severity: "SHOULD FIX", location: "a.ts:2", detail: "d", recommendation: "r" };

test("no findings anywhere is a PASS", () => {
  const { blocked, rows } = adjudicate([ok("a", []), ok("b", [])]);
  assert.equal(blocked, false);
  assert.deepEqual(rows.map((r) => r.verdict), ["PASS", "PASS"]);
});

test("one MUST FIX blocks the whole run", () => {
  const { blocked, rows } = adjudicate([ok("a", []), ok("b", [must])]);
  assert.equal(blocked, true);
  assert.deepEqual(rows.map((r) => r.verdict), ["PASS", "BLOCK"]);
});

test("SHOULD FIX and NITPICK do not block", () => {
  const { blocked } = adjudicate([ok("a", [should])]);
  assert.equal(blocked, false);
});

test("a lens that could not be read FAILS, and failing blocks", () => {
  // A review nobody could read has not passed.
  const { blocked, rows } = adjudicate([{ key: "a", ok: false, why: "not JSON" }]);
  assert.equal(blocked, true);
  assert.equal(rows[0].verdict, "FAILED");
  assert.match(rows[0].note, /not JSON/);
});

test('a lens whose summary merely says "no MUST FIX findings" still passes', () => {
  // The verdict reads the parsed severity field. Substring-matching the prose
  // would turn this clean review into a block.
  const r = ok("a", []);
  r.result.summary = "No MUST FIX findings in this diff.";
  assert.equal(adjudicate([r]).blocked, false);
});

test("a finding whose DETAIL quotes the words MUST FIX does not block on its own", () => {
  const r = ok("a", [{ ...should, detail: 'The diff text literally says "MUST FIX" here.' }]);
  assert.equal(adjudicate([r]).blocked, false);
});

test("MUST FIX findings are surfaced, not just counted", () => {
  const { rows } = adjudicate([ok("a", [must, should])]);
  assert.deepEqual(rows[0].mustFix, [must]);
});

test("a missing findings array is treated as empty rather than crashing", () => {
  const { blocked, rows } = adjudicate([{ key: "a", ok: true, result: { lens: "a", summary: "" } }]);
  assert.equal(blocked, false);
  assert.match(rows[0].note, /^0 finding/);
});

// ── the schema the dispatch enforces ──

test("the contract schema requires the fields the adjudicator reads", () => {
  const schema = JSON.parse(readFileSync(new URL("../contracts/review.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.required.sort(), ["findings", "lens", "summary"]);
  const f = schema.properties.findings.items;
  assert.deepEqual(f.required.sort(), ["detail", "location", "recommendation", "severity"]);
  assert.deepEqual(f.properties.severity.enum, ["MUST FIX", "SHOULD FIX", "NITPICK"]);
  // additionalProperties:false is what stops a lens smuggling prose alongside
  // the object and calling it a review.
  assert.equal(schema.additionalProperties, false);
  assert.equal(f.additionalProperties, false);
});
