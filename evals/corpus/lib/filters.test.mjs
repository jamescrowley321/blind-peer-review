import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffstat, filterSnapshot, isPolicyOnlyBlock, NOTE, REJECT, summarize } from "./filters.mjs";
import { filterDirectory } from "../filter.mjs";

const DIFF = "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n";
const lensOut = (extra = {}) => ({ pipeline: "bpr-action-lens-review", lens: "Cold Read", verdict: "PASS", severity: null, findings: null, body: "## Cold Read", ...extra });
const round = (extra = {}) => ({ headSha: "a".repeat(40), reviewedAt: "2026-10-02T00:00:00Z", flags: [], body: "## Acceptance criteria\n- AC-1: x", diff: DIFF, diffError: null, outputs: [lensOut()], ...extra });
const snap = (rounds) => ({ id: "repo-1", rounds });
const decide = (r) => filterSnapshot(snap([r]))[0];

test("a clean latest round is accepted with its diffstat and no notes", () => {
  const d = decide(round());
  assert.deepEqual([d.accepted, d.reasons, d.notes, d.caseId], [true, [], [], `repo-1@${"a".repeat(12)}`]);
  assert.deepEqual(d.diffstat, [{ path: "src/a.js", added: 2, removed: 1 }]);
});

test("each hard reason rejects, and all applicable reasons are recorded together", () => {
  assert.deepEqual(decide(round({ diff: null, diffError: "unreachable" })).reasons, [REJECT.noDiff]);
  assert.deepEqual(decide(round({ diff: null, diffError: "too_large" })).reasons, [REJECT.diffTooLarge]);
  assert.deepEqual(decide(round({ outputs: [lensOut({ pipeline: "unclassified", lens: null, verdict: null })] })).reasons, [REJECT.unclassifiedPipeline]);
  assert.deepEqual(decide(round({ outputs: [lensOut({ pipeline: "claude-action-job", lens: null, verdict: null })] })).reasons, [REJECT.unparseableReview]);
  const lock = "diff --git a/uv.lock b/uv.lock\n+x\ndiff --git a/web/package-lock.json b/web/package-lock.json\n+y\n";
  assert.deepEqual(decide(round({ diff: lock })).reasons, [REJECT.generatedOnly]);
  assert.deepEqual(decide(round({ diff: null, outputs: [lensOut({ pipeline: "unclassified", lens: null, verdict: null })] })).reasons, [REJECT.noDiff, REJECT.unclassifiedPipeline]);
});

test("only the most recent round of a PR survives; earlier ones are superseded", () => {
  const [early, late] = filterSnapshot(snap([round({ headSha: "b".repeat(40), reviewedAt: "2026-10-01T00:00:00Z" }), round()]));
  assert.deepEqual([early.reasons, late.reasons], [[REJECT.supersededRound], []]);
});

test("a missing acceptance-criteria section is a note, not a rejection", () => {
  const d = decide(round({ body: "Refactor the parser." }));
  assert.deepEqual([d.accepted, d.notes], [true, [NOTE.noAcceptanceCriteria]]);
  for (const body of ["- [ ] AC-1 works", "**AC1**: x", "### ACs\n- x", "## Definition of done"]) assert.deepEqual(decide(round({ body })).notes, [], body);
});

test("a BLOCK whose only complaint is the accountability box is policy_only_block", () => {
  const box = lensOut({ lens: "Policy & Provenance", verdict: "BLOCK", body: "## Policy & Provenance\n- [MUST FIX] `PR body` — The human accountability box is unchecked." });
  const real = lensOut({ lens: "Red Team", verdict: "BLOCK", body: "## Red Team\n- [MUST FIX] `a.js:1` — token accepted without signature" });
  const jsonBox = lensOut({ pipeline: "pi-lens-json-comment", lens: "Compliance Auditor", verdict: "BLOCK", findings: [{ severity: "MUST FIX", detail: "No human has reviewed this change", recommendation: "Tick the box" }] });
  assert.equal(isPolicyOnlyBlock([box, lensOut()]), true);
  assert.equal(isPolicyOnlyBlock([jsonBox]), true);
  assert.equal(isPolicyOnlyBlock([box, real]), false);
  assert.equal(isPolicyOnlyBlock([lensOut({ lens: "Policy & Provenance", verdict: "BLOCK", body: "- [MUST FIX] committed secret in .env" })]), false);
  assert.equal(isPolicyOnlyBlock([lensOut()]), false);
  assert.deepEqual(decide(round({ outputs: [box] })).reasons, [REJECT.policyOnlyBlock]);
});

test("diffstat counts per file and ignores headers", () => {
  assert.deepEqual(diffstat(DIFF + "diff --git a/b.py b/b.py\n--- /dev/null\n+++ b/b.py\n+a\n"), [
    { path: "src/a.js", added: 2, removed: 1 },
    { path: "b.py", added: 1, removed: 0 },
  ]);
});

test("summary counts reasons, notes and the flags carried by accepted cases", () => {
  const decisions = filterSnapshot(snap([round({ reviewedAt: "2026-10-01T00:00:00Z" }), round({ headSha: "c".repeat(40), body: "x", flags: ["sha_inferred"] })]));
  assert.deepEqual(summarize(decisions), { rounds: 2, accepted: 1, rejectedBy: { [REJECT.supersededRound]: 1 }, notes: { [NOTE.noAcceptanceCriteria]: 1 }, acceptedFlags: { sha_inferred: 1 } });
});

test("the CLI stage skips harvest metadata files and refuses to overwrite its output", () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-filter-"));
  const inDir = join(dir, "in");
  mkdirSync(inDir);
  writeFileSync(join(inDir, "repo-1.json"), JSON.stringify(snap([round()])));
  writeFileSync(join(inDir, "harvest-summary.json"), JSON.stringify({ source: "x" }));
  writeFileSync(join(inDir, "id-map.json"), JSON.stringify({}));
  const out = join(dir, "out");
  assert.deepEqual(filterDirectory(inDir, out), { snapshots: 1, rounds: 1, accepted: 1, rejectedBy: {}, notes: {}, acceptedFlags: {} });
  assert.equal(readFileSync(join(out, "decisions.jsonl"), "utf8").trim().split("\n").length, 1);
  assert.throws(() => filterDirectory(inDir, out), /Refusing to overwrite/);
});
