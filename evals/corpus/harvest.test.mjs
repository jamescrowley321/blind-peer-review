import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestSource, loadConfig } from "./harvest.mjs";
import { writeFileSync } from "node:fs";

const KEY = "k".repeat(32);
const conn = (nodes) => ({ totalCount: nodes.length, nodes });
const PR = {
  number: 12, title: "feat(acme-billing): export for AcmeCare", body: "Closes acme-health/acme-billing#3. AC-1: export works.",
  createdAt: "2026-10-01T00:00:00Z", mergedAt: null, closedAt: null, state: "OPEN",
  baseRefName: "main", headRefName: "feat/acme-export", author: { login: "jdoe" }, mergeCommit: null,
  userContentEdits: conn([]),
  comments: conn([
    { databaseId: 1, author: { login: "jdoe" }, body: "## Blind peer review — local run — verdict: **BLOCK**\nMUST FIX: @jdoe see https://github.com/acme-health/acme-billing/blob/x in AcmeCareClient and ACMECARE_URL", createdAt: "2026-10-02T00:00:00Z" },
    { databaseId: 2, author: { login: "jdoe" }, body: "thanks", createdAt: "2026-10-03T00:00:00Z" },
  ]),
  reviews: conn([]),
  commits: conn([{ commit: { oid: "aaa111", committedDate: "2026-10-01T01:00:00Z", parents: { nodes: [{ oid: "base000" }] } } }]),
};

function stubGh({ prs = [PR], repos = ["acme-billing", "acme-portal"], isPrivate = false } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "repo") return repos.join("\n") + "\n";
    if (args[1] === "graphql") return JSON.stringify({ data: { repository: { isPrivate, pullRequests: { pageInfo: { hasNextPage: false }, nodes: prs } } } });
    if (args.at(-1).includes("/compare/")) return "diff --git a/src/acme-billing.js b/src/acme-billing.js\n+// owner jdoe@acme.example\n";
    throw new Error(`unexpected gh call ${args.join(" ")}`);
  };
  return { run, calls };
}

test("public harvest keeps attribution and the reviewed diff", async () => {
  const out = mkdtempSync(join(tmpdir(), "corpus-pub-"));
  const { run } = stubGh();
  const summary = await harvestSource({ name: "pub", visibility: "public", owner: "octo", repos: ["acme-billing"], out }, { run, log: () => {} });
  assert.deepEqual(summary.repos["acme-billing"], { prs: 1, withReviews: 1, written: 1, skippedExisting: 0 });
  const record = JSON.parse(readFileSync(join(out, "acme-billing-12.json"), "utf8"));
  assert.equal(record.source.url, "https://github.com/octo/acme-billing/pull/12");
  assert.deepEqual(record.rounds.map((r) => [r.headSha, r.outputs.map((o) => [o.pipeline, o.verdict])]), [["aaa111", [["bpr-summary-comment", "BLOCK"]]]]);
  assert.match(record.rounds[0].diff, /^diff --git/);
});

test("private harvest writes only pseudonymous, redacted records plus a local id map", async () => {
  const out = mkdtempSync(join(tmpdir(), "corpus-priv-"));
  const { run } = stubGh();
  const source = { name: "p", visibility: "private", owner: "acme-health", repos: ["acme-billing"], out, key: KEY, terms: ["AcmeCare"] };
  const summary = await harvestSource(source, { run, log: () => {} });
  assert.deepEqual(Object.keys(summary.repos), ["repo-1"]);
  const files = readdirSync(out).sort();
  const caseFile = files.find((f) => f.startsWith("priv-"));
  assert.ok(caseFile, files.join(","));
  const text = readFileSync(join(out, caseFile), "utf8");
  for (const secret of ["acme-health", "acme-billing", "acme-portal", "jdoe", "AcmeCare", "acme-export", "acme.example", "github.com"]) {
    assert.equal(text.toLowerCase().includes(secret.toLowerCase()), false, `${secret} leaked`);
  }
  const record = JSON.parse(text);
  assert.equal(record.source, undefined);
  assert.equal(record.number, undefined);
  assert.deepEqual(record.rounds[0].outputs.map((o) => o.id), [0]);
  assert.equal(record.rounds[0].flags.includes("redacted_diff"), true);
  const map = JSON.parse(readFileSync(join(out, "id-map.json"), "utf8"));
  assert.deepEqual(Object.values(map), [{ owner: "acme-health", repo: "acme-billing", number: 12 }]);
  assert.equal(readFileSync(join(out, "harvest-summary.json"), "utf8").includes("acme"), false);
});

