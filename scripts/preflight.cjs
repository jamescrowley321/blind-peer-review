// Preflight: wait for the cheap deterministic checks before the paid lenses run.
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

const { headSha: resolveHeadSha } = require(__dirname + "/head-sha.cjs");

async function run({ core, github, context, env }) {
  // One check name per line. A check name is an arbitrary human string
  // and commas are legal in it, so comma-splitting turned
  // "Foundation build, lint, and tests" into three names that never
  // report and preflight waited out its whole timeout.
  const required = (env.REQUIRED_CHECKS || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!required.length) { core.info("No required_checks configured — preflight passes."); return; }

  const headSha = await resolveHeadSha({ github, context, env });
  // Number("abc") is NaN, and every comparison against NaN is false — so a
  // mistyped timeout does not error, it silently disables the timeout and the
  // loop polls until the job's own limit kills it.
  const secs = (raw, dflt, name) => {
    const n = Number(raw ?? dflt);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${name} must be a non-negative number of seconds (got ${JSON.stringify(raw)})`);
    }
    return n * 1000;
  };
  const timeoutMs = secs(env.TIMEOUT_S || "1500", "1500", "preflight_timeout_seconds");
  const pollMs = secs(env.POLL_S || "30", "30", "preflight_poll_seconds");
  const start = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const FAIL = ["failure", "cancelled", "timed_out", "action_required", "stale"];
  //: How long a required name may stay unseen before it is treated as wrong
  //: rather than slow. Only applies once some OTHER check has completed on
  //: the same SHA, so a genuinely slow-to-register check is unaffected.
  //: Env-overridable so the contract evals can exercise the early-fail path
  //: without waiting it out; deliberately NOT an action input.
  const MISSING_GRACE_MS = secs(env.MISSING_GRACE_S ?? "90", "90", "MISSING_GRACE_S");
  //: Cap the diagnostic name list; a busy PR can carry dozens of checks.
  const MAX_OBSERVED_SHOWN = 40;

  while (true) {
    const runs = await github.paginate(github.rest.checks.listForRef, {
      owner: context.repo.owner, repo: context.repo.repo, ref: headSha, per_page: 100,
    });
    const stateOf = (name) => {
      const m = runs.filter((r) => r.name === name);
      if (!m.length) return "missing";
      const latest = m.sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0))[0];
      return latest.status === "completed" ? (latest.conclusion || "unknown") : "pending";
    };
    const state = Object.fromEntries(required.map((n) => [n, stateOf(n)]));
    const failed = required.filter((n) => FAIL.includes(state[n]));
    if (failed.length) {
      core.setFailed(`Prerequisite check(s) failed — skipping the agentic review: ${failed.map((n) => `${n}=${state[n]}`).join(", ")}`);
      return;
    }
    // "missing" (no check by that name has EVER reported on this SHA) and
    // "pending" (it exists and is still running) are different problems with
    // different fixes, and only one of them is worth waiting on. Conflating
    // them is why a misspelt name burned the whole timeout and then GUESSED
    // in the error — while `runs` held the answer the entire time.
    const missing = required.filter((n) => state[n] === "missing");
    const pending = required.filter((n) => state[n] === "pending");
    const waiting = [...missing, ...pending];
    if (!waiting.length) {
      core.info(`All prerequisite checks passed: ${required.join(", ")}.`);
      return;
    }

    // What IS reporting on this SHA — the diagnosis for every "missing" name.
    const observed = [...new Set(runs.map((r) => r.name))].sort();
    const shown = observed.slice(0, MAX_OBSERVED_SHOWN);
    const observedList = observed.length
      ? shown.join(", ") + (observed.length > shown.length ? `, … (${observed.length} total)` : "")
      : "(none yet)";
    // One name per line is the contract, and a value carrying a comma but no
    // newline is almost always the pre-v3 delimited form. Say so where it is
    // read, not only in the input description.
    const commaHint = required.some((n) => n.includes(","))
      ? `\nOne name PER LINE — a required_checks value containing "," is read as a single name. ` +
        `Use a block scalar (required_checks: |).`
      : "";

    const elapsedS = Math.round((Date.now() - start) / 1000);

    // Fail fast on names that cannot resolve. Conservative on purpose: only
    // when NO required name has ever reported, something else already finished
    // on this SHA (so checks are demonstrably registering), and the grace
    // period has passed — a check that is merely slow to register still gets
    // its full wait.
    const someoneFinished = runs.some((r) => r.status === "completed");
    if (!pending.length && missing.length && someoneFinished && Date.now() - start > MISSING_GRACE_MS) {
      core.setFailed(
        `No check has reported under ${missing.length === 1 ? "this name" : "these names"} on ${headSha.slice(0, 12)} ` +
        `after ${elapsedS}s, while other checks on the same commit have already completed: ${missing.join(", ")}\n` +
        `Checks present: ${observedList}${commaHint}`,
      );
      return;
    }

    if (Date.now() - start > timeoutMs) {
      const detail = [
        missing.length ? `  never reported: ${missing.join(", ")}` : null,
        pending.length ? `  still running:  ${pending.join(", ")}` : null,
      ].filter(Boolean).join("\n");
      core.setFailed(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for prerequisite checks.\n${detail}\n` +
        `Checks present on ${headSha.slice(0, 12)}: ${observedList}${commaHint}`,
      );
      return;
    }
    const parts = [
      missing.length ? `missing (never reported): ${missing.join(", ")}` : null,
      pending.length ? `pending: ${pending.join(", ")}` : null,
    ].filter(Boolean).join(" | ");
    core.info(`Waiting on ${parts} — elapsed ${elapsedS}s`);
    if (missing.length) core.info(`  checks present on ${headSha.slice(0, 12)}: ${observedList}`);
    await sleep(pollMs);
  }
}

module.exports = { run };
