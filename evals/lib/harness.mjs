// Stubs for the Actions runtime, plus two thin drivers that run action.yml's
// real "Parse findings + post review" and "Aggregate lens results" steps.
//
// Everything here is deterministic and offline: no network, no model, no clock
// dependence. These drivers are what let a fixture assert on the ONE thing that
// actually stops a merge — the review `event` a lens posts, and the gate verdict
// that event produces.

import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const gateModule = require_("../../scripts/gate.cjs");
const preflightModule = require_("../../scripts/preflight.cjs");
const parseModule = require_("../../scripts/parse-and-post.cjs");

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractStepScript, runGithubScript } from "./action-script.mjs";

export const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
export const actionYml = () => readFileSync(join(ROOT, "action.yml"), "utf8");

export const HEAD_SHA = "0".repeat(39) + "1"; // fixed: no clock, no randomness
export const OWNER = "acme";
export const REPO = "widget";
export const PR_NUMBER = 42;

export function makeCore() {
  const c = {
    failed: null, infos: [], warnings: [], notices: [],
    info: (m) => c.infos.push(String(m)),
    debug: () => {},
    notice: (m) => c.notices.push(String(m)),
    warning: (m) => c.warnings.push(String(m)),
    error: (m) => c.warnings.push(String(m)),
    setFailed: (m) => { if (c.failed == null) c.failed = String(m); },
    setOutput: () => {},
    summary: { addRaw: () => c.summary, write: async () => {} },
  };
  return c;
}

export function makeContext({ headSha = HEAD_SHA, dispatch = false } = {}) {
  return {
    repo: { owner: OWNER, repo: REPO },
    // `workflow_dispatch` carries no pull_request payload at all. That is the
    // shape every on-demand run has, and the shape the head-SHA reads used to
    // throw on, so it is worth being able to drive here.
    payload: dispatch ? {} : { pull_request: { head: { sha: headSha }, number: PR_NUMBER } },
  };
}

/**
 * Octokit stub. `files` are PR files with `patch` (drives inline-comment
 * anchoring); `reviews` are pre-existing reviews (drives gate + reconcile).
 * Reviews created during the run are appended, so the post step's own
 * "did it land on head?" verification sees them — exactly as in production.
 */
export function makeGithub({ files = [], reviews = [], reviewComments = [], issueComments = [], failIssueList = false, checkRuns = [], headSha = HEAD_SHA } = {}) {
  const created = [];
  const dismissed = [];
  const minimized = [];
  const deletedComments = [];
  const state = { reviews: [...reviews] };
  let nextId = 9000;

  const gh = {
    created, dismissed, minimized, deletedComments, state, pullsGetCalls: [],
    paginate: async (fn, params) => fn(params).then((r) => r.data),
    graphql: async (_q, vars) => { minimized.push(vars.id); return { minimizeComment: { minimizedComment: { isMinimized: true } } }; },
    rest: {
      pulls: {
        // What the action falls back to when there is no event payload.
        get: async (p) => {
          gh.pullsGetCalls.push(p);
          return { data: { head: { sha: headSha }, number: p.pull_number } };
        },
        listFiles: async () => ({ data: files }),
        listReviews: async () => ({ data: state.reviews }),
        listReviewComments: async () => ({ data: reviewComments }),
        createReview: async (p) => {
          const rec = {
            id: nextId++, body: p.body, state: p.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
            commit_id: p.commit_id, user: { login: "github-actions[bot]" },
            submitted_at: `2026-01-01T00:00:${String(created.length).padStart(2, "0")}Z`,
            event: p.event, comments: p.comments,
          };
          created.push(rec);
          state.reviews.push(rec);
          return { data: rec };
        },
        dismissReview: async (p) => {
          dismissed.push(p.review_id);
          const r = state.reviews.find((x) => x.id === p.review_id);
          if (r) r.state = "DISMISSED";
          return { data: {} };
        },
      },
      issues: {
        listComments: async () => {
          if (failIssueList) throw new Error("simulated listComments failure");
          return { data: issueComments };
        },
        deleteComment: async (p) => { deletedComments.push(p.comment_id); return { data: {} }; },
      },
      checks: { listForRef: async () => ({ data: checkRuns }) },
    },
  };
  return gh;
}

