// Read-only GitHub access for the corpus harvester, through the `gh` CLI so the
// caller's existing auth is reused and no token is handled here. Every call
// goes through one injectable runner so tests never touch the network.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function ghRunner(args) {
  const { stdout } = await exec("gh", args, { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

// Comments/reviews are capped per PR; `truncated` flags record when a cap was
// hit so a case with missing review outputs is never mistaken for a clean one.
const PR_FIELDS = `
  number title body createdAt mergedAt closedAt state
  baseRefName headRefName
  author { login }
  mergeCommit { oid }
  userContentEdits(first: 100) { totalCount nodes { editedAt diff } }
  comments(first: 100) { totalCount nodes { databaseId author { login } body createdAt } }
  reviews(first: 100) {
    totalCount
    nodes {
      databaseId author { login } body state submittedAt commit { oid }
      comments(first: 100) { totalCount nodes { databaseId path line body createdAt } }
    }
  }
  commits(first: 100) { totalCount nodes { commit { oid committedDate parents(first: 1) { nodes { oid } } } } }
`;

const QUERY = `query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 20, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} }
    }
  }
}`;

/** Yields PR nodes newest first, stopping at PRs created before `since`. */
export async function* pullRequests(owner, repo, { since = null, run = ghRunner } = {}) {
  let after = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `repo=${repo}`];
    if (after) args.push("-F", `after=${after}`);
    const page = JSON.parse(await run(args)).data.repository.pullRequests;
    for (const pr of page.nodes) {
      if (since && pr.createdAt < since) return;
      yield pr;
    }
    if (!page.pageInfo.hasNextPage) return;
    after = page.pageInfo.endCursor;
  }
}

/** Repository names for an owner (used to redact cross-repo references). */
export async function repositories(owner, { run = ghRunner } = {}) {
  const out = await run(["repo", "list", owner, "--limit", "1000", "--json", "name", "--jq", ".[].name"]);
  return out.split("\n").filter(Boolean);
}

/**
 * Unified diff between two commits. Returns { diff } or { error } — a head that
 * was force-pushed away and garbage-collected is an expected outcome, not a crash.
 */
export async function compareDiff(owner, repo, base, head, { run = ghRunner } = {}) {
  try {
    const diff = await run(["api", "-H", "Accept: application/vnd.github.diff", `repos/${owner}/${repo}/compare/${base}...${head}`]);
    return { diff };
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? "");
    if (/HTTP 404|No common ancestor|Not Found/i.test(message)) return { error: "unreachable" };
    if (/HTTP 406|too large|diff is taking too long/i.test(message)) return { error: "too_large" };
    throw error;
  }
}
