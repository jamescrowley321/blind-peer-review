import test from "node:test";
import assert from "node:assert/strict";
import { classifyReviewOutput, extractLensJson } from "./review-formats.mjs";

const FOOTER = "\n---\n[View action run](https://github.com/o/r/actions/runs/34805453547) | Model: m | Time: 59s";
const o = (kind, author, body, extra = {}) => ({ kind, author, body, ...extra });
const pick = (r) => r && { pipeline: r.pipeline, role: r.role, lens: r.lens, verdict: r.verdict };

test("each catalogued format is detected with role, lens and verdict", () => {
  const cases = [
    [o("review", "github-actions", "## Blind Hunter\n\n> s\n\n- [SHOULD FIX] `a.js:1` — d", { state: "COMMENTED" }), ["bpr-action-lens-review", "review", "Blind Hunter", "PASS"]],
    [o("review", "github-actions", "## Red Team\n\n- [MUST FIX] `a.js:1` — d", { state: "DISMISSED" }), ["bpr-action-lens-review", "review", "Red Team", "BLOCK"]],
    [o("review", "github-actions[bot]", "## OWASP Web Top 10\n\nNo findings.", { state: "CHANGES_REQUESTED" }), ["bpr-action-lens-review", "review", "OWASP Web Top 10", "BLOCK"]],
    [o("review", "github-actions", "null"), ["bpr-action-null-review", "telemetry", null, null]],
    [o("inline", "github-actions", "[SHOULD FIX] parser is fragile"), ["bpr-action-inline", "review", null, null]],
    [o("comment", "github-actions", '```json\n{ "lens": "Sentinel", "summary": "s", "findings": [] }\n```' + FOOTER), ["pi-lens-json-comment", "review", "Sentinel", "PASS"]],
    [o("comment", "github-actions", 'I\'ll fetch the diff.{"lens":"Viper","findings":[{"severity":"MUST FIX"}]}' + FOOTER), ["pi-lens-json-comment", "review", "Viper", "BLOCK"]],
    [o("comment", "github-actions", "✅ Agent session completed" + FOOTER), ["pi-agent-session-comment", "telemetry", null, null]],
    [o("comment", "claude", "**Claude finished @x's task in 4m 44s** —— [View job](https://github.com/o/r/actions/runs/1)\n**Verdict: no blocking defects found.**"), ["claude-action-job", "review", null, "no blocking defects found."]],
    [o("comment", "jamescrowley321", "## Blind peer review — Cold Read (#752, round 2)\nReviewer: codex, head `c38d87e`.\n**Verdict:** PASS: 0 finding(s)"), ["bpr-local-per-lens", "review", "Cold Read", "PASS"]],
    [o("comment", "jamescrowley321", "## Blind peer review: Policy & Provenance\n..."), ["bpr-local-per-lens", "review", "Policy & Provenance", null]],
    [o("comment", "jamescrowley321", "# cold_read\nprose"), ["bpr-local-per-lens", "review", "cold_read", null]],
    [o("comment", "jamescrowley321", "## Blind peer review — local run (8 lenses)\ndiff `912bdd6...7b51a39`\n### Verdict: **BLOCK**"), ["bpr-summary-comment", "review", null, "BLOCK"]],
    [o("comment", "jamescrowley321", '{ "lens": "Acceptance Criteria", "summary": "s", "findings": [] }'), ["raw-lens-json-paste", "review", "Acceptance Criteria", "PASS"]],
    [o("comment", "jamescrowley321", "## Review: Blind Hunter\n\n### MUST FIX\nNo findings."), ["ralph-bmad-lens-paste", "review", "Blind Hunter", null]],
    [o("comment", "jamescrowley321", "## Code Review: REJECT\n### Layer 1"), ["adversarial-multilayer-summary", "review", null, "REJECT"]],
    [o("review", "chatgpt-codex-connector", "### 💡 Codex Review\n**Reviewed commit:** `abc1234`"), ["codex-connector-review", "review", null, null]],
    [o("inline", "chatgpt-codex-connector", "![P1 Badge] **Bug**"), ["codex-connector-inline", "review", null, "BLOCK"]],
    [o("comment", "sonarqubecloud", "**Quality Gate passed**"), ["sonarqube-cloud", "static", null, "PASS"]],
    [o("inline", "github-advanced-security", "## CodeQL / Incomplete string escaping"), ["ghas-code-scanning", "static", null, null]],
  ];
  for (const [output, [pipeline, role, lens, verdict]] of cases) {
    assert.deepEqual(pick(classifyReviewOutput(output)), { pipeline, role, lens, verdict }, output.body.slice(0, 60));
  }
});

test("head SHAs come only from each format's own marker, and run links are captured", () => {
  assert.equal(classifyReviewOutput(o("comment", "jamescrowley321", "## Blind peer review — Cold Read\nregression from commit `deadbee1` …\nhead `c38d87e`")).headSha, "c38d87e");
  assert.equal(classifyReviewOutput(o("comment", "jamescrowley321", "## Blind peer review — Cold Read\nregression from commit `deadbee1`")).headSha, null);
  assert.equal(classifyReviewOutput(o("comment", "jamescrowley321", "## Blind peer review — local run\ndiff `912bdd6...7b51a39`")).headSha, "7b51a39");
  assert.equal(classifyReviewOutput(o("comment", "github-actions", "✅ done" + FOOTER)).runUrl, "https://github.com/o/r/actions/runs/34805453547");
});

test("triggers, release notes, usage notices and ordinary discussion are not review output", () => {
  for (const output of [
    o("comment", "jamescrowley321", "@claude review this PR"),
    o("comment", "jamescrowley321", "🤖 Created releases:\n- v1"),
    o("comment", "chatgpt-codex-connector", "You have reached your Codex usage limits"),
    o("comment", "dependabot", "Bumps x"),
    o("comment", "dev", "thanks, rebased"),
    o("comment", "dev", ""),
  ]) assert.equal(classifyReviewOutput(output), null, output.body);
  assert.equal(classifyReviewOutput(o("comment", "dev", "tool says [MUST FIX] input")).pipeline, "unclassified");
});

test("lens JSON is found after narration and inside braces in strings", () => {
  assert.deepEqual(extractLensJson('narration {not json} then {"lens":"X","summary":"a } b","findings":[]} tail'), { lens: "X", summary: "a } b", findings: [] });
  assert.equal(extractLensJson("no json here"), null);
});
