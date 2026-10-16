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
  outputsTruncated: "outputs_truncated",
  commitsTruncated: "commits_truncated",
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

/** Flatten issue comments, reviews and inline review comments into one list. */
export function reviewOutputs(pr) {
  const out = [];
  for (const c of pr.comments.nodes) {
    out.push({ kind: "comment", id: c.databaseId, author: c.author?.login ?? null, createdAt: c.createdAt, body: c.body, commitOid: null });
  }
  for (const r of pr.reviews.nodes) {
    if (r.body?.trim()) {
      out.push({ kind: "review", id: r.databaseId, author: r.author?.login ?? null, createdAt: r.submittedAt, body: r.body, commitOid: r.commit?.oid ?? null });
    }
    for (const c of r.comments.nodes) {
      out.push({ kind: "inline", id: c.databaseId, author: r.author?.login ?? null, createdAt: c.createdAt, body: c.body, commitOid: r.commit?.oid ?? null, path: c.path, line: c.line });
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The head a review ran against. Recorded SHAs (review commit, or one the
 * format detector extracted) win; otherwise the newest PR commit committed
 * before the review is inferred and flagged.
 */
export function reviewedHead(output, detection, commits) {
  const recorded = output.commitOid ?? detection.headSha ?? null;
  if (recorded) {
    const full = commits.find((c) => c.oid.startsWith(recorded))?.oid ?? recorded;
    return { sha: full, inferred: false };
  }
  const before = commits.filter((c) => c.committedDate <= output.createdAt);
  return { sha: before.at(-1)?.oid ?? null, inferred: true };
}

/**
 * Build the snapshot. `classify(output)` returns null for non-review text or
 * { pipeline, headSha?, verdict? }; unknown review-shaped text should come back
 * as pipeline "unclassified" so it is visible, not dropped.
 */
export function buildSnapshot(pr, { classify }) {
  const commits = pr.commits.nodes
    .map((n) => ({ oid: n.commit.oid, committedDate: n.commit.committedDate, parent: n.commit.parents.nodes[0]?.oid ?? null }))
    .sort((a, b) => a.committedDate.localeCompare(b.committedDate));
  const flags = new Set();
  if (pr.commits.totalCount > pr.commits.nodes.length) flags.add(FLAGS.commitsTruncated);
  if (pr.comments.totalCount > pr.comments.nodes.length || pr.reviews.totalCount > pr.reviews.nodes.length
    || pr.reviews.nodes.some((r) => r.comments.totalCount > r.comments.nodes.length)) {
    flags.add(FLAGS.outputsTruncated);
  }

  const known = new Set(commits.map((c) => c.oid));
  const rounds = new Map();
  for (const output of reviewOutputs(pr)) {
    const detection = classify(output);
    if (!detection) continue;
    const head = reviewedHead(output, detection, commits);
    const key = head.sha ?? "unknown";
    if (!rounds.has(key)) {
      rounds.set(key, { headSha: head.sha, flags: new Set(), outputs: [] });
    }
    const round = rounds.get(key);
    if (head.inferred) round.flags.add(FLAGS.shaInferred);
    if (!head.sha || !known.has(head.sha)) round.flags.add(FLAGS.diffApproximate);
    const at = bodyAt(pr, output.createdAt);
    if (at.approximate) round.flags.add(FLAGS.bodyApproximate);
    round.body ??= at.body;
    round.reviewedAt = output.createdAt;
    round.outputs.push({ ...output, pipeline: detection.pipeline, verdict: detection.verdict ?? null, lens: detection.lens ?? null });
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
    rounds: [...rounds.values()].map((r) => ({ ...r, flags: [...new Set([...r.flags, ...flags])] })),
  };
}
