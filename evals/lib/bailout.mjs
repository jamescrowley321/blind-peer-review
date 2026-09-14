// Early-abort policy for the `call` phase.
//
// A run whose opening calls all fail at the provider has nothing to learn from
// the remaining hundred, but it will still finish, still write a per-fixture
// error for each one, and still emit a scorecard — and that scorecard is
// indistinguishable from a quality result unless someone reads the reason
// strings. A nine-run comparison dispatched against an exhausted credit cap
// produced exactly that: 16 violations for a model that scores 3, with 0% false
// positives and 84–100% JSON validity, all of it noise.
//
// Kept as a pure decision so it can be tested without a network, a plan, or a
// provider: the policy is the part that has to be right.

/** Completed calls to decide on. */
export const BAILOUT_SAMPLE = 10;
/** Failure fraction within the sample at or above which the run is abandoned. */
export const BAILOUT_THRESHOLD = 0.8;

/**
 * How many completed calls to decide on, for a run of `total` calls.
 *
 * Clamped to the run: a 4-call run that fails 4 times is as dead as a 123-call
 * one, and waiting for a 10th call that never arrives would disable the breaker
 * on exactly the small runs it is cheapest to stop. Zero-length runs yield 0,
 * which `shouldBailOut` treats as nothing to decide.
 */
export function bailoutSample(total, sample = BAILOUT_SAMPLE) {
  return Math.max(0, Math.min(sample, total));
}

/**
 * Whether to abandon the run, given what has completed so far.
 *
 * Deliberately decides ONCE, at the moment the sample fills. Re-deciding later
 * would turn the breaker into a running quality gate — a model with a genuinely
 * bad provider hour halfway through is a result worth recording, not a reason to
 * throw away the fixtures that already succeeded.
 */
export function shouldBailOut({ completed, failed, total, sample = BAILOUT_SAMPLE, threshold = BAILOUT_THRESHOLD }) {
  const size = bailoutSample(total, sample);
  if (size === 0 || completed < size) return null;
  const rate = completed === 0 ? 0 : failed / completed;
  if (rate < threshold) return null;
  return { failed, completed, rate, threshold, abandoned: Math.max(0, total - completed) };
}

/** The operator-facing explanation. Names the cause and the remedy, not just the number. */
export function bailoutMessage(model, d) {
  return (
    `${d.failed}/${d.completed} of the opening calls failed at the provider ` +
    `(${Math.round(d.rate * 100)}% >= ${Math.round(d.threshold * 100)}%). ` +
    `The provider is unusable for "${model}" right now — this is infrastructure, ` +
    `not a review-quality result, so the remaining ${d.abandoned} call(s) are ` +
    `abandoned and NO scorecard is written. Check credit and rate limits, then re-run.`
  );
}
