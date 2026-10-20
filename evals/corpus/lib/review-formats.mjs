// Deterministic detection of which pipeline produced a piece of PR feedback.
//
// Review output reached PRs through several pipelines over time, each with its
// own shape (catalogued from a survey of every public and private source). A
// detector returns null for ordinary discussion, otherwise:
//   { pipeline, role, lens, verdict, headSha, runUrl }
// role is "review" (a reviewer's judgement), "telemetry" (a run status with no
// judgement) or "static" (a non-LLM analyser). headSha is a hint read from the
// text; runUrl points at the Actions run whose head_sha is authoritative.
// Review-shaped text matching no format is "unclassified": counted, not dropped.

const LENS_V1 = "Blind Hunter|Edge Case Hunter|Acceptance Auditor|Sentinel|Viper|Compliance Auditor";
const LENS_V2 = "Cold Read|Edge Cases|Acceptance Criteria|Security Review|Red Team|Policy & Provenance";
const LENS_OW = "OWASP (?:Web|LLM) Top 10";
const LENS_ID = "cold_read|edge_case|acceptance|security|red_team|policy|owasp_web|owasp_llm";

const PI_FOOTER = /\[View action run\]\(([^)]*)\)\s*\|\s*Model:/;
const RUN_LINK = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/;
const TEXT_SHA = /(?<![0-9A-Za-z])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}(?![0-9A-Za-z])/;
// Local-run comments were hand-written per session, so markers vary:
// "**Verdict:** PASS", "**Verdict: PASS**", "Verdict: **PASS**"; the head as
// "head `sha`", "Head: branch @sha", "diff `base...sha`" or "... @ sha".
const LOCAL_VERDICT = /\bVerdict\b[*:\s]{0,6}(PASS|BLOCK)\b/;
const HEX = "((?=[0-9a-f]*[a-f])[0-9a-f]{7,40})\\b";
const LOCAL_HEADS = [
  new RegExp(`\\bhead\\b(?:[^\`\\n@]{0,40}[\`@]\\s*|:?\\s+)${HEX}`, "i"),
  new RegExp(`\\.\\.\\.${HEX}`),
  new RegExp(`\\B@\\s?${HEX}`),
];
const localHead = (body) => LOCAL_HEADS.map((re) => first(re, body)).find(Boolean) ?? null;
const SEVERITY = /\[(MUST FIX|SHOULD FIX|NITPICK)\]/;

const bot = (login) => (login ?? "").replace(/\[bot\]$/, "");
const first = (re, text, group = 1) => text.match(re)?.[group] ?? null;

/** First balanced {...} containing "lens", parsed; null if none parses. */
export function extractLensJson(body) {
  for (let start = body.indexOf("{"); start >= 0; start = body.indexOf("{", start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < body.length; i++) {
      const ch = body[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const value = JSON.parse(body.slice(start, i + 1));
          if (typeof value?.lens === "string") return value;
        } catch { /* not this brace */ }
        break;
      }
    }
  }
  return null;
}

const jsonVerdict = (json) => (json ? (json.findings ?? []).some((f) => f.severity === "MUST FIX") ? "BLOCK" : "PASS" : null);

