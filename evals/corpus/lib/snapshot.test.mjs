import test from "node:test";
import assert from "node:assert/strict";
import { bodyAt, buildSnapshot, reviewedHead, FLAGS } from "./snapshot.mjs";

const commit = (oid, committedDate, parent = null) => ({ commit: { oid, committedDate, parents: { nodes: parent ? [{ oid: parent }] : [] } } });
const conn = (nodes, totalCount = nodes.length) => ({ totalCount, nodes });

function pr(overrides = {}) {
  return {
    number: 7, title: "feat: x", body: "current body", createdAt: "2026-10-01T00:00:00Z",
    mergedAt: null, closedAt: null, state: "OPEN", baseRefName: "main", headRefName: "feat/x",
    author: { login: "dev" }, mergeCommit: null,
    userContentEdits: conn([]),
    comments: conn([]),
    reviews: conn([]),
    commits: conn([commit("aaa111", "2026-10-01T01:00:00Z", "base000"), commit("bbb222", "2026-10-02T01:00:00Z", "aaa111")]),
    ...overrides,
  };
}
const review = (body) => (o) => (o.body.startsWith(body) ? { pipeline: "bpr-local", role: "review" } : null);

test("body at review time comes from the newest edit at or before the review", () => {
  const edits = conn([{ editedAt: "2026-10-03T00:00:00Z", diff: "v2" }, { editedAt: "2026-10-01T00:00:00Z", diff: "v1" }]);
  const p = pr({ userContentEdits: edits, body: "v2" });
  assert.deepEqual(bodyAt(p, "2026-10-02T00:00:00Z"), { body: "v1", approximate: false });
  assert.deepEqual(bodyAt(p, "2026-10-04T00:00:00Z"), { body: "v2", approximate: false });
  assert.deepEqual(bodyAt(pr(), "2026-10-02T00:00:00Z"), { body: "current body", approximate: false });
});

test("an incomplete or unusable edit history falls back to the current body, flagged", () => {
  const capped = pr({ userContentEdits: conn([{ editedAt: "2026-10-01T00:00:00Z", diff: "v1" }], 150) });
  assert.deepEqual(bodyAt(capped, "2026-10-02T00:00:00Z"), { body: "current body", approximate: true });
  const later = pr({ userContentEdits: conn([{ editedAt: "2026-10-05T00:00:00Z", diff: "v9" }]) });
  assert.deepEqual(bodyAt(later, "2026-10-02T00:00:00Z"), { body: "current body", approximate: true });
});

test("a recorded SHA wins and is expanded; otherwise the newest earlier commit is inferred", () => {
  const commits = [{ oid: "aaa111", committedDate: "2026-10-01T01:00:00Z" }, { oid: "bbb222", committedDate: "2026-10-02T01:00:00Z" }];
  assert.deepEqual(reviewedHead({ commitOid: null, createdAt: "x" }, { headSha: "bbb" }, commits), { sha: "bbb222", inferred: false });
  assert.deepEqual(reviewedHead({ commitOid: null, createdAt: "2026-10-01T12:00:00Z" }, {}, commits), { sha: "aaa111", inferred: true });
  assert.deepEqual(reviewedHead({ commitOid: null, createdAt: "2026-09-01T00:00:00Z" }, {}, commits), { sha: null, inferred: true });
});

test("reviews group into rounds per head; a force-pushed-away head is diff_approximate", () => {
  const p = pr({
    comments: conn([
      { databaseId: 1, author: { login: "dev" }, body: "## Blind peer review — first", createdAt: "2026-10-01T12:00:00Z" },
      { databaseId: 2, author: { login: "dev" }, body: "thanks, fixed", createdAt: "2026-10-01T13:00:00Z" },
    ]),
    reviews: conn([{ databaseId: 3, author: { login: "bot" }, body: "## Blind peer review — gone", state: "COMMENTED", submittedAt: "2026-10-02T12:00:00Z", commit: { oid: "dead999" }, comments: conn([]) }]),
  });
  const snap = buildSnapshot(p, { classify: review("## Blind peer review") });
  assert.equal(snap.baseSha, "base000");
  const byHead = Object.fromEntries(snap.rounds.map((r) => [r.headSha, r]));
  assert.deepEqual(Object.keys(byHead).sort(), ["aaa111", "dead999"]);
  assert.deepEqual(byHead.aaa111.flags, [FLAGS.shaInferred, FLAGS.diffApproximate]);
  assert.deepEqual(byHead.aaa111.outputs.map((o) => o.id), [1]);
  assert.deepEqual(byHead.dead999.flags, [FLAGS.diffApproximate]);
  assert.equal(byHead.dead999.body, "current body");
});

