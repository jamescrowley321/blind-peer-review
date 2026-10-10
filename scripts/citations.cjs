// Resolve citation tags in finding text against the pinned catalogues in
// citations/. A model cannot fetch, so any URL it writes is a guess; it cites
// IDs only, and the link is rendered here from the catalogue. An ID the
// catalogue does not hold is reported as unverified — the finding itself is
// never changed or dropped, because a wrong citation is not a wrong finding.
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "citations");
// Broad on purpose: `A11:2025` or `LLM12:2026` must be caught as unverified,
// not silently ignored as "not a citation".
const TAG = /\b(?:(?:A|LLM|ASI)\d{2}:\d{4}|CWE-\d{1,5})\b/g;

let cached = null;
function loadCatalogue(dir = DIR) {
  if (dir === DIR && cached) return cached;
  const byId = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const { source, entries } = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const e of entries) {
      if (byId.has(e.id)) throw new Error(`citation ${e.id} is defined twice (${file})`);
      byId.set(e.id, { id: e.id, name: e.name, url: entryUrl(source, e), kind: e.kind });
    }
  }
  if (dir === DIR) cached = byId;
  return byId;
}

function entryUrl(source, e) {
  if (e.url) return e.url;
  if (source.entry_url) return source.entry_url.replace("{n}", e.id.replace(/^CWE-/, ""));
  return e.page ? `${source.document}#page=${e.page}` : source.url;
}

// Distinct tags across the given texts, in first-seen order, split by
// whether the catalogue holds them.
function resolveCitations(texts, catalogue = loadCatalogue()) {
  const seen = new Set();
  const known = [];
  const unknown = [];
  for (const text of texts) {
    for (const [id] of String(text ?? "").matchAll(TAG)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const hit = catalogue.get(id);
      if (hit) known.push(hit);
      else unknown.push(id);
    }
  }
  return { known, unknown };
}

// Markdown lines for a review body. `encode` is the caller's escaper: IDs that
// failed to resolve came from the model and are rendered as inert text. Known
// entries are catalogue data, so their URL is used as-is.
function renderCitations({ known, unknown }, encode) {
  const lines = [];
  if (known.length) {
    lines.push("Citations: " + known.map((c) => `[${encode(c.id)} ${encode(c.name)}](${c.url})` + (c.kind === "deprecated" ? " (deprecated)" : "")).join(" · "));
  }
  if (unknown.length) {
    lines.push("Unverified citations (not in the pinned catalogue): " + unknown.map(encode).join(", "));
  }
  return lines;
}

module.exports = { loadCatalogue, resolveCitations, renderCitations, TAG };
