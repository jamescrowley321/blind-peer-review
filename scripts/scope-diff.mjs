#!/usr/bin/env node
// Scope a local review: branch changes, staged/unstaged edits, and nonignored
// untracked files. Usage: node scope-diff.mjs [--base <ref>] [--repo <dir>]
//                                          [--out <patch>] (default: .blind-peer-review/out/review-diff.patch)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import outputTools from "./safe-output.cjs";
const { writeOutput } = outputTools;

const LIMIT = 64 * 1024 * 1024;

export function scopeDiff({ repo = process.cwd(), base = null, out = ".blind-peer-review/out/review-diff.patch" } = {}) {
  const git = (args, extraEnv = {}) => execFileSync("git", args, { cwd: repo, env: { ...process.env, ...extraEnv }, encoding: "utf8", maxBuffer: LIMIT, stdio: ["ignore", "pipe", "pipe"] });
  const root = git(["rev-parse", "--show-toplevel"]).replace(/\n$/, "");
  repo = root;
  const warnings = [];
  const commit = (ref) => {
    if (typeof ref !== "string" || !ref || ref.startsWith("-")) throw new Error("base must be a nonempty Git ref, not an option");
    return git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  };
  const head = commit("HEAD");
  let baseCommit;
  if (base !== null) {
    try { baseCommit = commit(base); }
    catch { throw new Error(`cannot resolve explicit base ${JSON.stringify(base)}; fetch it or choose another --base`); }
  } else {
    let remoteDefault;
    try { remoteDefault = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim(); } catch { /* no remote default recorded */ }
    for (const candidate of [...new Set([remoteDefault, "origin/main", "origin/master", "main", "master"].filter(Boolean))]) {
      try { baseCommit = commit(candidate); base = candidate; break; } catch { /* try the next known default */ }
    }
    if (!baseCommit) {
      base = "HEAD";
      baseCommit = head;
      warnings.push("No default branch is available; scope includes working edits only. Pass --base to include committed branch changes.");
    }
  }
  let mergeBase;
  try { mergeBase = git(["merge-base", baseCommit, head]).trim(); }
  catch { throw new Error(`base ${JSON.stringify(base)} shares no merge base with HEAD`); }
  const outputPath = resolve(root, out);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ":(exclude).blind-peer-review/out"])
    .split("\0").filter(Boolean).filter((path) => resolve(root, path) !== outputPath);
  const basePaths = new Set(git(["ls-tree", "-r", "--name-only", "-z", mergeBase]).split("\0"));
  const recreated = untracked.filter((path) => basePaths.has(path));
  const diffArgs = ["-c", "color.ui=false", "diff", "--no-ext-diff", "--no-textconv", "--binary", mergeBase, "--", ".", ":(exclude).blind-peer-review/out"];
  let diff;
  if (recreated.length) {
    // A staged deletion can leave its final working file untracked. Mark those
    // paths in a PRIVATE index so Git compares their final contents with the
    // base, instead of emitting a deletion followed by an unrelated addition.
    // Copying the index preserves sparse/skip-worktree flags and staged state;
    // the real index and the user's working files remain untouched.
    const scratch = mkdtempSync(join(tmpdir(), "bpr-scope-index-"));
    const indexEnv = { GIT_INDEX_FILE: join(scratch, "index") };
    try {
      const indexPath = git(["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
      if (existsSync(indexPath)) copyFileSync(indexPath, indexEnv.GIT_INDEX_FILE);
      else git(["read-tree", "HEAD"], indexEnv);
      git(["update-index", "--no-split-index"], indexEnv);
      git(["--literal-pathspecs", "add", "--intent-to-add", "--", ...recreated], indexEnv);
      diff = git(diffArgs, indexEnv);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } else {
    diff = git(diffArgs);
  }
  // Newly created paths absent from the base are represented as additions.
  for (const path of untracked.filter((path) => !basePaths.has(path))) {
    const result = spawnSync("git", ["-c", "color.ui=false", "diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-index", "--", "/dev/null", path], {
      cwd: root, encoding: "utf8", maxBuffer: LIMIT,
    });
    // --no-index exits 1 when it successfully found a difference.
    if (result.error || ![0, 1].includes(result.status)) throw new Error(`cannot diff untracked file ${JSON.stringify(path)}: ${result.error?.message || result.stderr}`);
    diff += result.stdout;
  }
  return { diff, base, mergeBase, warnings, untracked, root, outputPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (!["--base", "--repo", "--out"].includes(key)) throw new Error(`unknown argument ${JSON.stringify(key)}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
      options[key.slice(2)] = value;
    }
    const scoped = scopeDiff(options);
    writeOutput(scoped.outputPath, scoped.diff);
    for (const warning of scoped.warnings) console.error(`scope-diff: warning: ${warning}`);
    console.log(`Scope: merge base with ${scoped.base} through working tree, including ${scoped.untracked.length} untracked file(s).`);
    console.log(scoped.diff ? `Patch: ${scoped.outputPath}` : "No changes in scope — nothing to review.");
  } catch (e) {
    console.error(`scope-diff: ${e.message}`);
    process.exitCode = 2;
  }
}
