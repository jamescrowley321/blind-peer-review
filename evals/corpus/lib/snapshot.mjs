// Pure construction of a corpus snapshot from one GraphQL PR node.
//
// The snapshot records what the reviewer could see at review time, not what
// the PR looks like now. Every place that recovery can be inexact is flagged
// rather than silently filled with current data: a flag travels with the case
// through every later stage and keeps it out of held-out claims.

export const FLAGS = Object.freeze({
  bodyApproximate: "body_approximate",
  shaInferred: "sha_inferred",
  diffApproximate: "diff_approximate",
  baseChanged: "base_changed",
  outputsTruncated: "outputs_truncated",
  commitsTruncated: "commits_truncated",
  redactedDiff: "redacted_diff",
});

/**
 * PR body as it read at `at`. `userContentEdits.diff` holds the full body after
 * each edit, newest first, and the oldest entry is the original body. No edits
 * means the body was never changed.
 */
export function bodyAt(pr, at) {
  const edits = pr.userContentEdits;
  if (!edits.totalCount) return { body: pr.body, approximate: false };
  if (edits.totalCount > edits.nodes.length) return { body: pr.body, approximate: true };
  const prior = edits.nodes.filter((e) => e.editedAt <= at).sort((a, b) => b.editedAt.localeCompare(a.editedAt));
  if (!prior.length || typeof prior[0].diff !== "string") return { body: pr.body, approximate: true };
  return { body: prior[0].diff, approximate: false };
}

/**
 * Flatten issue comments, submitted reviews and inline review comments into one
 * list. Pending (unsubmitted) reviews have no time and were never visible.
 */
export function reviewOutputs(pr) {
  const out = [];
  for (const c of pr.comments.nodes) {
    out.push({ kind: "comment", id: c.databaseId, author: c.author?.login ?? null, createdAt: c.createdAt, body: c.body, commitOid: null });
  }
  for (const r of pr.reviews.nodes) {
    if (r.state === "PENDING" || !r.submittedAt) continue;
    const author = r.author?.login ?? null;
    const commitOid = r.commit?.oid ?? null;
    if (r.body?.trim()) {
      out.push({ kind: "review", id: r.databaseId, author, createdAt: r.submittedAt, body: r.body, commitOid, state: r.state });
    }
    for (const c of r.comments.nodes) {
      out.push({ kind: "inline", id: c.databaseId, reviewId: r.databaseId, author, createdAt: c.createdAt ?? r.submittedAt, body: c.body, commitOid, path: c.path, line: c.line });
    }
  }
  return out.filter((o) => o.createdAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The head a review ran against. A commit GitHub attached to the review, or the
 * head_sha of the Actions run that posted it, is recorded. A SHA read from a
 * pipeline's own head marker is recorded too. Anything else is inferred from
 * commit dates — which are author-local, not push times — and flagged.
 */
export function reviewedHead(output, detection, commits, runHeads = {}) {
  const recorded = output.commitOid ?? (detection.runUrl && runHeads[detection.runUrl]) ?? detection.headSha ?? null;
  if (recorded) {
    const full = commits.find((c) => c.oid.startsWith(recorded))?.oid ?? recorded;
    return { sha: full, inferred: false };
  }
  const before = commits.filter((c) => c.committedDate <= output.createdAt);
  return { sha: before.at(-1)?.oid ?? null, inferred: true };
}

/**
 * Build the snapshot. `classify(output)` returns null for non-review text or a
 * detection (see review-formats.mjs). Only role "review" outputs form rounds;
 * telemetry and static-analysis outputs are counted, not treated as reviews.
 * Inline comments inherit lens and verdict from their parent review.
 */
export function buildSnapshot(pr, { classify, runHeads = {} }) {
  const commits = pr.commits.nodes
    .map((n) => ({ oid: n.commit.oid, committedDate: n.commit.committedDate, parent: n.commit.parents.nodes[0]?.oid ?? null }))
    .sort((a, b) => a.committedDate.localeCompare(b.committedDate));
  const flags = new Set();
  if (pr.commits.totalCount > pr.commits.nodes.length) flags.add(FLAGS.commitsTruncated);
  if (pr.comments.totalCount > pr.comments.nodes.length || pr.reviews.totalCount > pr.reviews.nodes.length
    || pr.reviews.nodes.some((r) => r.comments.totalCount > r.comments.nodes.length)) {
    flags.add(FLAGS.outputsTruncated);
  }
  // A base retarget or base force-push after a review means today's base is not
  // the one the reviewer diffed against (stacked PRs are retargeted routinely).
  const lastBaseChange = (pr.timelineItems?.nodes ?? []).map((e) => e.createdAt).filter(Boolean).sort().at(-1) ?? null;

  const known = new Set(commits.map((c) => c.oid));
  const rounds = new Map();
  const parents = new Map();
  const otherRoles = {};
  for (const output of reviewOutputs(pr)) {
    let detection = classify(output);
    if (!detection) continue;
    if (detection.role !== "review") {
      otherRoles[detection.pipeline] = (otherRoles[detection.pipeline] ?? 0) + 1;
      continue;
    }
    if (output.kind === "review") parents.set(output.id, detection);
    if (output.kind === "inline" && parents.has(output.reviewId)) {
      const parent = parents.get(output.reviewId);
      detection = { ...detection, lens: detection.lens ?? parent.lens, verdict: detection.verdict ?? parent.verdict };
    }
    const head = reviewedHead(output, detection, commits, runHeads);
    const key = head.sha ?? "unknown";
    if (!rounds.has(key)) rounds.set(key, { headSha: head.sha, flags: new Set(), outputs: [] });
    const round = rounds.get(key);
    if (head.inferred) round.flags.add(FLAGS.shaInferred).add(FLAGS.diffApproximate);
    if (!head.sha || !known.has(head.sha)) round.flags.add(FLAGS.diffApproximate);
    if (lastBaseChange && output.createdAt < lastBaseChange) round.flags.add(FLAGS.baseChanged).add(FLAGS.diffApproximate);
    const at = bodyAt(pr, output.createdAt);
    if (at.approximate) round.flags.add(FLAGS.bodyApproximate);
    round.body ??= at.body;
    round.reviewedAt = output.createdAt;
    round.outputs.push({
      ...output,
      pipeline: detection.pipeline,
      lens: detection.lens ?? null,
      verdict: detection.verdict ?? null,
      severity: detection.severity ?? null,
      findings: detection.findings ?? null,
      lensVerdicts: detection.lensVerdicts?.length ? detection.lensVerdicts : null,
      runUrl: detection.runUrl ?? null,
    });
  }

  return {
    number: pr.number,
    title: pr.title,
    author: pr.author?.login ?? null,
    createdAt: pr.createdAt,
    state: pr.state,
    mergedAt: pr.mergedAt,
    mergeSha: pr.mergeCommit?.oid ?? null,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    baseSha: commits[0]?.parent ?? null,
    currentBody: pr.body,
    commits: commits.map((c) => c.oid),
    flags: [...flags],
    nonReviewOutputs: otherRoles,
    rounds: [...rounds.values()].map((r) => ({ ...r, flags: [...new Set([...r.flags, ...flags])] })),
  };
}

/** Run URLs whose head_sha must be fetched to pin comment-delivered reviews. */
export function runUrlsToResolve(pr, { classify }) {
  const urls = new Set();
  for (const output of reviewOutputs(pr)) {
    if (output.commitOid) continue;
    const d = classify(output);
    if (d?.role === "review" && d.runUrl && !d.headSha) urls.add(d.runUrl);
  }
  return [...urls];
}
