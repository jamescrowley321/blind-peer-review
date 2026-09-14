#!/usr/bin/env node
// Render the committed scorecard store as a comparison table — offline, free.
//
//   node evals/collect.mjs                       # every stored round
//   node evals/collect.mjs --round 2026-09-14-ceiling-24000
//   node evals/collect.mjs --ingest <dir> --round <name>   # add downloaded runs
//
// WHY A STORE. Scorecards are uploaded as workflow artifacts with 30-day
// retention. A document that cites run ids for reproducibility stops being
// reproducible a month later, and the rounds that shaped this project's model
// choice would be gone. The store is the durable copy; the artifact is the
// receipt.
//
// WHY VALIDITY IS COMPUTED, NOT TRUSTED. A run whose calls failed at the
// provider still produces a complete, plausible-looking scorecard — a nine-run
// comparison against an exhausted credit cap scored 16 violations for a model
// that scores 3, at 0% false positives and 84-100% JSON validity. Ranking is
// therefore refused for anything not classified `measured`. The numbers are
// still printed, because hiding them invites someone to re-run and rediscover
// them; they are printed under a heading that says what they are.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORE = join(ROOT, "evals", "results");

/** Upstream-failure fractions at which a run stops being a measurement. */
export const VALIDITY = { degradedAt: 0.10, voidAt: 0.50 };

/** Classify a run by how much of it the provider actually answered. */
export function classify(upstreamFixtures, totalFixtures) {
  if (!totalFixtures) return { upstreamFixtures, totalFixtures, upstreamRate: 0, class: "void" };
  const upstreamRate = upstreamFixtures / totalFixtures;
  const cls = upstreamRate < VALIDITY.degradedAt ? "measured"
    : upstreamRate < VALIDITY.voidAt ? "degraded" : "void";
  return { upstreamFixtures, totalFixtures, upstreamRate: Number(upstreamRate.toFixed(4)), class: cls };
}

/** Count fixtures the provider never answered. The reason strings are the source of truth. */
export function upstreamFixtures(baseline) {
  return (baseline.fixtures || []).filter((f) => /UPSTREAM/.test(f.reason || "")).length;
}

