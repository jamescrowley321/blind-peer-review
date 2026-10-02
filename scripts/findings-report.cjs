// Display-only reports. Gate decisions always come from their original channel.
const { writeOutput } = require("./safe-output.cjs");
const path = require("node:path");
const SEVERITIES = ["MUST FIX", "SHOULD FIX", "NITPICK"];
const FORMAT = "<!-- blind-peer-review:rendered-v1 -->";
const MAX_REPORT_BYTES = 256 * 1024;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Numeric entities prevent Markdown/HTML structure from being supplied by a
// finding. Encoding '&' too makes this reversible for the canonical parser.
// Underscores use compact backslash escapes; encode original backslashes first.
function encode(value) {
  return String(value).replace(/[&<>"'\\`*{}\[\]()#+.!|~=\-\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/_/g, "\\_");
}
function decode(value) {
  return value.replace(/\\_/g, "_").replace(/&#(\d+);/g, (all, n) => Number(n) <= 0xffff ? String.fromCharCode(Number(n)) : all);
}
function display(value, limit = 16_000) {
  let text = String(value ?? "").replace(/[\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, (c) => `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}]`);
  if (text.length > limit) text = text.slice(0, limit) + " [display shortened; full text is in the original review]";
  return encode(text);
}

function encodeCode(value) {
  // Inline HTML tags do not suppress CommonMark link/emphasis parsing.
  // Locations therefore entity-encode Markdown punctuation, including _.
  return String(value).replace(/[&<>"'\\`*_{}\[\]()#+.!|~=\-\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderReview(lens, summary, findings) {
  const lines = [`## ${lens}`, "", FORMAT, ""];
  if (summary) lines.push(...encode(summary).split("\n").map((l) => `> ${l}`), "");
  if (!findings.length) lines.push("No findings.");
  for (const f of findings) {
    const detail = encode(f.detail).split("\n");
    const fix = encode(f.recommendation).split("\n");
    // Entities are decoded in HTML <code>. Markdown backticks would display
    // the entity spellings literally (for example, src/x&#46;js instead of x.js).
    lines.push(`- [${f.severity}] <code>${encodeCode(f.location)}</code> — ${detail[0]}`);
    lines.push(...detail.slice(1).map((l) => `    | ${l}`));
    lines.push(`  - Fix: ${fix[0]}`, ...fix.slice(1).map((l) => `    | ${l}`));
  }
  return lines.join("\n");
}

// Parse only the public canonical item blocks, never a second hidden payload.
// Older bodies are supported conservatively; parsing never decides gate state.
function parseReview(body) {
  const canonical = body.split("\n").includes(FORMAT);
  const findings = [];
  let current = null, section = "detail", sawFix = false;
  const finish = () => {
    if (current) {
      if (!sawFix) throw new Error("finding block has no Fix field");
      if (canonical) for (const key of ["location", "detail", "recommendation"]) current[key] = decode(current[key]);
      findings.push(current);
    }
  };
  for (const line of body.split("\n")) {
    const item = (canonical && line.match(/^- \[(MUST FIX|SHOULD FIX|NITPICK)\] <code>([^<]*)<\/code> — (.*)$/))
      || line.match(/^- \[(MUST FIX|SHOULD FIX|NITPICK)\] `([^`]+)` — (.*)$/);
    if (item) {
      finish();
      current = { severity: item[1], location: item[2], detail: item[3], recommendation: "" };
      section = "detail"; sawFix = false;
    } else if (current && line.startsWith("  - Fix: ") && !sawFix) {
      current.recommendation = line.slice(9); section = "recommendation"; sawFix = true;
    } else if (current) {
      if (canonical) {
        if (!line.startsWith("    | ")) throw new Error("unexpected line in canonical finding block");
        current[section] += "\n" + line.slice(6);
      } else {
        current[section] += "\n" + line;
      }
    }
  }
  finish();
  if (!findings.length && !body.split("\n").includes("No findings.")) throw new Error("no canonical findings or clean-review marker");
  return findings;
}

function buildReport(entries, { verdict, context = "" } = {}) {
  const groups = new Map();
  for (const entry of entries) {
    for (const f of entry.findings || []) {
      if (!groups.has(f.location)) groups.set(f.location, new Map());
      const issues = groups.get(f.location);
      const identity = JSON.stringify([f.severity, f.detail, f.recommendation]);
      if (!issues.has(identity)) issues.set(identity, { ...f, attributions: [] });
      const issue = issues.get(identity);
      const attribution = issue.attributions.find((a) => a.lens === entry.name);
      if (attribution) attribution.count++;
      else issue.attributions.push({ lens: entry.name, count: 1 });
    }
  }
  return {
    verdict, context,
    lenses: entries.map(({ key, name, verdict, state, note }) => ({ key, name, verdict, ...(state ? { state } : {}), note: note || "" })),
    groups: [...groups].sort(([a], [b]) => compare(a, b)).map(([location, issues]) => ({
      location,
      issues: [...issues.values()].map((f) => ({ ...f, attributions: f.attributions.sort((a, b) => compare(a.lens, b.lens)) })).sort((a, b) =>
        SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || compare(a.detail, b.detail) || compare(a.recommendation, b.recommendation)),
    })),
  };
}

function renderReport(report) {
  const lines = ["## Combined peer review", "", `Verdict: **${display(report.verdict, 100)}**`, ""];
  if (report.context) lines.push(display(report.context).replace(/\n/g, " "), "");
  lines.push("| Lens | Verdict | Review state | Note |", "| --- | --- | --- | --- |");
  for (const row of report.lenses) lines.push(`| ${display(row.name, 500).replace(/\n/g, " ")} | ${display(row.verdict, 100)} | ${display(row.state || "local")} | ${display(row.note, 1000).replace(/\n/g, " ")} |`);
  lines.push("", "Findings are grouped by location. Distinct text and severity remain separate; grouping never changes an independent verdict.", "");
  let bytes = Buffer.byteLength(lines.join("\n"));
  let omitted = 0;
  for (const group of report.groups) {
    for (const issue of group.issues) {
      const block = [`### ${display(group.location, 2000).replace(/\n/g, " ")}`, "", `**${display(issue.severity, 100)}** — ${issue.attributions.map((a) => display(a.lens, 500) + (a.count > 1 ? ` (${a.count} identical findings)` : "")).join(", ")}`, "",
        ...display(issue.detail).split("\n").map((l) => `> ${l}`), "", "Fix:", "", ...display(issue.recommendation).split("\n").map((l) => `> ${l}`), ""];
      const size = Buffer.byteLength(block.join("\n")) + 1;
      if (bytes + size > MAX_REPORT_BYTES - 1000) { omitted++; continue; }
      lines.push(...block); bytes += size;
    }
  }
  if (!report.groups.length) lines.push("No parsed findings. See each lens verdict for missing or unreadable reviews.");
  if (omitted) lines.push(`${omitted} distinct finding(s) omitted from this bounded display. Read the original per-lens reviews for the complete findings.`);
  return lines.join("\n") + "\n";
}

function writeLocalReport(outDir, entries, verdict) {
  const report = buildReport(entries, { verdict, context: "Local review; original per-lens JSON is preserved beside this report." });
  writeOutput(path.join(outDir, "review-summary.json"), JSON.stringify(report, null, 2) + "\n");
  writeOutput(path.join(outDir, "review-summary.md"), renderReport(report));
}

module.exports = { buildReport, renderReport, parseReview, renderReview, writeLocalReport, MAX_REPORT_BYTES };
