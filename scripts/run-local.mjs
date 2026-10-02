#!/usr/bin/env node
// Blind Peer Review — local mode (Node, no shell).
//
// Runs the review personas against your working branch BEFORE you push, using
// the pi CLI. Each lens reads the branch diff and writes its findings to
// .blind-peer-review/out/<lens>.json. A repo can override any persona by committing
// .blind-peer-review/lenses/<lens>.md (trusted local tuning). Language-agnostic.
//
// Usage:
//   node scripts/run-local.mjs                     # branch + working edits vs default branch
//   node scripts/run-local.mjs --base main
//   node scripts/run-local.mjs --lens security --lens red_team   # repeatable
//   PI_BIN=pi MODEL=z-ai/glm-5.2 node scripts/run-local.mjs
//
// Requires: git, the `pi` CLI on PATH, and a provider key in OPENROUTER_API_KEY.
// Adjust the pi argv below for your pi version if needed.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import outputTools from "./safe-output.cjs";
const { writeOutput } = outputTools;

import reportTools from "./findings-report.cjs";
import { chooseLenses, reviewError } from "./dispatch-codex.mjs";
const { writeLocalReport } = reportTools;

import { scopeDiff } from "./scope-diff.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LENS_DIR = join(ROOT, "lenses");
const CONTRACT = join(ROOT, "contracts", "shared_review_contract.md");
let OUT;              // ephemeral: diff + per-lens findings
let OVERRIDE_DIR;  // committed: per-repo persona overrides

// The lens registry is the shared, harness-neutral manifest — one source of truth.
// Default selection follows manifest flags; --lens explicitly replaces it.
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(LENS_DIR, "manifest.json"), "utf8"));
} catch (e) {
  console.error(`error: could not read the lens registry at ${join(LENS_DIR, "manifest.json")} — ${e.message}`);
  process.exit(1);
}
let contractText;
try {
  contractText = readFileSync(CONTRACT, "utf8");
} catch (e) {
  // Without the contract a lens has no trust boundary and no output envelope.
  // Reviewing anyway would produce unparseable findings from an unguarded lens,
  // so stop rather than degrade quietly.
  console.error(`error: could not read the review contract at ${CONTRACT} — ${e.message}`);
  process.exit(1);
}
const NAMES = Object.fromEntries(manifest.lenses.map((l) => [l.key, l.name]));

function printHelp() {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n")
    .filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

let base = null;

let lensOverride = null;
let PI_BIN = process.env.PI_BIN || "pi";
let PROVIDER = process.env.PROVIDER || "openrouter";
let MODEL = process.env.MODEL || "z-ai/glm-5.2";
let THINKING = process.env.THINKING || "medium";

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--base") {
    base = argv[++i];
    // Not shell injection — the diff goes through execFileSync with an argument
    // array, so there is no shell to inject into. This stops a ref that begins
    // with "-" from being read by git as an option instead of a revision.
    if (base === undefined) { console.error("error: --base requires a value"); process.exit(1); }
    if (!/^[A-Za-z0-9_./~^-]+$/.test(base) || base.startsWith("-")) {
      console.error(`error: '${base}' is not a valid git ref for --base`);
      process.exit(1);
    }
  }
  // Repeatable, not comma-separated: --lens security --lens red_team
  else if (a === "--lens") {
    const v = argv[++i];
    if (!v) { console.error("error: --lens requires a value"); process.exit(1); }
    (lensOverride ??= []).push(v.trim());
  }
  else if (a === "--model") MODEL = argv[++i];
  else if (a === "--provider") PROVIDER = argv[++i];
  else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
  else { console.error(`Unknown arg: ${a}`); process.exit(2); }
}

let lenses;
try { lenses = chooseLenses(manifest, lensOverride?.join(",") ?? null); }
catch (e) { console.error(`error: ${e.message}`); process.exit(2); }

