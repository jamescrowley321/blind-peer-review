import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scopeDiff } from "./scope-diff.mjs";

function fixture(t, branch = "main") {
  const repo = mkdtempSync(join(tmpdir(), "bpr-scope-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (name, value) => writeFileSync(join(repo, name), value);
  git("init", "--initial-branch", branch);
  git("config", "user.name", "Offline test");
  git("config", "user.email", "test@example.invalid");
  write("source.txt", "base\n");
  git("add", "."); git("commit", "-m", "base");
  git("checkout", "-b", "feature");
  return { repo, git, write };
}

test("one final patch covers committed, staged, unstaged and untracked changes", (t) => {
  const { repo, git, write } = fixture(t);
  write("committed.txt", "committed branch\n"); git("add", "."); git("commit", "-m", "feature");
  write("staged.txt", "staged change\n"); git("add", "staged.txt");
  write("source.txt", "unstaged change\n");
  write("new source.js", "export const unseen = true;\n");
  mkdirSync(join(repo, ".blind-peer-review/out"), { recursive: true });
  write(".blind-peer-review/out/security.json", "do not review me");
  write(".gitignore", "ignored.js\n"); write("ignored.js", "ignored");
  const scoped = scopeDiff({ repo });
  assert.equal(scoped.base, "main");
  for (const content of ["committed branch", "staged change", "unstaged change", "export const unseen"]) assert.ok(scoped.diff.includes(content), content);
  assert.doesNotMatch(scoped.diff, /do not review me|\+ignored$/m);
  assert.ok(scoped.untracked.includes("new source.js"));
});

test("staged then unstaged edits show the final file version only", (t) => {
  const { repo, git, write } = fixture(t);
  write("source.txt", "intermediate\n"); git("add", "source.txt");
  write("source.txt", "final\n");
  const { diff } = scopeDiff({ repo });
  assert.match(diff, /\+final/); assert.doesNotMatch(diff, /intermediate/);
  assert.equal((diff.match(/diff --git/g) || []).length, 1);
});

test("recorded remote default branch wins over origin/main", (t) => {
  const { repo, git, write } = fixture(t, "trunk");
  git("update-ref", "refs/remotes/origin/trunk", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  write("source.txt", "branch content\n"); git("add", "."); git("commit", "-m", "branch");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const { diff, base } = scopeDiff({ repo });
  assert.equal(base, "refs/remotes/origin/trunk"); assert.match(diff, /branch content/);
});

test("explicit valid base is respected and unresolved or option-like bases fail", (t) => {
  const { repo, write } = fixture(t);
  write("source.txt", "edit\n");
  assert.match(scopeDiff({ repo, base: "main" }).diff, /edit/);
  for (const base of ["unfetched", "--output=bad", ""]) assert.throws(() => scopeDiff({ repo, base }), /explicit base/);
});

test("without a known default the fallback reports exactly its limited scope", (t) => {
  const { repo, git, write } = fixture(t, "trunk");
  write("committed.txt", "excluded committed\n"); git("add", "."); git("commit", "-m", "branch");
  write("source.txt", "working edit\n");
  const scoped = scopeDiff({ repo });
  assert.equal(scoped.base, "HEAD"); assert.match(scoped.warnings[0], /committed branch changes/);
  assert.match(scoped.diff, /working edit/); assert.doesNotMatch(scoped.diff, /excluded committed/);
});

test("clean tree produces empty scope, working-only or untracked-only edits never do", (t) => {
  const { repo, write } = fixture(t);
  assert.equal(scopeDiff({ repo }).diff, "");
  write("new.js", "untracked only\n"); assert.match(scopeDiff({ repo }).diff, /untracked only/);
  rmSync(join(repo, "new.js"));
  write("source.txt", "working only\n"); assert.match(scopeDiff({ repo }).diff, /working only/);
});

test("CLI writes the patch and rerunning does not include its own output", (t) => {
  const { repo, write } = fixture(t);
  write("new.js", "new code\n");
  const cli = fileURLToPath(new URL("./scope-diff.mjs", import.meta.url));
  for (let i = 0; i < 2; i++) {
    const run = spawnSync(process.execPath, [cli, "--repo", repo], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const patch = readFileSync(join(repo, ".blind-peer-review/out/review-diff.patch"), "utf8");
    assert.match(patch, /new code/); assert.doesNotMatch(patch, /review-diff.patch/);
  }
});

test("scope from a nested cwd still includes the whole repository", (t) => {
  const { repo, write } = fixture(t);
  mkdirSync(join(repo, "nested"));
  write("source.txt", "outside nested cwd\n");
  assert.match(scopeDiff({ repo: join(repo, "nested") }).diff, /outside nested cwd/);
});

test("the combined patch applies cleanly to the base tree, including new filenames with spaces", (t) => {
  const { repo, git, write } = fixture(t);
  write("source.txt", "committed\n"); git("add", "."); git("commit", "-m", "feature");
  write("source.txt", "staged\n"); git("add", "."); write("source.txt", "final\n");
  write("new source.js", "new file\n");
  const { diff } = scopeDiff({ repo });
  const target = fixture(t).repo;
  execFileSync("git", ["apply", "--check", "-"], { cwd: target, input: diff });
  execFileSync("git", ["apply", "-"], { cwd: target, input: diff });
  assert.equal(readFileSync(join(target, "source.txt"), "utf8"), "final\n");
  assert.equal(readFileSync(join(target, "new source.js"), "utf8"), "new file\n");
});

test("vendor command ships a runnable scope helper for adapter consumers", (t) => {
  const { repo, write } = fixture(t);
  const vendor = fileURLToPath(new URL("./vendor.mjs", import.meta.url));
  execFileSync(process.execPath, [vendor, "--into", repo]);
  // Vendored files are normally committed. Exclude them to focus on consumer edits.
  write(".gitignore", ".blind-peer-review/vendor/\n");
  write("source.txt", "consumer working edit\n");
  const run = spawnSync(process.execPath, [join(repo, ".blind-peer-review/vendor/scope-diff.mjs")], { cwd: repo, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(join(repo, ".blind-peer-review/out/review-diff.patch"), "utf8"), /consumer working edit/);
});

test("staged deletion with unchanged recreated untracked file produces no final change and leaves the index untouched", (t) => {
  const { repo, git } = fixture(t);
  git("rm", "--cached", "source.txt");
  const stagedBefore = git("diff", "--cached");
  const indexPath = git("rev-parse", "--path-format=absolute", "--git-path", "index");
  const indexBefore = readFileSync(indexPath);
  const scoped = scopeDiff({ repo });
  assert.equal(scoped.diff, "");
  assert.deepEqual(readFileSync(indexPath), indexBefore, "real index bytes remain unchanged");
  assert.deepEqual(scoped.untracked, ["source.txt"]);
  assert.equal(git("diff", "--cached"), stagedBefore);
  assert.equal(git("ls-files"), "");
});

test("staged deletion with modified recreated untracked file emits one applicable final modification", (t) => {
  const { repo, git, write } = fixture(t);
  git("rm", "--cached", "source.txt");
  write("source.txt", "recreated with edits\n");
  const stagedBefore = git("diff", "--cached");
  const { diff } = scopeDiff({ repo });
  assert.equal((diff.match(/diff --git/g) || []).length, 1);
  assert.doesNotMatch(diff, /deleted file mode|new file mode/);
  assert.match(diff, /-base\n\+recreated with edits/);
  const target = fixture(t).repo;
  execFileSync("git", ["apply", "-"], { cwd: target, input: diff });
  assert.equal(readFileSync(join(target, "source.txt"), "utf8"), "recreated with edits\n");
  assert.equal(git("diff", "--cached"), stagedBefore);
});

test("committed deletion with recreated untracked file and split index still produces a final modification", (t) => {
  const { repo, git, write } = fixture(t);
  git("rm", "source.txt"); git("commit", "-m", "delete source");
  // Keep another tracked entry so Git can create a genuine split index.
  write("other.txt", "other\n"); git("add", "other.txt"); git("commit", "-m", "other");
  git("update-index", "--split-index");
  write("source.txt", "recreated\n");
  const { diff } = scopeDiff({ repo });
  assert.equal((diff.match(/diff --git a\/source.txt/g) || []).length, 1);
  assert.match(diff, /-base\n\+recreated/);
  assert.match(diff, /other/);
  assert.equal(git("ls-files"), "other.txt");
});

test("a repository root ending in a space retains its exact path", (t) => {
  const { repo, git, write } = fixture(t);
  const spaced = `${repo} `;
  // Rename the fixture; register the new location because its original cleanup
  // path is now absent.
  renameSync(repo, spaced);
  t.after(() => rmSync(spaced, { recursive: true, force: true }));
  writeFileSync(join(spaced, "source.txt"), "edit\n");
  const scoped = scopeDiff({ repo: spaced });
  assert.equal(scoped.root, spaced);
  assert.match(scoped.diff, /\+edit/);
});

test("recreated tracked filenames containing Git pathspec magic are treated literally", (t) => {
  const { repo, git, write } = fixture(t);
  const name = ":(bogus)source.txt";
  write(name, "original\n");
  git("--literal-pathspecs", "add", "--", name); git("commit", "-m", "magic-looking filename");
  git("--literal-pathspecs", "rm", "--cached", "--", name);
  write(name, "recreated\n");
  const { diff } = scopeDiff({ repo, base: "HEAD" });
  assert.match(diff, /-original\n\+recreated/);
  assert.equal((diff.match(/diff --git/g) || []).length, 1);
});

test("scope CLI refuses symlink output files/directories and preserves Git metadata targets", (t) => {
  const cli = fileURLToPath(new URL("./scope-diff.mjs", import.meta.url));
  for (const kind of ["file", "directory"]) {
    const { repo, write } = fixture(t);
    write("source.txt", "edit\n");
    const metadata = join(repo, ".git/config");
    const before = readFileSync(metadata);
    mkdirSync(join(repo, ".blind-peer-review"));
    if (kind === "file") {
      mkdirSync(join(repo, ".blind-peer-review/out"));
      symlinkSync("../../.git/config", join(repo, ".blind-peer-review/out/review-diff.patch"));
    } else {
      symlinkSync("../.git", join(repo, ".blind-peer-review/out"));
    }
    const run = spawnSync(process.execPath, [cli, "--repo", repo], { encoding: "utf8" });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /refusing symlink/);
    assert.deepEqual(readFileSync(metadata), before);
    assert.equal(existsSync(join(repo, ".git/review-diff.patch")), false);
  }
});

test("scope CLI accepts deliberate regular --out paths and rejects direct Git metadata destinations", (t) => {
  const { repo, write } = fixture(t);
  write("source.txt", "edit\n");
  const cli = fileURLToPath(new URL("./scope-diff.mjs", import.meta.url));
  const output = join(repo, "custom/review.patch");
  const success = spawnSync(process.execPath, [cli, "--repo", repo, "--out", output], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.match(readFileSync(output, "utf8"), /\+edit/);
  const metadata = join(repo, ".git/config");
  const before = readFileSync(metadata);
  const rejected = spawnSync(process.execPath, [cli, "--repo", repo, "--out", metadata], { encoding: "utf8" });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Git metadata/);
  assert.deepEqual(readFileSync(metadata), before);
});