/**
 * Drive action.yml's "Parse findings + post review" step over a raw agent
 * message. Returns what CI would observe: the failure string (if the lens job
 * fails), and the review body/event actually posted.
 */
export async function runParseStep({
  lensName, agentResponse, files = defaultFiles(), reviews = [], reviewComments = [],
  issueComments = [], failIssueList = false,
  dismissSuperseded = "false", cleanupAgentComments = "true", agentSuccess = "true", yml = null,
  lensHeading = undefined, submitted = undefined, dispatch = false,
}) {
  // Dual path, and the asymmetry is deliberate.
  //
  // `yml` is supplied only by verify-guards.mjs, which proves each regression
  // guard is load-bearing by replaying a HISTORICAL action.yml and asserting the
  // guard trips on the code that shipped the incident. Those commits predate the
  // extraction and contain the logic as an inline block, so the only way to run
  // them is to lift the string — importing the module would run TODAY's code
  // against a historical label and report PASS while proving nothing.
  //
  // Everything else runs the shipped module, so the ordinary path has no second
  // copy of this logic and no step-name coupling.
  const core = makeCore();
  const github = makeGithub({ files, reviews, reviewComments, issueComments, failIssueList });
  // `submitted` stands in for the file submit_findings writes. A string is
  // written verbatim (so a corrupt file can be exercised); an object is
  // serialised. `undefined` means the tool never ran — the message-only path.
  const dir = submitted === undefined ? null : mkdtempSync(join(tmpdir(), "adv-submit-"));
  const findingsPath = dir ? join(dir, "adversarial-findings.json") : "";
  if (dir) writeFileSync(findingsPath, typeof submitted === "string" ? submitted : JSON.stringify(submitted, null, 2));
  const env = {
    LENS_NAME: lensName,
    PR_NUMBER: String(PR_NUMBER),
    AGENT_RESPONSE: agentResponse,
    AGENT_SUCCESS: agentSuccess,
    DISMISS_SUPERSEDED: dismissSuperseded,
    CLEANUP_AGENT_COMMENTS: cleanupAgentComments,
    FINDINGS_PATH: findingsPath,
    // CI publishes this from the compose step; default to the same value so
    // the evals exercise what production actually passes.
    LENS_HEADING: lensHeading === undefined ? headingForDisplayName(lensName) : lensHeading,
  };
  const context = makeContext({ dispatch });
  try {
    if (yml === null) {
      await parseModule.run({ core, github, context, env });
    } else {
      const src = extractStepScript(yml, "Parse findings + post review", "script");
      await runGithubScript(src, { core, github, context, env });
    }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  const review = github.created[0] || null;
  return {
    failed: core.failed,
    posted: !!review,
    event: review?.event ?? null,
    body: review?.body ?? null,
    comments: review?.comments ?? [],
    deletedComments: github.deletedComments,
    blocked: review?.event === "REQUEST_CHANGES",
    core, github,
  };
}

/** Drive action.yml's "Aggregate lens results" (merge gate) step. */
export async function runGateStep({ expected, reviews, headSha = HEAD_SHA, dispatch = false }) {
  const core = makeCore();
  const github = makeGithub({ reviews, headSha });
  await gateModule.run({
    core, github, context: makeContext({ headSha, dispatch }),
    env: { EXPECTED: expected.join("|"), PR_NUMBER: String(PR_NUMBER) },
  });
  return { failed: core.failed, passed: core.failed == null, core };
}

/**
 * Drive action.yml's "Wait for prerequisite checks" (preflight) step.
 * `pollMs: 0` keeps the loop from actually sleeping, so a timeout case is
 * instant rather than real time.
 */
export async function runPreflightStep({
  required, checkRuns = [], headSha = HEAD_SHA, timeoutS = "0", pollS = "0", graceS = null, dispatch = false,
}) {
  const core = makeCore();
  const github = makeGithub({ checkRuns, headSha });
  await preflightModule.run({
    core, github, context: makeContext({ headSha, dispatch }),
    env: {
      REQUIRED_CHECKS: Array.isArray(required) ? required.join("\n") : String(required),
      TIMEOUT_S: String(timeoutS),
      POLL_S: String(pollS),
      // action.yml passes this through so the head SHA can be resolved when
      // there is no pull_request payload to read it from.
      PR_NUMBER: String(PR_NUMBER),
      ...(graceS === null ? {} : { MISSING_GRACE_S: String(graceS) }),
    },
  });
  return { failed: core.failed, passed: core.failed == null, log: core.infos.join("\n"), core };
}

/** One check run as GitHub's checks.listForRef returns it. */
export function checkRun({ name, conclusion = "success", status = "completed", started_at = "2026-01-01T00:00:00Z" }) {
  return { name, status, conclusion, started_at };
}

/** A minimal two-line PR file so inline-comment anchoring always has a target. */
export function defaultFiles() {
  return [{
    filename: "src/app.js",
    patch: "@@ -1,2 +1,4 @@\n const a = 1;\n+const b = 2;\n+const c = 3;\n const d = 4;",
  }];
}

/** Build PR-files (with `patch`) from a fixture's unified diff. */
export function filesFromDiff(diff) {
  const out = [];
  let cur = null;
  for (const line of diff.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) { cur = { filename: m[1], patch: "" }; out.push(cur); continue; }
    if (/^(diff --git|index |--- |new file|deleted file|similarity|rename )/.test(line)) continue;
    if (!cur) continue;
    cur.patch += (cur.patch ? "\n" : "") + line;
  }
  return out.filter((f) => f.patch.includes("@@"));
}

