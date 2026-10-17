// Offline helper and executable CLI regression tests (stub codex; no model calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chooseLenses, personaPath, adjudicate, resolveReviewer, readConfig, reviewerArgv, unfence, failure, onPath } from "./dispatch.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("../lenses/manifest.json", import.meta.url), "utf8"),
);

// ── which lenses run ──

test("with no --lens, runs exactly the manifest's default set", () => {
  // Read from the shipped manifest, not restated: a lens flipped to
  // default_enabled must change this without anyone editing the test.
  const expected = manifest.lenses.filter((l) => l.default_enabled).map((l) => l.key);
  assert.deepEqual(chooseLenses(manifest, null), expected);
  assert.ok(expected.length >= 5, "the default set collapsed");
});

test("opt-in lenses are not run by default", () => {
  const defaults = chooseLenses(manifest, null);
  for (const l of manifest.lenses.filter((x) => !x.default_enabled)) {
    assert.ok(!defaults.includes(l.key), `${l.key} is opt-in but ran by default`);
  }
});

test("--lens selects exactly what was asked for, in order", () => {
  assert.deepEqual(chooseLenses(manifest, "security,cold_read"), ["security", "cold_read"]);
});

test("--lens tolerates whitespace and empty entries", () => {
  assert.deepEqual(chooseLenses(manifest, " security , , cold_read "), ["security", "cold_read"]);
});

test("duplicate requested lenses run only once", () => {
  assert.deepEqual(chooseLenses(manifest, "security,security"), ["security"]);
});

test("an unknown lens is refused by name, not silently skipped", () => {
  // Silently dropping it would run a smaller review than the caller asked for
  // and still report PASS.
  assert.throws(() => chooseLenses(manifest, "security,nope"), /unknown lens\(es\): nope/);
});

test("a --lens value that selects nothing is an error", () => {
  assert.throws(() => chooseLenses(manifest, " , "), /no lenses selected/);
});

// ── which persona each lens gets ──

test("a repo-local override wins over the base persona", () => {
  const p = personaPath("/repo", "/vendor/lenses", "security", (f) => f === "/repo/.blind-peer-review/lenses/security.md");
  assert.equal(p, "/repo/.blind-peer-review/lenses/security.md");
});

test("without an override, the base persona is used", () => {
  const p = personaPath("/repo", "/vendor/lenses", "security", () => false);
  assert.equal(p, "/vendor/lenses/security.md");
});

test("an override for a DIFFERENT lens does not capture this one", () => {
  const p = personaPath("/repo", "/vendor/lenses", "security", (f) => f === "/repo/.blind-peer-review/lenses/red_team.md");
  assert.equal(p, "/vendor/lenses/security.md");
});

// ── the verdict fails closed ──

const ok = (key, findings) => ({ key, ok: true, result: { lens: key, summary: "", findings } });
const must = { severity: "MUST FIX", location: "a.ts:1", detail: "d", recommendation: "r" };
const should = { severity: "SHOULD FIX", location: "a.ts:2", detail: "d", recommendation: "r" };

test("no findings anywhere is a PASS", () => {
  const { blocked, rows } = adjudicate([ok("a", []), ok("b", [])]);
  assert.equal(blocked, false);
  assert.deepEqual(rows.map((r) => r.verdict), ["PASS", "PASS"]);
});

test("one MUST FIX blocks the whole run", () => {
  const { blocked, rows } = adjudicate([ok("a", []), ok("b", [must])]);
  assert.equal(blocked, true);
  assert.deepEqual(rows.map((r) => r.verdict), ["PASS", "BLOCK"]);
});

test("SHOULD FIX and NITPICK do not block", () => {
  const { blocked } = adjudicate([ok("a", [should])]);
  assert.equal(blocked, false);
});

test("a lens that could not be read FAILS, and failing blocks", () => {
  // A review nobody could read has not passed.
  const { blocked, rows } = adjudicate([{ key: "a", ok: false, why: "not JSON" }]);
  assert.equal(blocked, true);
  assert.equal(rows[0].verdict, "FAILED");
  assert.match(rows[0].note, /not JSON/);
});

test('a lens whose summary merely says "no MUST FIX findings" still passes', () => {
  // The verdict reads the parsed severity field. Substring-matching the prose
  // would turn this clean review into a block.
  const r = ok("a", []);
  r.result.summary = "No MUST FIX findings in this diff.";
  assert.equal(adjudicate([r]).blocked, false);
});