test("capped comment or commit pages flag every round", () => {
  const p = pr({
    comments: conn([{ databaseId: 1, author: null, body: "## Blind peer review — x", createdAt: "2026-10-02T12:00:00Z" }], 140),
    commits: conn([commit("aaa111", "2026-10-01T01:00:00Z", "base000")], 300),
  });
  const snap = buildSnapshot(p, { classify: review("## Blind peer review") });
  assert.deepEqual(snap.flags.sort(), [FLAGS.commitsTruncated, FLAGS.outputsTruncated].sort());
  assert.deepEqual(snap.rounds[0].flags.sort(), [FLAGS.shaInferred, FLAGS.diffApproximate, FLAGS.commitsTruncated, FLAGS.outputsTruncated].sort());
});

test("pending reviews are skipped instead of crashing the sort", () => {
  const p = pr({ reviews: conn([{ databaseId: 9, author: { login: "me" }, body: "## Blind peer review — draft", state: "PENDING", submittedAt: null, commit: { oid: "aaa111" }, comments: conn([]) }]) });
  assert.deepEqual(buildSnapshot(p, { classify: review("## Blind peer review") }).rounds, []);
});

test("a review before a base retarget is flagged base_changed and diff_approximate", () => {
  const p = pr({
    timelineItems: { nodes: [{ createdAt: "2026-10-05T00:00:00Z" }] },
    reviews: conn([
      { databaseId: 1, author: { login: "bot" }, body: "## Blind peer review — a", state: "COMMENTED", submittedAt: "2026-10-02T12:00:00Z", commit: { oid: "bbb222" }, comments: conn([]) },
      { databaseId: 2, author: { login: "bot" }, body: "## Blind peer review — b", state: "COMMENTED", submittedAt: "2026-10-06T12:00:00Z", commit: { oid: "aaa111" }, comments: conn([]) },
    ]),
  });
  const byHead = Object.fromEntries(buildSnapshot(p, { classify: review("## Blind peer review") }).rounds.map((r) => [r.headSha, r.flags]));
  assert.deepEqual(byHead.bbb222.sort(), [FLAGS.baseChanged, FLAGS.diffApproximate].sort());
  assert.deepEqual(byHead.aaa111, []);
});

test("telemetry outputs are counted, not made into rounds; inline comments inherit lens and verdict", () => {
  const classify = (o) => (o.body === "status" ? { pipeline: "pi-agent-session-comment", role: "telemetry" }
    : o.kind === "review" ? { pipeline: "bpr-action-lens-review", role: "review", lens: "Red Team", verdict: "BLOCK" }
    : o.kind === "inline" ? { pipeline: "bpr-action-inline", role: "review", lens: null, verdict: null } : null);
  const p = pr({
    comments: conn([{ databaseId: 1, author: { login: "github-actions" }, body: "status", createdAt: "2026-10-02T00:00:00Z" }]),
    reviews: conn([{ databaseId: 2, author: { login: "github-actions" }, body: "## Red Team", state: "CHANGES_REQUESTED", submittedAt: "2026-10-02T12:00:00Z", commit: { oid: "bbb222" },
      comments: conn([{ databaseId: 3, path: "a.js", line: 1, body: "[MUST FIX] x", createdAt: "2026-10-02T12:00:00Z" }]) }]),
  });
  const snap = buildSnapshot(p, { classify });
  assert.deepEqual(snap.nonReviewOutputs, { "pi-agent-session-comment": 1 });
  assert.deepEqual(snap.rounds[0].outputs.map((o) => [o.kind, o.lens, o.verdict]), [["review", "Red Team", "BLOCK"], ["inline", "Red Team", "BLOCK"]]);
});
