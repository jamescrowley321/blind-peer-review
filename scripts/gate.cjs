// Merge gate: adjudicate the lens reviews on the head commit.
//
// Extracted from action.yml's inline `script:` block. The logic lives here so it
// can be read, diffed and unit-tested as code rather than as a YAML string; the
// action calls it in two lines.
//
// The evals import this module directly, which keeps the property the old
// string-lifting harness existed to protect — there is no second copy of this
// logic to drift — and improves on it: an import cannot silently target the
// wrong step name. What an import CANNOT catch is action.yml ceasing to call
// this module at all, so a contract test asserts the step still requires it.
//
// `core`, `github` and `context` are the actions/github-script globals, passed
// in rather than reached for, so a test supplies stubs with no ceremony. `env`
// is passed for the same reason: the module never touches process.env.

async function run({ core, github, context, env }) {
  const prNumber = Number(env.PR_NUMBER);
  const headSha = context.payload.pull_request.head.sha;
  const EXPECTED = env.EXPECTED.split("|").filter(Boolean);

  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const isBot = (r) =>
    r.user && (r.user.login === "github-actions[bot]" || r.user.login === "github-actions");
  // Match the EXACT "## <Lens>" header line (an empty/"null" body matches
  // nothing). Exact, not a prefix: a bare startsWith would mis-attribute a
  // review whose lens name is a prefix of another's (e.g. "Security Review" vs
  // "Security Review Plus") — same fix as the post step's `ownsReview`.
  const lensOf = (r) => {
    const first = (r.body || "").trim().split("\n")[0].trim();
    return EXPECTED.find((l) => first === `## ${l}`) || null;
  };
  const onHead = reviews.filter((r) => r.commit_id === headSha && isBot(r) && EXPECTED.includes(lensOf(r)));

  // Keep only the LATEST review per lens, so a stale CHANGES_REQUESTED (or an
  // earlier empty body) from a prior attempt on the same SHA can't block a re-run.
  const latestByLens = new Map();
  for (const r of onHead) {
    const lens = lensOf(r);
    const prev = latestByLens.get(lens);
    if (!prev || new Date(r.submitted_at) > new Date(prev.submitted_at)) latestByLens.set(lens, r);
  }
  const missing = EXPECTED.filter((l) => !latestByLens.has(l));
  const blocked = [...latestByLens.values()].filter((r) => r.state === "CHANGES_REQUESTED");

  core.info(`Lenses on ${headSha.slice(0, 12)}: ${latestByLens.size} / ${EXPECTED.length} (requesting changes: ${blocked.length})`);
  for (const [lens, r] of latestByLens) core.info(`  ${r.state.padEnd(18)} ## ${lens}`);
  if (missing.length) core.info(`  MISSING: ${missing.join(", ")}`);

  if (missing.length > 0) {
    core.setFailed(
      `Missing well-formed review from: ${missing.join(", ")}. ` +
      `These lenses returned empty/malformed output — re-run their jobs to retry.`,
    );
    return;
  }
  if (blocked.length > 0) {
    const names = blocked.map((r) => (r.body || "").trim().split("\n")[0].replace(/^##\s*/, "")).join(", ");
    core.setFailed(`${blocked.length} lens(es) requested changes (${names}) — resolve MUST FIX findings before merge`);
    return;
  }
  core.info(`All ${EXPECTED.length} lenses completed with no blocking findings. Gate passes.`);
}

module.exports = { run };