/** Shape a bot review the way the gate expects to see one. */
export function botReview({ lens, state = "COMMENTED", commit_id = HEAD_SHA, id = 1, submitted_at = "2026-01-01T00:00:00Z", body = null }) {
  return {
    id, commit_id, state, submitted_at,
    user: { login: "github-actions[bot]" },
    body: body ?? `## ${lens}\n\n> summary\n\nNo findings.`,
  };
}

/**
 * Read findings back out of the review body the action RENDERED. Used only for
 * reporting and for `location_matches`; the block/no-block verdict always comes
 * from the review `event` the action chose, never from this.
 */
export function parseReviewBody(body) {
  const out = [];
  for (const line of String(body || "").split("\n")) {
    const m = line.match(/^- \[(MUST FIX|SHOULD FIX|NITPICK)\] `([^`]+)` — (.*)$/);
    if (m) out.push({ severity: m[1], location: m[2], detail: m[3] });
  }
  return out;
}

/** A top-level PR comment as the pi agent action leaves it: the raw JSON reply. */
export function agentJsonComment({ lens, id = 500, findings = [], bot = true, fenced = false, body = null }) {
  const json = JSON.stringify({ lens, summary: "s", findings }, null, 2);
  return {
    id,
    user: { login: bot ? "github-actions[bot]" : "a-person" },
    body: body ?? (fenced ? "```json\n" + json + "\n```" : json),
  };
}

/**
 * The shipped persona H1 for a display name, mirroring what action.yml's compose
 * step publishes as LENS_HEADING. Returns "" for a name no persona claims.
 */
export function headingForDisplayName(displayName) {
  // From the registry — action.yml no longer carries a copy of it. Read here
  // rather than imported from lenses.mjs, which imports ROOT from this module:
  // the cycle leaves ROOT uninitialised at load time.
  const registry = JSON.parse(readFileSync(join(ROOT, "lenses", "manifest.json"), "utf8"));
  for (const lens of registry.lenses) {
    if (lens.name !== displayName) continue;
    try {
      const txt = readFileSync(join(ROOT, "lenses", `${lens.key}.md`), "utf8");
      const h = txt.split("\n").find((l) => l.startsWith("# "));
      return h ? h.replace(/^#\s*/, "").trim() : "";
    } catch { return ""; }
  }
  return "";
}