let diff, repo, patch;
try {
  const scoped = scopeDiff({ base });
  diff = scoped.diff;
  base = scoped.base;
  repo = scoped.root;
  patch = scoped.outputPath;
  OUT = dirname(patch);
  OVERRIDE_DIR = join(repo, ".blind-peer-review/lenses");
  writeOutput(patch, diff);
  for (const warning of scoped.warnings) console.error(`warning: ${warning}`);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
if (!diff.trim()) { console.log(`No changes vs ${base} — nothing to review.`); process.exit(0); }
console.log(`Diff: ${diff.split("\n").length} lines vs ${base}`);

const verdicts = [];

for (const key of lenses) {
  // Registry membership is also the path guard: `key` is about to be joined into
  // a filename, and only keys the manifest declares get that far, so a traversal
  // sequence never reaches the filesystem.
  const name = NAMES[key];
  if (!name) { console.log(`skip: unknown lens '${key}' (not in lenses/manifest.json)`); continue; }
  // A committed local override wins over the base persona (trusted, static tuning).
  const overridePath = join(OVERRIDE_DIR, `${key}.md`);
  const personaPath = existsSync(overridePath) ? overridePath : join(LENS_DIR, `${key}.md`);
  if (!existsSync(personaPath)) { verdicts.push({ key, name, state: "FAILED", note: `missing ${personaPath}` }); continue; }
  if (personaPath === overridePath) console.log(`  (local override: ${overridePath})`);

  const persona = readFileSync(personaPath, "utf8").split("__PR_NUMBER__").join("N/A (local review)");
  // The shared contract carries the trust boundary, the severity terms and the
  // output envelope. Local runs used to inline their own envelope and skip the
  // rest, which left a local review with no injection defence at all.
  const prompt = [
    "LOCAL MODE: There is no pull request. The full diff to review is in the file",
    `\`${patch}\` (a \`git diff\`). Read that file instead of calling any GitHub tool.`,
    "Read surrounding source files on disk to confirm findings. Do NOT modify files.",
    "",
    persona,
    "",
    contractText,
    "",
    "There is no submission tool here: print the contract's JSON object to stdout as",
    "your entire output — no prose, no markdown fences.",
  ].join("\n");

  console.log(`── ${name} ──`);
  const res = spawnSync(PI_BIN, ["--provider", PROVIDER, "--model", MODEL, "--thinking", THINKING], {
    cwd: repo, input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    console.log(`  ! could not run ${PI_BIN}: ${res.error.message}`);
    verdicts.push({ key, name, state: "FAILED", must: 0, note: `could not run ${PI_BIN}` });
    continue;
  }
  const out = res.stdout || "";
  try {
    writeOutput(join(OUT, `${key}.json`), out);
    if (res.status !== 0) writeOutput(join(OUT, `${key}.err`), res.stderr || "");
  } catch (e) {
    console.log(`  ! could not safely write review output: ${e.message}`);
    verdicts.push({ key, name, state: "FAILED", must: 0, note: e.message });
    continue;
  }
  if (res.status !== 0) {
    console.log(`  ! exit ${res.status} (see ${join(OUT, `${key}.err`)})`);
    verdicts.push({ key, name, state: "FAILED", must: 0, note: `exit ${res.status}` });
    continue;
  }
  // Adjudicate on the parsed severity, never on the text. A lens that writes
  // "no MUST FIX findings" is a pass, and substring matching would block it.
  let parsed = null;
  try { parsed = JSON.parse(out.trim()); } catch { /* handled below */ }
  const invalid = reviewError(parsed, name);
  if (invalid) {
    console.log(`  ! ${join(OUT, `${key}.json`)} is not the contract object — lens FAILED`);
    verdicts.push({ key, name, state: "FAILED", must: 0, note: invalid });
    continue;
  }
  const must = parsed.findings.filter((f) => f && f.severity === "MUST FIX").length;
  verdicts.push({ key, name, state: must ? "BLOCK" : "PASS", must, findings: parsed.findings });
  console.log(`  → ${join(OUT, `${key}.json`)} (${must} MUST FIX)`);
}

console.log(`\nDone. Findings in ${OUT}/. Review MUST FIX items before pushing.`);

// Fail closed: a MUST FIX blocks, and so does a lens whose review could not be
// read. A review nobody could parse has not passed.
console.log("\n── verdict ──");
for (const v of verdicts) {
  const detail = v.state === "FAILED" ? ` (${v.note})` : ` (${v.must} MUST FIX)`;
  console.log(`  ${v.state.padEnd(6)} ${v.name}${detail}`);
}
const blocked = verdicts.filter((v) => v.state !== "PASS");
try {
  writeLocalReport(OUT, verdicts.map((v) => ({ ...v, verdict: v.state })), blocked.length ? "BLOCK" : "PASS");
} catch (e) {
  console.error(`warning: combined report could not be written: ${e.message}`);
}
if (blocked.length) {
  for (const v of verdicts) {
    for (const f of (v.findings || []).filter((f) => f.severity === "MUST FIX")) {
      console.log(`\n  [${v.name}] ${f.location}\n    ${f.detail}`);
    }
  }
  console.log(`\nBLOCK — ${blocked.length} lens(es) blocked or failed.`);
  process.exit(1);
}
console.log("\nPASS — no MUST FIX findings.");
