import test from "node:test";
import assert from "node:assert/strict";
import { classifyReviewOutput } from "./review-formats.mjs";

const out = (body, author = "dev") => ({ body, author });
const pick = (r) => r && { pipeline: r.pipeline, lens: r.lens, verdict: r.verdict };

test("each known format is detected with its lens and verdict", () => {
  const cases = [
    [out("<!-- blind-peer-review:rendered-v1 -->\n# Review"), { pipeline: "bpr-rendered", lens: null, verdict: null }],
    [out("## Blind peer review — local run — verdict: **BLOCK**"), { pipeline: "bpr-local", lens: null, verdict: "BLOCK" }],
    [out("# Blind peer review — Cold Read (codex, out-of-host)"), { pipeline: "bpr-out-of-host", lens: "Cold Read", verdict: null }],
    [out("## Blind peer review — Acceptance Criteria\n\nMUST FIX ..."), { pipeline: "bpr-lens-comment", lens: "Acceptance Criteria", verdict: null }],
    [out("## Blind peer review: Policy & Provenance"), { pipeline: "bpr-lens-comment", lens: "Policy & Provenance", verdict: null }],
    [out("### Blind peer review — Red Team (#759)"), { pipeline: "bpr-lens-comment", lens: "Red Team", verdict: null }],
    [out("**Claude finished @someone's task in 7m 48s** —— [View job](x)", "claude"), { pipeline: "claude-app", lens: null, verdict: null }],
    [out('{"lens": "Edge Cases", "findings": []}'), { pipeline: "lens-json", lens: "Edge Cases", verdict: null }],
  ];
  for (const [o, expected] of cases) assert.deepEqual(pick(classifyReviewOutput(o)), expected, o.body);
});

test("ordinary discussion is not review output; unknown review-shaped text is counted as unclassified", () => {
  assert.equal(classifyReviewOutput(out("thanks, rebased")), null);
  assert.equal(classifyReviewOutput(out("")), null);
  assert.equal(classifyReviewOutput(out("**Claude finished @x's task**", "dev")), null);
  assert.equal(classifyReviewOutput(out("Some tool says MUST FIX: input not validated")).pipeline, "unclassified");
});

test("a reviewed head SHA in the text is extracted", () => {
  assert.equal(classifyReviewOutput(out("## Blind peer review — Cold Read\nReviewed head `abc1234def`")).headSha, "abc1234def");
});
