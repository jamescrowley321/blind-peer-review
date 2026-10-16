#!/usr/bin/env node
// Stage 1 of the review corpus: harvest PRs that carry review output into
// frozen per-PR snapshots. Read-only against GitHub.
//
// Usage: node evals/corpus/harvest.mjs --config <local-config.json> [--only <source-name>]
//
// The config lives outside the repository. It names sources, output dirs and,
// for private sources, the pseudonymization key; nothing about a private source
// is ever committed. See docs/superpowers/specs/2026-10-15-review-corpus-design.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareDiff, ghRunner, pullRequests, repositories } from "./lib/github.mjs";
import { buildSnapshot } from "./lib/snapshot.mjs";
import { classifyReviewOutput } from "./lib/review-formats.mjs";
import { leakedIdentifiers, makeRedactor, privateCaseId } from "./lib/pseudonymize.mjs";

export function loadConfig(path) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(config.sources) || !config.sources.length) throw new Error("config.sources must be a non-empty array");
  for (const s of config.sources) {
    if (!s.name || !s.owner || !s.out) throw new Error("each source needs name, owner and out");
    if (!["public", "private"].includes(s.visibility)) throw new Error(`source ${s.name}: visibility must be public or private`);
    if (s.repos !== "*" && !Array.isArray(s.repos)) throw new Error(`source ${s.name}: repos must be an array or "*"`);
    if (s.visibility === "private" && (typeof s.key !== "string" || s.key.length < 32)) {
      throw new Error(`source ${s.name}: private sources need a key of at least 32 characters`);
    }
  }
  return config;
}

function logins(snapshot) {
  const users = new Set([snapshot.author]);
  for (const r of snapshot.rounds) for (const o of r.outputs) users.add(o.author);
  return [...users].filter(Boolean);
}

/** Apply redaction to every free-text field of a private snapshot. */
export function redactSnapshot(snapshot, redact) {
  return {
    ...snapshot,
    title: redact(snapshot.title),
    author: null,
    baseRef: redact(snapshot.baseRef),
    headRef: redact(snapshot.headRef),
    currentBody: redact(snapshot.currentBody),
    rounds: snapshot.rounds.map((r) => ({
      ...r,
      body: redact(r.body),
      diff: r.diff == null ? r.diff : redact(r.diff),
      outputs: r.outputs.map((o) => ({ ...o, author: null, body: redact(o.body), path: o.path == null ? o.path : redact(o.path) })),
    })),
  };
}

export async function harvestSource(source, { since, run = ghRunner, log = console.log } = {}) {
  const out = resolve(source.out);
  mkdirSync(out, { recursive: true });
  const repos = source.repos === "*" ? await repositories(source.owner, { run }) : source.repos;
  const allRepos = source.visibility === "private" ? await repositories(source.owner, { run }) : [];
  const mapPath = join(out, "id-map.json");
  const idMap = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : {};
  const summary = { source: source.name, repos: {}, incomplete: [] };

  for (const repo of repos) {
    const counts = { prs: 0, withReviews: 0, written: 0, skippedExisting: 0 };
    summary.repos[source.visibility === "private" ? `repo-${Object.keys(summary.repos).length + 1}` : repo] = counts;
    try {
      for await (const pr of pullRequests(source.owner, repo, { since, run })) {
        counts.prs++;
        const snapshot = buildSnapshot(pr, { classify: classifyReviewOutput });
        if (!snapshot.rounds.length) continue;
        counts.withReviews++;
        const id = source.visibility === "private"
          ? privateCaseId(source.key, source.owner, repo, pr.number)
          : `${repo}-${pr.number}`;
        const file = join(out, `${id}.json`);
        if (existsSync(file)) { counts.skippedExisting++; continue; }

        for (const round of snapshot.rounds) {
          if (!snapshot.baseSha || !round.headSha) { round.diff = null; round.diffError = "unknown_sha"; continue; }
          const { diff, error } = await compareDiff(source.owner, repo, snapshot.baseSha, round.headSha, { run });
          round.diff = diff ?? null;
          round.diffError = error ?? null;
        }

        let record = { id, visibility: source.visibility, ...snapshot };
        if (source.visibility === "public") {
          record.source = { owner: source.owner, repo, url: `https://github.com/${source.owner}/${repo}/pull/${pr.number}` };
        } else {
          const identifiers = {
            owners: [source.owner],
            repos: allRepos,
            users: logins(snapshot),
            branches: [snapshot.baseRef, snapshot.headRef].filter((b) => b && !["main", "master", "develop"].includes(b)),
            terms: source.terms ?? [],
          };
          record = redactSnapshot(record, makeRedactor(identifiers));
          const leaks = leakedIdentifiers(JSON.stringify(record), identifiers);
          if (leaks.length) throw new Error(`redaction left ${leaks.length} identifier(s) in ${id}; refusing to write`);
          idMap[id] = { owner: source.owner, repo, number: pr.number };
        }
        writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
        counts.written++;
      }
    } catch (error) {
      summary.incomplete.push({ repo: source.visibility === "private" ? "(private)" : repo, error: String(error.message ?? error).slice(0, 200) });
      log(`incomplete: ${source.visibility === "private" ? "a private repo" : repo}: ${error.message}`);
    }
    if (source.visibility === "private") writeFileSync(mapPath, JSON.stringify(idMap, null, 2) + "\n");
  }
  writeFileSync(join(out, "harvest-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const configPath = flag("--config");
  if (!configPath) throw new Error("Use --config <local-config.json>");
  const config = loadConfig(configPath);
  const only = flag("--only");
  for (const source of config.sources.filter((s) => !only || s.name === only)) {
    const summary = await harvestSource(source, { since: config.since ?? null });
    const totals = Object.values(summary.repos).reduce((a, c) => ({ prs: a.prs + c.prs, withReviews: a.withReviews + c.withReviews, written: a.written + c.written }), { prs: 0, withReviews: 0, written: 0 });
    console.log(`${source.name}: ${totals.prs} PRs scanned, ${totals.withReviews} with review output, ${totals.written} written, ${summary.incomplete.length} incomplete repo(s)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