test("re-running skips cases already written instead of overwriting them", async () => {
  const out = mkdtempSync(join(tmpdir(), "corpus-rerun-"));
  const source = { name: "pub", visibility: "public", owner: "octo", repos: ["acme-billing"], out };
  await harvestSource(source, { run: stubGh().run, log: () => {} });
  const again = await harvestSource(source, { run: stubGh().run, log: () => {} });
  assert.deepEqual(again.repos["acme-billing"], { prs: 1, withReviews: 1, written: 0, skippedExisting: 1 });
});

test("a GitHub failure marks the repo incomplete without naming a private repo", async () => {
  const out = mkdtempSync(join(tmpdir(), "corpus-fail-"));
  const run = async (args) => {
    if (args[0] === "repo") return "acme-billing\n";
    throw Object.assign(new Error(`Command failed: gh ${args.join(" ")}\nHTTP 502 for acme-health/acme-billing`), { stderr: "HTTP 502" });
  };
  const summary = await harvestSource({ name: "p", visibility: "private", owner: "acme-health", repos: ["acme-billing"], out, key: KEY }, { run, log: () => {} });
  assert.deepEqual(summary.incomplete, [{ repo: "(private)", error: "server_error" }]);
  assert.equal(readFileSync(join(out, "harvest-summary.json"), "utf8").includes("acme"), false);
});

test("config rejects private sources without a real key and malformed repo lists", () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-cfg-"));
  const write = (cfg) => { const p = join(dir, `${Math.random()}.json`); writeFileSync(p, JSON.stringify(cfg)); return p; };
  const base = { name: "p", owner: "o", out: dir, repos: "*" };
  assert.throws(() => loadConfig(write({ sources: [{ ...base, visibility: "private", key: "short" }] })), /key of at least 32/);
  assert.throws(() => loadConfig(write({ sources: [{ ...base, visibility: "public", repos: "all" }] })), /repos must be/);
  assert.throws(() => loadConfig(write({ sources: [{ ...base, visibility: "secret" }] })), /visibility/);
  assert.equal(loadConfig(write({ sources: [{ ...base, visibility: "public" }] })).sources.length, 1);
});

test("a public source refuses a repository GitHub reports as private, and lists only public repos", async () => {
  const out = mkdtempSync(join(tmpdir(), "corpus-vis-"));
  const { run, calls } = stubGh({ isPrivate: true });
  const summary = await harvestSource({ name: "pub", visibility: "public", owner: "octo", repos: "*", out }, { run, log: () => {} });
  assert.deepEqual(calls.find((a) => a[0] === "repo").slice(-2), ["--visibility", "public"]);
  assert.deepEqual(summary.incomplete.map((i) => i.error), ["not_public", "not_public"]);
  assert.deepEqual(readdirSync(out), ["harvest-summary.json"]);
});

test("comment-delivered reviews are pinned to the head_sha of the run that posted them", async () => {
  const out = mkdtempSync(join(tmpdir(), "corpus-run-"));
  const runUrl = "https://github.com/octo/acme-billing/actions/runs/99";
  const pr = { ...PR, comments: conn([{ databaseId: 5, author: { login: "github-actions" }, body: `{"lens":"Cold Read","findings":[]}\n[View action run](${runUrl}) | Model: m`, createdAt: "2026-10-02T00:00:00Z" }]) };
  const base = stubGh({ prs: [pr] });
  const run = async (args) => (args[1] === "repos/octo/acme-billing/actions/runs/99" ? "a".repeat(40) + "\n" : base.run(args));
  await harvestSource({ name: "pub", visibility: "public", owner: "octo", repos: ["acme-billing"], out }, { run, log: () => {} });
  const record = JSON.parse(readFileSync(join(out, "acme-billing-12.json"), "utf8"));
  assert.deepEqual(record.rounds.map((r) => [r.headSha, r.flags.includes("sha_inferred")]), [["a".repeat(40), false]]);
});
