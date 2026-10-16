// Deterministic detection of which pipeline produced a piece of PR feedback.
//
// Review output reached PRs through several pipelines over time, each with its
// own shape. A detector returns null for ordinary discussion, otherwise
// { pipeline, headSha?, verdict? }. Text that looks like review output but
// matches no known format is "unclassified" so it is counted, never dropped.

const SHA = /\b[0-9a-f]{7,40}\b/;
const LENS_HEADING = /^#{1,3} Blind peer review\s*[—:-]\s*(?!local run)([A-Z][\w &]+?)\s*(?:\(.*\))?\s*$/m;

const DETECTORS = [
  {
    pipeline: "bpr-rendered",
    test: (o) => o.body.includes("<!-- blind-peer-review:rendered-v1 -->"),
  },
  {
    pipeline: "bpr-local",
    test: (o) => /^#{1,3} Blind peer review — local run/m.test(o.body),
  },
  {
    pipeline: "bpr-out-of-host",
    test: (o) => /^#{1,3} Blind peer review — .+\(.+, out-of-host\)/m.test(o.body),
  },
  {
    pipeline: "bpr-lens-comment",
    test: (o) => LENS_HEADING.test(o.body),
  },
  {
    pipeline: "claude-app",
    test: (o) => o.author === "claude" && /^\*\*Claude finished @[\w-]+'s task/m.test(o.body),
  },
  {
    pipeline: "lens-json",
    test: (o) => /^\s*(?:```json\s*)?\{\s*"lens"\s*:/.test(o.body),
  },
];

const REVIEW_SHAPED = /\b(MUST FIX|SHOULD FIX|NITPICK)\b|\bverdict\b.*\b(BLOCK|PASS)\b/i;

export function parseVerdict(body) {
  const m = body.match(/verdict[^A-Za-z]{0,10}\**\s*(BLOCK|PASS|FAIL|APPROVE|REQUEST_CHANGES)\b/i);
  return m ? m[1].toUpperCase() : null;
}

export function extractHeadSha(body) {
  const m = body.match(/(?:head|reviewed|commit|sha)[^0-9a-f\n]{0,20}`?([0-9a-f]{7,40})\b/i);
  return m && SHA.test(m[1]) ? m[1] : null;
}

export function classifyReviewOutput(output) {
  if (typeof output.body !== "string" || !output.body.trim()) return null;
  const hit = DETECTORS.find((d) => d.test(output));
  if (!hit && !REVIEW_SHAPED.test(output.body)) return null;
  return {
    pipeline: hit?.pipeline ?? "unclassified",
    headSha: extractHeadSha(output.body),
    verdict: parseVerdict(output.body),
    lens: output.body.match(LENS_HEADING)?.[1] ?? output.body.match(/^\s*(?:```json\s*)?\{\s*"lens"\s*:\s*"([^"]+)"/)?.[1] ?? null,
  };
}
