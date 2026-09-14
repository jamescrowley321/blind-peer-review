// The PR's head SHA, for the steps that must anchor to the commit under review.
//
// Every one of them used to read `context.payload.pull_request.head.sha`, which
// only exists on a `pull_request` event. On `workflow_dispatch` — the on-demand
// path this action advertises via the `pr_number` input — `payload.pull_request`
// is undefined, so those reads threw `TypeError: Cannot read properties of
// undefined` and the review could never run at all. The PR NUMBER was already
// resolved from the input; the SHA was not.
//
// Resolved from the event when there is one (no API call on the hot path) and
// from the PR itself when there is not.

async function headSha({ github, context, env }) {
  const fromEvent =
    context &&
    context.payload &&
    context.payload.pull_request &&
    context.payload.pull_request.head &&
    context.payload.pull_request.head.sha;
  if (fromEvent) return fromEvent;

  const raw = (env && env.PR_NUMBER ? String(env.PR_NUMBER) : "").trim();
  const pull_number = Number(raw);
  if (!raw || !Number.isInteger(pull_number) || pull_number <= 0) {
    throw new Error(
      "Cannot resolve the PR head SHA: this is not a pull_request event and PR_NUMBER " +
        `is not a positive integer (got ${JSON.stringify(raw)}). Pass the action's ` +
        "pr_number input through to this step.",
    );
  }

  const { data } = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number,
  });
  const sha = data && data.head && data.head.sha;
  if (!sha) throw new Error(`PR #${pull_number} returned no head SHA.`);
  return sha;
}

module.exports = { headSha };