test("a finding whose DETAIL quotes the words MUST FIX does not block on its own", () => {
  const r = ok("a", [{ ...should, detail: 'The diff text literally says "MUST FIX" here.' }]);
  assert.equal(adjudicate([r]).blocked, false);
});

test("MUST FIX findings are surfaced, not just counted", () => {
  const { rows } = adjudicate([ok("a", [must, should])]);
  assert.deepEqual(rows[0].mustFix, [must]);
});

test("a missing findings array fails closed rather than passing", () => {
  const { blocked, rows } = adjudicate([{ key: "a", ok: true, result: { lens: "a", summary: "" } }]);
  assert.equal(blocked, true);
  assert.equal(rows[0].verdict, "FAILED");
  assert.match(rows[0].note, /findings/);
});

// ── the schema the dispatch enforces ──

test("the contract schema requires the fields the adjudicator reads", () => {
  const schema = JSON.parse(readFileSync(new URL("../contracts/review.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.required.sort(), ["findings", "lens", "summary"]);
  const f = schema.properties.findings.items;
  assert.deepEqual(f.required.sort(), ["detail", "location", "recommendation", "severity"]);
  assert.deepEqual(f.properties.severity.enum, ["MUST FIX", "SHOULD FIX", "NITPICK"]);
  // additionalProperties:false is what stops a lens smuggling prose alongside
  // the object and calling it a review.
  assert.equal(schema.additionalProperties, false);
  assert.equal(f.additionalProperties, false);
});


test("an empty result set cannot pass", () => {
  assert.throws(() => adjudicate([]), /no lenses/);
});

const cliPath = fileURLToPath(new URL("./dispatch.mjs", import.meta.url));
function cli(t, result, args = [], { fail = false, missing = false, raw = false, override = false, symlinkResult = false, symlinkDir = false,
  reviewer = "codex", env = {}, repoConfig = null, userConfig = null } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "bpr-dispatch-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "bin"));
  writeFileSync(join(repo, "diff.patch"), "diff --git a/x b/x\n");
  const capture = join(repo, "prompt.txt");
  const payload = raw ? result : JSON.stringify(result);
  writeFileSync(join(repo, "bin", "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("stub codex"); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => prompt += data);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capture)}, prompt);
  if (${fail}) process.exit(7);
  const path = process.argv[process.argv.indexOf("--output-last-message") + 1];
  if (!${missing}) fs.writeFileSync(path, ${JSON.stringify(payload)});
});
`, { mode: 0o755 });
  // pi and an arbitrary agent CLI print the review on stdout and record argv.
  for (const bin of ["pi", "my-agent"]) {
    writeFileSync(join(repo, "bin", bin), `#!/usr/bin/env node
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => prompt += data);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capture)}, prompt);
  fs.writeFileSync(${JSON.stringify(join(repo, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
  if (${fail}) process.exit(7);
  process.stdout.write(${JSON.stringify(payload)});
});
`, { mode: 0o755 });
  }
  if (repoConfig) {
    mkdirSync(join(repo, ".blind-peer-review"), { recursive: true });
    writeFileSync(join(repo, ".blind-peer-review/config.json"), JSON.stringify(repoConfig));
  }
  if (userConfig) {
    mkdirSync(join(repo, "xdg/blind-peer-review"), { recursive: true });
    writeFileSync(join(repo, "xdg/blind-peer-review/config.json"), JSON.stringify(userConfig));
  }
  if (override) {
    mkdirSync(join(repo, ".blind-peer-review/lenses"), { recursive: true });
    writeFileSync(join(repo, ".blind-peer-review/lenses/security.md"), "UNIQUE LOCAL OVERRIDE");
  }
  if (symlinkResult || symlinkDir) {
    writeFileSync(join(repo, "untouched.txt"), "original target");
    if (symlinkDir) { mkdirSync(join(repo, ".blind-peer-review"), { recursive: true }); symlinkSync(repo, join(repo, ".blind-peer-review/out")); }
    else {
      mkdirSync(join(repo, ".blind-peer-review/out"), { recursive: true });
      symlinkSync(join(repo, "untouched.txt"), join(repo, ".blind-peer-review/out/security.json"));
    }
  }
  const base = { ...process.env };
  for (const k of ["BPR_REVIEWER", "BPR_MODEL", "BPR_REVIEWER_CMD"]) delete base[k];
  const run = spawnSync(process.execPath, [cliPath, "--repo", repo, "--diff", "diff.patch", "--lens", "security",
    ...(reviewer ? ["--reviewer", reviewer] : []), ...args], {
    encoding: "utf8",
    env: { ...base, XDG_CONFIG_HOME: join(repo, "xdg"), PATH: `${join(repo, "bin")}:${process.env.PATH}`, ...env },
    timeout: 10_000,
  });
  return { ...run, repo, capture };
}
const clean = { lens: "Security Review", summary: "No MUST FIX findings", findings: [] };

test("executable CLI refuses empty lens selection before invoking codex", (t) => {
  for (const value of [" , ", ""]) {
    const run = cli(t, clean, ["--lens", value]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no lenses selected/);
    assert.doesNotMatch(run.stdout, /Verdict: PASS/);
    assert.throws(() => readFileSync(run.capture));
  }
});

test("executable CLI rejects missing option values", (t) => {
  const run = cli(t, clean, ["--lens"]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--lens requires a value/);
});

test("executable CLI reads local persona override and valid clean reviews pass", (t) => {
  const run = cli(t, clean, [], { override: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Verdict: PASS/);
  assert.match(readFileSync(run.capture, "utf8"), /UNIQUE LOCAL OVERRIDE/);
  assert.deepEqual(JSON.parse(readFileSync(join(run.repo, ".blind-peer-review/out/security.json"))), clean);
  assert.match(readFileSync(join(run.repo, ".blind-peer-review/out/review-summary.md"), "utf8"), /Verdict: \*\*PASS\*\*/);
  assert.equal(JSON.parse(readFileSync(join(run.repo, ".blind-peer-review/out/review-summary.json"))).lenses[0].verdict, "PASS");
});

test("executable CLI blocks real MUST FIX fields but passes SHOULD FIX prose", (t) => {
  const blocking = cli(t, { ...clean, findings: [must] });
  assert.equal(blocking.status, 1);
  assert.match(blocking.stdout, /Verdict: BLOCK/);
  const report = JSON.parse(readFileSync(join(blocking.repo, ".blind-peer-review/out/review-summary.json")));
  assert.equal(report.verdict, "BLOCK");
  assert.equal(report.groups[0].issues[0].severity, "MUST FIX");
  assert.match(blocking.stdout, /MUST FIX  \[Security Review\]/);
  const advisory = cli(t, { ...clean, findings: [{ ...should, detail: "No MUST FIX findings" }] });
  assert.equal(advisory.status, 0);
});

test("executable CLI fails closed on malformed contract objects", (t) => {
  const invalid = [null, {}, { ...clean, findings: null }, { ...clean, findings: [null] },
    { ...clean, findings: [{ ...must, severity: "must fix" }] },
    { ...clean, findings: [{ ...must, detail: "" }] },
    { ...clean, findings: [{ ...must, location: 3 }] },
    { ...clean, lens: "Cold Read" }, { ...clean, summary: false }, { ...clean, extra: "ignored?" }];
  for (const result of invalid) {
    const run = cli(t, result);
    assert.equal(run.status, 1, `${JSON.stringify(result)}: ${run.stderr}`);
    assert.match(run.stdout, /FAILED/);
    const report = JSON.parse(readFileSync(join(run.repo, ".blind-peer-review/out/review-summary.json")));
    assert.equal(report.verdict, "BLOCK");
    assert.equal(report.lenses[0].verdict, "FAILED");
    assert.match(run.stdout, /Verdict: BLOCK/);
  }
});

test("executable CLI fails closed on process failure, missing output and invalid JSON", (t) => {
  for (const options of [{ fail: true }, { missing: true }, { raw: true }]) {
    const run = cli(t, options.raw ? "not JSON" : clean, [], options);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAILED/);
    const report = JSON.parse(readFileSync(join(run.repo, ".blind-peer-review/out/review-summary.json")));
    assert.equal(report.verdict, "BLOCK");
    assert.equal(report.lenses[0].verdict, "FAILED");
    assert.match(run.stdout, /Verdict: BLOCK/);
  }
});


test("executable codex dispatcher rejects generated artifact symlinks and leaves targets unchanged", (t) => {
  for (const options of [{ symlinkResult: true }, { symlinkDir: true }]) {
    const run = cli(t, clean, [], options);
    assert.equal(run.status, options.symlinkDir ? 2 : 1);
    assert.equal(readFileSync(join(run.repo, "untouched.txt"), "utf8"), "original target");
    assert.ok((run.stderr + run.stdout).includes("refusing symlink"));
    assert.equal(existsSync(run.capture), false, "no reviewer launched for unsafe artifact paths");
  }
});

// ── who reviews ──

test("with nothing configured, the reviewer is host — never whatever is installed", () => {
  assert.deepEqual(resolveReviewer({}), { reviewer: "host", source: "default", model: null });
});

test("precedence: flag, then BPR_REVIEWER, then repo config, then user config", () => {
  const repoConfig = { reviewer: "pi" };
  const userConfig = { reviewer: "codex" };
  const env = { BPR_REVIEWER: "command", BPR_REVIEWER_CMD: '["x"]' };
  assert.equal(resolveReviewer({ flag: "host", env, repoConfig, userConfig }).source, "--reviewer");
  assert.equal(resolveReviewer({ env, repoConfig, userConfig }).source, "BPR_REVIEWER");
  assert.equal(resolveReviewer({ repoConfig, userConfig }).reviewer, "pi");
  assert.equal(resolveReviewer({ userConfig }).reviewer, "codex");
});

test("the model follows the layer that chose the reviewer unless set explicitly", () => {
  const repoConfig = { reviewer: "codex", model: "gpt-x" };
  assert.equal(resolveReviewer({ repoConfig }).model, "gpt-x");
  // A codex model from the repo must not be handed to pi chosen by the flag.
  assert.equal(resolveReviewer({ flag: "pi", repoConfig }).model, null);
  assert.equal(resolveReviewer({ flag: "pi", model: "glm", repoConfig }).model, "glm");
  assert.equal(resolveReviewer({ flag: "pi", env: { BPR_MODEL: "kimi" } }).model, "kimi");
});

test("an unknown reviewer is refused, naming where it came from", () => {
  assert.throws(() => resolveReviewer({ repoConfig: { reviewer: "gemini" } }), /unknown reviewer "gemini" \(from repo config\)/);
});

test("the repo config can never supply a command", () => {
  // Reviewing someone else's branch must not run a program that branch chose.
  assert.throws(() => resolveReviewer({ repoConfig: { command: ["sh", "-c", "evil"] } }), /repo config may not set "command"/);
});

test("the command reviewer takes its argv from BPR_REVIEWER_CMD or the user config", () => {
  assert.deepEqual(resolveReviewer({ flag: "command", userConfig: { command: ["agent", "-p"] } }).command, ["agent", "-p"]);
  assert.deepEqual(resolveReviewer({ flag: "command", env: { BPR_REVIEWER_CMD: '["a"]' }, userConfig: { command: ["b"] } }).command, ["a"]);
  assert.throws(() => resolveReviewer({ flag: "command" }), /needs a command/);
  assert.throws(() => resolveReviewer({ flag: "command", env: { BPR_REVIEWER_CMD: "agent -p" } }), /JSON array/);
  assert.throws(() => resolveReviewer({ flag: "command", userConfig: { command: [] } }), /nonempty array/);
});

test("a malformed config file is an error, not silently ignored", () => {
  const read = (body) => () => body;
  assert.equal(readConfig("/x", () => false), null);
  assert.throws(() => readConfig("/x", () => true, read("{")), /not valid JSON/);
  assert.throws(() => readConfig("/x", () => true, read("[]")), /JSON object/);
  assert.throws(() => readConfig("/x", () => true, read('{"reviewr":"pi"}')), /unknown key\(s\): reviewr/);
});

test("pi runs with read-only tools and none of the repo's agent setup", () => {
  const [bin, args] = reviewerArgv({ reviewer: "pi", model: "glm" }, {});
  assert.equal(bin, "pi");
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
  for (const flag of ["-p", "--no-session", "--no-context-files", "--no-skills", "--no-extensions", "--no-mcp", "--no-approve"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.equal(args[args.indexOf("--model") + 1], "glm");
});

test("codex keeps its read-only sandbox and schema, and takes a model", () => {
  const [, args] = reviewerArgv({ reviewer: "codex", model: "m" }, { schemaPath: "/s.json", lastMsg: "/l" });
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args[args.indexOf("--output-schema") + 1], "/s.json");
  assert.equal(args[args.indexOf("--model") + 1], "m");
  assert.equal(args.at(-1), "-");
});

test("executable CLI with no reviewer configured does not dispatch, even with codex installed", (t) => {
  const run = cli(t, clean, [], { reviewer: null });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /reviewer is host \(from default\)/);
  assert.equal(existsSync(run.capture), false);
});

test("executable CLI --print-reviewer reports the resolved reviewer", (t) => {
  assert.equal(cli(t, clean, ["--print-reviewer"], { reviewer: null }).stdout.trim(), "host");
  assert.equal(cli(t, clean, ["--print-reviewer"], { reviewer: null, repoConfig: { reviewer: "pi" } }).stdout.trim(), "pi");
  assert.equal(cli(t, clean, ["--print-reviewer"], { reviewer: null, env: { BPR_REVIEWER: "codex" }, repoConfig: { reviewer: "pi" } }).stdout.trim(), "codex");
});

test("executable CLI dispatches to pi from the repo config and passes the model", (t) => {
  const run = cli(t, clean, [], { reviewer: null, repoConfig: { reviewer: "pi", model: "z-ai/glm-5.2" } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Verdict: PASS/);
  assert.match(run.stdout, /Reviewed out-of-host by pi \(z-ai\/glm-5.2\) \(reviewer from repo config\)/);
  const argv = JSON.parse(readFileSync(join(run.repo, "argv.json"), "utf8"));
  assert.equal(argv[argv.indexOf("--model") + 1], "z-ai/glm-5.2");
  assert.match(readFileSync(run.capture, "utf8"), /YOUR PERSONA/);
});

test("executable CLI dispatches to a user-configured command and fails closed on its output", (t) => {
  const userConfig = { reviewer: "command", command: ["my-agent", "--print"] };
  const pass = cli(t, clean, [], { reviewer: null, userConfig });
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(pass.repo, "argv.json"), "utf8")), ["--print"]);
  const prose = cli(t, "Looks good to me!", [], { reviewer: null, userConfig, raw: true });
  assert.equal(prose.status, 1);
  assert.match(prose.stdout, /FAILED/);
  const crashed = cli(t, clean, [], { reviewer: null, userConfig, fail: true });
  assert.equal(crashed.status, 1);
  assert.match(crashed.stdout, /command failed/);
});

test("executable CLI refuses a command from the repo config before running anything", (t) => {
  const run = cli(t, clean, [], { reviewer: null, repoConfig: { reviewer: "command", command: ["my-agent"] } });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /repo config may not set "command"/);
  assert.equal(existsSync(run.capture), false);
});

test("executable CLI fails loudly when the chosen reviewer is not installed", (t) => {
  const run = cli(t, clean, [], { reviewer: "command", env: { BPR_REVIEWER_CMD: '["no-such-agent-xyz"]' } });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /`no-such-agent-xyz` is not on PATH/);
});

test("a fence wrapping the whole output is stripped; prose around one is not", () => {
  assert.equal(unfence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unfence('\n```\n{"a":1}\n```\n'), '{"a":1}');
  assert.equal(unfence('Here you go:\n```json\n{"a":1}\n```'), 'Here you go:\n```json\n{"a":1}\n```');
  assert.equal(unfence('```json\n{}\n```\nand\n```json\n{}\n```'), '```json\n{}\n```\nand\n```json\n{}\n```');
});

test("a failed reviewer reports how it failed and its last stderr line", () => {
  assert.equal(failure({ code: 1, stderr: "warn\nNo API key for provider\n" }), "exit 1: No API key for provider");
  assert.equal(failure({ killed: true, signal: "SIGTERM", stderr: "" }), "killed (SIGTERM)");
});

test("executable CLI accepts a fenced object from a stdout reviewer", (t) => {
  const run = cli(t, "```json\n" + JSON.stringify(clean) + "\n```", [], { reviewer: "pi", raw: true });
  assert.equal(run.status, 0, run.stdout);
});

test("a relative reviewer path resolves from the repo the reviewer runs in", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "bpr-onpath-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "tools"));
  writeFileSync(join(repo, "tools", "agent"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(onPath("./tools/agent", repo, ""), true);
  assert.equal(onPath("agent", repo, "tools"), true);
  assert.equal(onPath("./tools/agent", tmpdir(), ""), false);
});
