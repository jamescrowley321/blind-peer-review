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

/**
 * Retry a runner on rate limiting (GitHub's secondary limits trip well before
 * the hourly quota on a bulk harvest). Backs off 60s, 120s, 240s, … then gives
 * up so the repo is marked incomplete rather than hanging forever.
 */
export function withRateLimitRetry(run, { attempts = 5, baseMs = 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  return async (args) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run(args);
      } catch (error) {
        if (errorCategory(error) !== "rate_limited" || attempt >= attempts) throw error;
        const wait = baseMs * 2 ** (attempt - 1);
        log(`rate limited; retry ${attempt}/${attempts - 1} in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
  };
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
  timelineItems(first: 50, itemTypes: [BASE_REF_CHANGED_EVENT, BASE_REF_FORCE_PUSHED_EVENT]) {
    nodes { ... on BaseRefChangedEvent { createdAt } ... on BaseRefForcePushedEvent { createdAt } }
  }
  commits(first: 100) { totalCount nodes { commit { oid committedDate parents(first: 1) { nodes { oid } } } } }
`;

const QUERY = `query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    isPrivate
    pullRequests(first: 20, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} }
    }
  }
}`;

/**
 * Yields PR nodes newest first, stopping at PRs created before `since`.
 * `visibility: "public"` refuses a repository GitHub reports as private, so a
 * public source can never carry private content with full attribution.
 */
export async function* pullRequests(owner, repo, { since = null, visibility = null, run = ghRunner } = {}) {
  let after = null;
  for (;;) {
    // -f, not -F: -F coerces numeric names to Int and reads "@file" values.
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`];
    if (after) args.push("-f", `after=${after}`);
    const repository = JSON.parse(await run(args)).data.repository;
    if (visibility === "public" && repository.isPrivate !== false) throw new Error("repository is not public");
    const page = repository.pullRequests;
    for (const pr of page.nodes) {
      if (since && pr.createdAt < since) return;
      yield pr;
    }
    if (!page.pageInfo.hasNextPage) return;
    after = page.pageInfo.endCursor;
  }
}

/** Repository names for an owner (used to redact cross-repo references). */
export async function repositories(owner, { visibility = null, run = ghRunner } = {}) {
  const args = ["repo", "list", owner, "--limit", "1000", "--json", "name", "--jq", ".[].name"];
  if (visibility) args.push("--visibility", visibility);
  const out = await run(args);
  return out.split("\n").filter(Boolean);
}

/** A stable error category; raw gh errors embed the command line (owner/repo). */
export function errorCategory(error) {
  const text = String(error?.stderr ?? "") + String(error?.message ?? "");
  if (/rate limit|HTTP 429|HTTP 403/i.test(text)) return "rate_limited";
  if (/timed? ?out|ETIMEDOUT/i.test(text)) return "timeout";
  if (/HTTP 5\d\d/.test(text)) return "server_error";
  if (/repository is not public/.test(text)) return "not_public";
  if (/HTTP 4\d\d/.test(text)) return "client_error";
  return "unknown";
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

/** head_sha of the Actions run that posted a comment, or null if unavailable. */
export async function runHeadSha(runUrl, { run = ghRunner } = {}) {
  const m = runUrl.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)/);
  if (!m) return null;
  try {
    const sha = (await run(["api", `repos/${m[1]}/${m[2]}/actions/runs/${m[3]}`, "--jq", ".head_sha"])).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
