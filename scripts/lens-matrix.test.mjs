// lens-matrix.test.mjs — unit tests for the mode=config matrix resolver.
// Run: node --test scripts/lens-matrix.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatrix, parseList, parseLensModels, readRegistry } from "./lens-matrix.mjs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readBlockScalar } from "./yaml-block.mjs";

const ROOT = join(import.meta.dirname, "..");
const NAMES = readRegistry(ROOT);

const build = (enabled, lensModels = "", defaultModel = "") =>
  buildMatrix({ enabled, lensModels, defaultModel, names: NAMES });

test("the registry is the source of display names", () => {
  // Not a hardcoded table: if manifest.json renames a lens, this follows it.
  assert.equal(NAMES.policy, "Policy & Provenance");
  assert.equal(NAMES.cold_read, "Cold Read");
  assert.ok(Object.keys(NAMES).length >= 5);
});

test("enabled lenses become matrix entries in order", () => {
  const m = build("cold_read\nsecurity");
  assert.deepEqual(m.include.map((i) => i.lens), ["cold_read", "security"]);
  assert.equal(m.include[1].name, NAMES.security);
});

test("comments and blank lines are ignored", () => {
  const m = build("cold_read   # zero context\n\n# owasp_web  disabled\nsecurity\n");
  assert.deepEqual(m.include.map((i) => i.lens), ["cold_read", "security"]);
});

test("no enabled lens is an error, not an empty matrix", () => {
  // An empty matrix means zero review jobs, which the gate then reads as
  // "all expected lenses reported" — a silently disabled review gate.
  assert.throws(() => build("# everything commented out"), /At least one review lens/);
  assert.throws(() => build(""), /At least one review lens/);
});

test("an unknown lens key fails and lists the known ones", () => {
  assert.throws(() => build("cold_read\ncold_reed"), /Unknown review lenses: cold_reed/);
  assert.throws(() => build("cold_reed"), /known:/);
});

test("a lens enabled twice fails", () => {
  // Two entries for one lens post two reviews for it on one commit, and the gate
  // resolves duplicates by latest started_at — so the second decides the verdict.
  assert.throws(() => build("cold_read\nsecurity\ncold_read"), /more than once: cold_read/);
});

test("each lens takes its lens_models entry", () => {
  const m = build("cold_read\nsecurity", "cold_read = anthropic/claude-sonnet-5");
  assert.equal(m.include[0].model, "anthropic/claude-sonnet-5");
});

test("an unlisted lens falls back to default_model", () => {
  const m = build("cold_read\nsecurity", "cold_read = a/b", "c/d");
  assert.equal(m.include[1].model, "c/d");
});

test("no lens_models at all means every lens takes the default", () => {
  const m = build("cold_read\nsecurity", "", "c/d");
  assert.deepEqual([...new Set(m.include.map((i) => i.model))], ["c/d"]);
});

test("no default_model leaves model empty so the action's own default applies", () => {
  const m = build("cold_read");
  assert.equal(m.include[0].model, "");
});

test("lens_models naming an unknown lens fails rather than being skipped", () => {
  // Skipping it would leave that lens on the default while the config claims a
  // tiering that is not in force — the silent-detach failure this guards.
  assert.throws(() => parseLensModels("cold_reed = a/b", NAMES), /unknown lens: cold_reed/);
});

test("a malformed lens_models line fails", () => {
  assert.throws(() => parseLensModels("cold_read", NAMES), /not "<lens> = <model>"/);
  assert.throws(() => parseLensModels("cold_read =", NAMES), /no model for lens/);
});

test("lens_models tolerates spacing and comments", () => {
  const out = parseLensModels("  cold_read   =   a/b   # frontier\n", NAMES);
  assert.deepEqual(out, { cold_read: "a/b" });
});

test("parseList strips comments and trims", () => {
  assert.deepEqual(parseList("a # x\n  b  \n\n#c\n"), ["a", "b"]);
  assert.deepEqual(parseList(undefined), []);
});

test("readRegistry names the file when it cannot be read", () => {
  assert.throws(() => readRegistry("/nonexistent-action-path"), /Could not read the lens registry/);
});

test("every lens the example enables is in the registry", () => {
  // The example is what people copy; an enabled key the registry lost would fail
  // every consumer's config job on their next run, not ours.
  //
  // Read with a block-scalar reader, not a regex with a hardcoded indentation:
  // the earlier pattern assumed 10 spaces and a particular following key, so
  // reformatting the example made it match nothing, the loop body never ran, and
  // this test PASSED while checking nothing.
  const yml = readFileSync(join(ROOT, "examples", "caller-workflow.yml"), "utf8");
  const keys = readBlockScalar(yml, "enabled");
  assert.ok(keys !== null, "example has no `enabled:` block scalar");
  assert.ok(keys.length > 0, "example's `enabled:` block is empty — this test would check nothing");
  for (const key of keys) {
    assert.ok(NAMES[key], `example enables '${key}', which lenses/manifest.json does not define`);
  }
});