// Order matters: rules are mutually exclusive in this order.
const DETECTORS = [
  {
    pipeline: "bpr-rendered", role: "review",
    test: (o) => o.body.includes("<!-- blind-peer-review:rendered-v1 -->"),
  },
  // A. CI lens pipeline (pi-coding-agent action).
  {
    pipeline: "bpr-action-null-review", role: "telemetry",
    test: (o) => o.kind === "review" && bot(o.author) === "github-actions" && o.body.trim() === "null",
  },
  {
    pipeline: "bpr-action-lens-review", role: "review",
    test: (o) => o.kind === "review" && bot(o.author) === "github-actions" && new RegExp(`^## (?:${LENS_V1}|${LENS_V2}|${LENS_OW})\\b`).test(o.body),
    lens: (o) => first(new RegExp(`^## (${LENS_V1}|${LENS_V2}|${LENS_OW})\\b`), o.body),
    verdict: (o) => (["CHANGES_REQUESTED", "DISMISSED"].includes(o.state) || /\[MUST FIX\]/.test(o.body) ? "BLOCK" : "PASS"),
  },
  {
    pipeline: "bpr-action-inline", role: "review",
    test: (o) => o.kind === "inline" && bot(o.author) === "github-actions" && (/^\[(MUST FIX|SHOULD FIX|NITPICK)\] /.test(o.body) || o.body.trim() === "See the review summary."),
  },
  {
    pipeline: "pi-lens-json-comment", role: "review",
    test: (o) => o.kind === "comment" && bot(o.author) === "github-actions" && /\{\s*"lens"\s*:/.test(o.body) && (PI_FOOTER.test(o.body) || o.body.includes("<!-- pi-coding-agent-comment -->")),
    json: true,
  },
  {
    pipeline: "pi-agent-session-comment", role: "telemetry",
    test: (o) => o.kind === "comment" && bot(o.author) === "github-actions" && (PI_FOOTER.test(o.body) || o.body.includes("<!-- pi-coding-agent-comment -->")),
  },
  {
    pipeline: "action-adversarial-summary-v0", role: "review",
    test: (o) => o.kind === "comment" && bot(o.author) === "github-actions" && (/^## 🛡️ .*Adversarial Review/.test(o.body) || o.body.trim() === "@.claude/review-summary.md"),
  },
  // B. Claude GitHub App.
  {
    pipeline: "claude-action-job", role: "review",
    test: (o) => o.kind === "comment" && bot(o.author) === "claude" && /^\*\*Claude (finished|is working|encountered)/.test(o.body),
    verdict: (o) => first(/\*\*Verdict:?\s*([^*]+)\*\*/, o.body)?.trim() ?? null,
  },
  // C. Local blind-peer-review plugin runs posted as comments.
  {
    pipeline: "bpr-local-per-lens", role: "review",
    test: (o) => o.kind === "comment" && (
      new RegExp(`^#{1,3} Blind peer review(?:: | — )(?:${LENS_V2}|${LENS_OW})\\b`, "m").test(o.body)
      || new RegExp(`^#{1,3} Blind peer review — (?:${LENS_ID}) \\(`, "m").test(o.body)
      || new RegExp(`^# (?:${LENS_ID})\\s*$`).test(o.body.split("\n")[0])),
    lens: (o) => first(new RegExp(`^#{1,3} Blind peer review(?:: | — )(${LENS_V2}|${LENS_OW}|${LENS_ID})\\b`, "m"), o.body)
      ?? first(new RegExp(`^# (${LENS_ID})\\s*$`), o.body.split("\n")[0]),
    verdict: (o) => first(LOCAL_VERDICT, o.body) ?? jsonVerdict(extractLensJson(o.body)),
    headSha: (o) => localHead(o.body),
  },
  {
    pipeline: "bpr-summary-comment", role: "review",
    test: (o) => o.kind === "comment" && /^#{1,3} Blind [Pp]eer [Rr]eview\b/m.test(o.body),
    verdict: (o) => first(/verdict: \*\*(PASS|BLOCK)\*\*/i, o.body) ?? first(/### Verdict: \*\*(PASS|BLOCK)\*\*/, o.body) ?? first(/— (PASS|BLOCK)$/m, o.body),
    headSha: (o) => first(/[0-9a-f]{7,40}\.\.\.([0-9a-f]{7,40})/, o.body),
  },
  {
    pipeline: "raw-lens-json-paste", role: "review",
    test: (o) => o.kind === "comment" && /^\s*(?:```json\s*)?\{\s*"lens"\s*:/.test(o.body) && !PI_FOOTER.test(o.body),
    json: true,
  },
  // D. Ralph/BMAD loop review pastes.
  {
    pipeline: "ralph-bmad-lens-paste", role: "review",
    test: (o) => o.kind === "comment" && /^(<details>\s*<summary>\s*Review|#{1,3} (Review( agent| artifact)?:|Adversarial Review:|Blind Hunter (Re-)?Review|Edge Case Review|Acceptance Audit\b|Security Review —|Red Team Security Review))/.test(o.body.trimStart()),
    lens: (o) => first(/^#{1,3} Review(?: agent| artifact)?:\s*([^\n]+)/m, o.body)?.trim() ?? null,
  },
  {
    pipeline: "adversarial-multilayer-summary", role: "review",
    test: (o) => o.kind === "comment" && /^#{1,2} (Adversarial (Code )?[Rr]eview|BMAD Adversarial Code Review|Fresh-Context Adversarial (Re-)?Review|Code Review:|Review Findings|Independent review evidence)/.test(o.body.trimStart()),
    verdict: (o) => first(/^#{1,2} [^\n]*?\b(REJECT|APPROVE|PASS|BLOCK)\b/, o.body.trimStart()),
  },
  // E. Codex connector.
  {
    pipeline: "codex-connector-review", role: "review",
    test: (o) => o.kind === "review" && bot(o.author) === "chatgpt-codex-connector",
    headSha: (o) => first(/\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`/, o.body),
  },
  {
    pipeline: "codex-connector-inline", role: "review",
    test: (o) => o.kind === "inline" && bot(o.author) === "chatgpt-codex-connector",
    verdict: (o) => (/!\[P[01] Badge\]/.test(o.body) ? "BLOCK" : null),
  },
  {
    pipeline: "codex-connector-summary", role: "review",
    test: (o) => o.kind === "comment" && bot(o.author) === "chatgpt-codex-connector" && !/usage limits/i.test(o.body),
    verdict: (o) => (/Didn't find any major issues/.test(o.body) ? "PASS" : null),
    headSha: (o) => first(/\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`/, o.body),
  },
  // F. Non-LLM analysers.
  { pipeline: "ghas-code-scanning", role: "static", test: (o) => bot(o.author) === "github-advanced-security" },
  {
    pipeline: "sonarqube-cloud", role: "static",
    test: (o) => bot(o.author) === "sonarqubecloud" && /Quality Gate (passed|failed)/i.test(o.body),
    verdict: (o) => (/Quality Gate failed/i.test(o.body) ? "FAIL" : "PASS"),
  },
  { pipeline: "dependency-review", role: "static", test: (o) => o.body.includes("<!-- dependency-review-pr-comment-marker -->") },
  { pipeline: "github-code-quality", role: "static", test: (o) => bot(o.author) === "github-code-quality" },
];

// Fallback verdict readers for formats whose verdict is not in a fixed marker.
// Normalise on the leading keyword; anything unrecognised is null so the
// fallback readers still run instead of a raw phrase standing in for a verdict.
const VERDICT_WORD = /^\W*(PASS|BLOCK|APPROVE\w*|REJECT\w*|FAIL\w*|REQUEST(?:ED)?[_ ]CHANGES|CHANGES[_ ]REQUESTED)\b/i;
export function normalize(v) {
  const word = typeof v === "string" ? v.match(VERDICT_WORD)?.[1]?.toUpperCase() : null;
  if (!word) return null;
  if (word === "PASS" || word.startsWith("APPROVE")) return "PASS";
  return "BLOCK";
}

const KNOWN_LENS = new RegExp(`^(?:${LENS_V1}|${LENS_V2}|${LENS_OW}|${LENS_ID}|Compliance|Policy)\\b`, "i");

/** Rows of a per-lens result table whose first cell names a known lens. */
export function lensTable(body) {
  const rows = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*\**\s*(PASS|BLOCK)\b[^|]*\|(.*)$/);
    const lens = m?.[1].replace(/\*/g, "").trim();
    if (m && KNOWN_LENS.test(lens)) rows.push({ lens, verdict: m[2], text: m[3] });
  }
  return rows;
}

const EMPTY_ITEM = /^(none|n\/a|nothing( blocking)?|no ([\w-]+ ){0,2}(findings|issues)|-)\b/i;
const plain = (line) => line.replace(/^\s*(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+|>\s*)/, "").replace(/[*_`]/g, "").trim();

/**
 * Items under every heading named by `heading` (MUST FIX by default). A section
 * runs until the next heading at the same or a higher level, so findings
 * written as sub-headings or bold paragraphs count; "none"-style placeholders
 * do not. Returns null when there is no such heading at all.
 */
export const MUST_FIX_HEADING = /^(#{1,6})\s*(?:\*\*)?(?:MUST FIX)\b/i;
export const SEVERITY_HEADING = /^(#{1,6})\s*(?:\*\*)?(?:MUST FIX|SHOULD FIX|BLOCK|WARN)\b/i;

export function mustFixItems(body, re = MUST_FIX_HEADING) {
  const lines = body.split("\n");
  let items = null;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(re);
    if (!h) continue;
    items ??= [];
    let current = null;
    for (let j = i + 1; j < lines.length; j++) {
      const sub = lines[j].match(/^(#{1,6})\s/);
      if (sub && sub[1].length <= h[1].length) break;
      const text = plain(lines[j]);
      if (!text) continue;
      const starts = sub || /^\s*([-*]|\d+[.)])\s+|^\s*\*\*/.test(lines[j]);
      if (starts || !current) {
        if (EMPTY_ITEM.test(text)) { current = null; continue; }
        current = { text };
        items.push(current);
      } else current.text += ` ${text}`;
    }
  }
  return items;
}

export function mustFixSectionVerdict(body) {
  const items = mustFixItems(body);
  return items === null ? null : items.length ? "BLOCK" : "PASS";
}

function fallbackVerdict(body) {
  const section = mustFixSectionVerdict(body);
  if (section === "BLOCK") return "BLOCK";
  const table = lensTable(body);
  if (table.length) return table.some((r) => r.verdict === "BLOCK") ? "BLOCK" : "PASS";
  return section ?? normalize(first(/\bVerdict\b[*:\s]{0,6}(approve\w*|reject\w*|pass|block)\b/i, body));
}

const EXCLUDED = [
  /^## 🚀 Pre-release Published/,
  /^🤖 Created releases:/,
  /^@(claude|codex)\b/,
];
const REVIEW_SHAPED = /\[(MUST FIX|SHOULD FIX)\]|\bverdict\b[^\n]{0,20}\b(BLOCK|PASS)\b/i;

export function classifyReviewOutput(output) {
  const body = typeof output.body === "string" ? output.body : "";
  if (!body.trim() || ["dependabot"].includes(bot(output.author))) return null;
  if (EXCLUDED.some((re) => re.test(body.trimStart()))) return null;
  if (bot(output.author) === "chatgpt-codex-connector" && /usage limits/i.test(body)) return null;
  const hit = DETECTORS.find((d) => d.test(output));
  if (!hit) {
    if (!REVIEW_SHAPED.test(body)) return null;
    return { pipeline: "unclassified", role: "review", lens: null, verdict: null, headSha: null, runUrl: null };
  }
  const json = hit.json ? extractLensJson(body) : null;
  return {
    pipeline: hit.pipeline,
    role: hit.role,
    lens: hit.lens?.(output) ?? json?.lens ?? null,
    verdict: normalize(hit.verdict?.(output) ?? (hit.json ? jsonVerdict(json) : null)) ?? (hit.role === "review" ? fallbackVerdict(body) : null),
    lensVerdicts: lensTable(body),
    severity: first(SEVERITY, body),
    findings: json?.findings ?? null,
    headSha: hit.headSha?.(output) ?? null,
    // Only pull_request-triggered runs: an issue_comment run (the @claude job)
    // reports the default branch as head_sha, not the PR head.
    runUrl: first(PI_FOOTER, body)?.match(RUN_LINK)?.[0] ?? null,
    textShaHint: first(TEXT_SHA, body, 0),
  };
}
