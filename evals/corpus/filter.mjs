#!/usr/bin/env node
// Stage 2 of the review corpus: deterministic filters over harvested snapshots.
//
// Usage: node evals/corpus/filter.mjs --in <harvest-dir> --out <new-dir>
//
// Writes decisions.jsonl (one line per review round, accepted or not, with every
// reason) and summary.json. Refuses to overwrite an existing output directory,
// so a result can always be traced to the filter code that produced it.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { filterSnapshot, summarize } from "./lib/filters.mjs";

export function filterDirectory(inDir, outDir) {
  if (existsSync(outDir)) throw new Error(`Refusing to overwrite ${outDir}; use a new directory`);
  const files = readdirSync(inDir).filter((f) => f.endsWith(".json") && !["id-map.json", "harvest-summary.json"].includes(f)).sort();
  const decisions = [];
  for (const file of files) {
    const snapshot = JSON.parse(readFileSync(join(inDir, file), "utf8"));
    if (!Array.isArray(snapshot.rounds) || !snapshot.id) continue;
    decisions.push(...filterSnapshot(snapshot));
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "decisions.jsonl"), decisions.map((d) => JSON.stringify(d)).join("\n") + (decisions.length ? "\n" : ""));
  const summary = { snapshots: files.length, ...summarize(decisions) };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (!flag("--in") || !flag("--out")) throw new Error("Use --in <harvest-dir> --out <new-dir>");
  console.log(JSON.stringify(filterDirectory(resolve(flag("--in")), resolve(flag("--out"))), null, 2));
}
