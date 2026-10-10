import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { loadCatalogue, resolveCitations, renderCitations } = require("./citations.cjs");
const { renderReview, parseReview } = require("./findings-report.cjs");

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "citations");
const catalogues = Object.fromEntries(readdirSync(DIR).filter((f) => f.endsWith(".json"))
  .map((f) => [f, JSON.parse(readFileSync(join(DIR, f), "utf8"))]));

// Each catalogue's IDs follow its list's own pattern and edition, so a typo in
// regeneration (A1:2025, LLM03:2025 in the 2026 file) fails here.
const PATTERNS = {
  "owasp-web-2025.json": /^A(0[1-9]|10):2025$/,
  "owasp-llm-2026.json": /^LLM(0[1-9]|10):2026$/,
  "owasp-asi-2026.json": /^ASI(0[1-9]|10):2026$/,
  "cwe.json": /^CWE-\d+$/,
};

test("every catalogue file has a pattern, and the OWASP lists are complete top 10s", () => {
  assert.deepEqual(Object.keys(catalogues).sort(), Object.keys(PATTERNS).sort());
  for (const [file, { source, entries }] of Object.entries(catalogues)) {
    assert.ok(source.url && source.retrieved, `${file}: source needs url and retrieved`);
    for (const e of entries) {
      assert.match(e.id, PATTERNS[file], `${file}: ${e.id}`);
      assert.ok(e.name, `${file}: ${e.id} has no name`);
    }
    if (file !== "cwe.json") {
      assert.deepEqual(entries.map((e) => Number(e.id.match(/\d{2}/)[0])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], file);
    }
  }
});

test("PDF-sourced entries carry a page and the document hash", () => {
  for (const file of ["owasp-llm-2026.json", "owasp-asi-2026.json"]) {
    const { source, entries } = catalogues[file];
    assert.match(source.sha256, /^[0-9a-f]{64}$/, file);
    for (const e of entries) assert.ok(Number.isInteger(e.page) && e.page > 0, `${file}: ${e.id}`);
  }
});

test("every CWE an OWASP entry maps to exists in the CWE catalogue", () => {
  const cwe = loadCatalogue();
  for (const file of ["owasp-web-2025.json", "owasp-llm-2026.json"]) {
    for (const e of catalogues[file].entries) {
      for (const n of e.cwes) assert.ok(cwe.has(`CWE-${n}`), `${file}: ${e.id} maps to unknown CWE-${n}`);
    }
  }
});

test("SSRF is cited under A01:2025, where the 2025 edition moved it", () => {
  const a01 = catalogues["owasp-web-2025.json"].entries.find((e) => e.id === "A01:2025");
  assert.ok(a01.cwes.includes(918));
});

test("resolves known tags to catalogue links and keeps unknown ones apart", () => {
  const { known, unknown } = resolveCitations([
    "[A05:2025 · CWE-79] reflected XSS",
    "[LLM03:2026] over-broad tool grant, again CWE-79",
    "[A11:2025] and [LLM03:2025] are not real 2025/2026 entries; CWE-99999 is not a CWE",
  ]);
  assert.deepEqual(known.map((c) => c.id), ["A05:2025", "CWE-79", "LLM03:2026"]);
  assert.deepEqual(unknown, ["A11:2025", "LLM03:2025", "CWE-99999"]);
  const byId = Object.fromEntries(known.map((c) => [c.id, c]));
  assert.equal(byId["A05:2025"].url, "https://top10.owasp.org/2025/A05_2025-Injection/");
  assert.equal(byId["CWE-79"].url, "https://cwe.mitre.org/data/definitions/79.html");
  assert.match(byId["LLM03:2026"].url, /#page=23$/);
});

test("a bare, unversioned tag is not a citation", () => {
  assert.deepEqual(resolveCitations(["[A03] injection, [LLM01] injection"]), { known: [], unknown: [] });
});

test("renders nothing when there is nothing to cite", () => {
  assert.deepEqual(renderCitations(resolveCitations(["plain finding"]), String), []);
});

test("citations in a posted review do not change what parseReview reads back", () => {
  const findings = [
    { severity: "MUST FIX", location: "src/a.js:3", detail: "[A05:2025 · CWE-79] XSS", recommendation: "escape" },
    { severity: "NITPICK", location: "src/b.js:9", detail: "[A99:2025] bogus", recommendation: "none" },
  ];
  const body = renderReview("OWASP Web Top 10", "two findings", findings);
  assert.ok(body.includes("[A05:2025 Injection](https://top10.owasp.org/2025/A05_2025-Injection/)"), body);
  assert.match(body, /Unverified citations \(not in the pinned catalogue\): A99/);
  assert.deepEqual(parseReview(body), findings);
});