/** Violations are listed in the scorecard, not the baseline; count them from the markdown. */
export function violationsFromCard(md) {
  if (!md) return 0;
  // Tolerant of header level and trailing whitespace: this parses scorecards
  // this repo generated, but a renderer tweak should not silently zero the count.
  const start = md.match(/^#{1,6}\s*Violations\s*$/m);
  if (!start) return 0;
  const rest = md.slice(start.index + start[0].length);
  const end = rest.match(/^#{1,6}\s+\S/m);
  const body = end ? rest.slice(0, end.index) : rest;
  return body.split("\n").filter((l) => l.trim().startsWith("- ")).length;
}

function summarise(baseline, md) {
  const m = baseline.meta, lenses = baseline.lenses || {};
  const vals = (k) => Object.values(lenses).map((v) => v[k]).filter((v) => v != null);
  const pct = (xs) => (xs.length ? `${Math.round(Math.min(...xs) * 100)}–${Math.round(Math.max(...xs) * 100)}%` : "n/a");
  const fp = Object.entries(lenses).filter(([, v]) => v.falsePositiveRate)
    .map(([k, v]) => `${Math.round(v.falsePositiveRate * 100)}% ${k}`);
  const validity = baseline.validity || classify(upstreamFixtures(baseline), (baseline.fixtures || []).length);
  return {
    model: m.model, ref: m.ref, ceiling: m.maxTokens, reps: m.reps,
    violations: violationsFromCard(md),
    fp: fp.length ? fp.join(", ") : "0% every lens",
    json: pct(vals("jsonValidityRate")),
    stability: pct(vals("stability")),
    recall: pct(vals("recall")),
    upstream: `${validity.upstreamFixtures}/${validity.totalFixtures}`,
    class: validity.class,
  };
}

export function loadRound(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    let baseline;
    try {
      baseline = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      // Skip, loudly. One corrupt file must not take the whole round's table
      // down: the surviving rows are still the record of what was measured.
      console.error(`skipping ${f}: not readable JSON (${e.message})`);
      continue;
    }
    if (!baseline?.meta?.model) {
      console.error(`skipping ${f}: no meta.model — cannot attribute a score to a model`);
      continue;
    }
    const cardPath = join(dir, f.replace(/\.json$/, ".md"));
    const md = existsSync(cardPath) ? readFileSync(cardPath, "utf8") : null;
    out.push(summarise(baseline, md));
  }
  return out;
}

const HEAD = "| Model | Violations | must-not-block FP | JSON validity | recall | stability | upstream |";
const SEP = "|---|---|---|---|---|---|---|";
const row = (r) => `| \`${r.model}\` | ${r.violations} | ${r.fp} | ${r.json} | ${r.recall} | ${r.stability} | ${r.upstream} |`;

function render(round, rows) {
  const by = (c) => rows.filter((r) => r.class === c).sort((a, b) => a.violations - b.violations);
  const out = [`## ${round}`, ""];
  const measured = by("measured");
  if (measured.length) {
    out.push(`### Measured — ranked`, "", HEAD, SEP, ...measured.map(row), "");
  }
  for (const [cls, title, note] of [
    ["degraded", "Degraded — reported, NOT ranked",
      "Some calls never reached the provider. The scores are real for the calls that landed and incomplete for the run."],
    ["void", "Void — not measurements",
      "The provider answered too little of these runs for any number in them to mean anything. Listed so they are not re-run in the belief they are missing."],
  ]) {
    const sel = by(cls);
    if (!sel.length) continue;
    out.push(`### ${title}`, "", note, "", HEAD, SEP, ...sel.map(row), "");
  }
  return out.join("\n");
}

// ───────────────────────────────── cli ─────────────────────────────────

function ingest(srcDir, round) {
  if (!round) { console.error("--ingest requires --round <name>"); process.exit(2); }
  const dst = join(STORE, round);
  mkdirSync(dst, { recursive: true });
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== "baseline.json") continue;
      let baseline;
      try {
        baseline = JSON.parse(readFileSync(p, "utf8"));
      } catch (e) {
        console.error(`skipping ${p}: not readable JSON (${e.message})`);
        continue;
      }
      if (!baseline?.meta?.model) {
        console.error(`skipping ${p}: no meta.model — a scorecard that cannot name its model is not evidence`);
        continue;
      }
      baseline.validity = classify(upstreamFixtures(baseline), (baseline.fixtures || []).length);
      const runId = (d.match(/(\d{6,})/) || [])[1] || String(n);
      const slug = `${baseline.meta.model.replace(/\//g, "__")}.${runId}`;
      writeFileSync(join(dst, `${slug}.json`), JSON.stringify(baseline, null, 1));
      const card = join(dirname(p), "scorecard.md");
      if (existsSync(card)) copyFileSync(card, join(dst, `${slug}.md`));
      console.log(`ingested ${baseline.meta.model} (${baseline.validity.class}, upstream ${baseline.validity.upstreamFixtures}/${baseline.validity.totalFixtures})`);
      n++;
    }
  };
  walk(srcDir);
  console.log(`\n${n} run(s) into ${dst}`);
}

const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`${k} requires a value`);
    process.exit(2);
  }
  return v;
};

if (arg("--ingest")) {
  ingest(arg("--ingest"), arg("--round"));
} else if (!existsSync(STORE)) {
  console.error(`no results store at ${STORE}`);
  process.exit(2);
} else {
  const only = arg("--round");
  const rounds = readdirSync(STORE).filter((d) => !only || d === only).sort();
  if (!rounds.length) { console.error(`no round matching ${only}`); process.exit(2); }
  for (const r of rounds) console.log(render(r, loadRound(join(STORE, r))), "");
}
