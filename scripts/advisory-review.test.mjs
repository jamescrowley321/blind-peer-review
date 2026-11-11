import { test } from "node:test";
import assert from "node:assert/strict";
import { runParseStep, botReview, HEAD_SHA } from "../evals/lib/harness.mjs";

const response = JSON.stringify({ lens: "Security Review", summary: "A real defect.", findings: [{
  severity: "MUST FIX", location: "src/app.js:2", detail: "Unscoped lookup.", recommendation: "Check the tenant.",
}] });

for (const advisoryOnly of [undefined, "false"]) {
  test(`default enforcement remains blocking (${advisoryOnly})`, async () => {
    const result = await runParseStep({ lensName: "Security Review", agentResponse: response, advisoryOnly });
    assert.equal(result.failed, null);
    assert.equal(result.event, "REQUEST_CHANGES");
    assert.equal(result.comments.length, 1);
  });
}

test("advisory retains MUST FIX findings but creates no blocking review or inline threads", async () => {
  const result = await runParseStep({ lensName: "Security Review", agentResponse: response, advisoryOnly: "true" });
  assert.equal(result.failed, null);
  assert.equal(result.event, "COMMENT");
  assert.deepEqual(result.comments, []);
  assert.match(result.body, /MUST FIX/);
  assert.match(result.body, /Unscoped lookup/);
  assert.match(result.body, /Check the tenant/);
  assert.match(result.body, /Advisory only/);
});

for (const advisoryOnly of ["yes", "1", "", "tru"]) {
  test(`invalid advisory configuration cannot silently post enforcement (${advisoryOnly})`, async () => {
    const result = await runParseStep({ lensName: "Security Review", agentResponse: response, advisoryOnly });
    assert.match(result.failed, /advisory_only/);
    assert.equal(result.posted, false);
  });
}

test("advisory does not turn malformed findings into a clean review", async () => {
  const result = await runParseStep({ lensName: "Security Review", agentResponse: "not JSON", advisoryOnly: "true" });
  assert.ok(result.failed);
  assert.equal(result.posted, false);
});

test("advisory cannot dismiss an earlier enforcing review", async () => {
  const review = botReview({ lens: "Security Review", state: "CHANGES_REQUESTED", commit: HEAD_SHA });
  const result = await runParseStep({ lensName: "Security Review", agentResponse: response,
    advisoryOnly: "true", dismissSuperseded: "true", reviews: [review] });
  assert.equal(result.failed, null);
  assert.deepEqual(result.github.dismissed, []);
});
