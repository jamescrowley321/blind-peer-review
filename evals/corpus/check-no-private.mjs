#!/usr/bin/env node
// Local pre-push guard: fail if any tracked file mentions a private-source term.
// The term list is a local file (one term per line) and is never committed, so
// this check cannot run in CI without leaking what it protects.
//
// Usage: node evals/corpus/check-no-private.mjs --terms <local-terms-file>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const i = process.argv.indexOf("--terms");
if (i < 0 || !process.argv[i + 1]) throw new Error("Use --terms <local-terms-file>");
const terms = readFileSync(process.argv[i + 1], "utf8").split("\n").map((t) => t.trim()).filter((t) => t.length >= 3);
if (!terms.length) throw new Error("terms file is empty");
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
let hits = 0;
for (const file of files) {
  let text;
  try { text = readFileSync(file, "utf8").toLowerCase(); } catch { continue; }
  for (const [n, term] of terms.entries()) {
    if (text.includes(term.toLowerCase())) { console.log(`${file}: matches term #${n + 1}`); hits++; }
  }
}
if (hits) process.exit(1);
console.log(`ok: ${files.length} tracked files, ${terms.length} terms, no matches`);
