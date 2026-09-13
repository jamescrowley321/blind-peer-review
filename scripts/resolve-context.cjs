// Resolve the effective PR number and this lens's display name.
//
// Extracted from action.yml's inline `run:` block (shell: node {0}). Same split
// as scripts/models-config.mjs: the logic is a file that can be read, diffed and
// tested as code, and action.yml runs it in one line.
//
// Reads its inputs from `env` rather than process.env so a test supplies them
// directly. The CLI entrypoint at the bottom is what the action invokes.

function run({ env }) {
  const fs = require("fs");
  const path = require("path");
  const append = (k, v) => fs.appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);
  // Throws rather than calling process.exit: the action's CLI entrypoint turns
  // this into the same ::error:: line and exit 1 it always produced, while a
  // test that drives the module in-process gets an exception instead of having
  // its own runner killed mid-suite.
  const die = (m) => { console.log(`::error::${m}`); throw new Error(m); };

  // Lens display names come from the registry, not a copy of it. This table
  // used to be hand-maintained here, in the lint workflow, in the eval
  // harness and in every consumer workflow — five lists that a comment
  // asked you to keep in sync. lenses/manifest.json is the one list now.
  const registryPath = path.join(env.ACTION_PATH, "lenses", "manifest.json");
  let NAMES;
  try {
    NAMES = Object.fromEntries(
      JSON.parse(fs.readFileSync(registryPath, "utf8")).lenses.map((l) => [l.key, l.name]),
    );
  } catch (e) {
    die(`Could not read the lens registry at ${registryPath}: ${e.message}`);
  }

  const pr = (env.IN_PR || "").trim() || (env.EVENT_PR || "").trim();
  if (!pr) die("No PR number (not a pull_request event and pr_number unset)");
  append("pr_number", pr);

  if (env.IN_MODE === "lens") {
    const key = (env.IN_LENS || "").trim();
    const name = NAMES[key];
    if (!name) die(`Unknown lens '${key}' (expected ${Object.keys(NAMES).join("|")})`);
    if (!(env.IN_KEY || "").trim()) {
      die("api_key is required for mode: lens — pass your repo's provider key (e.g. secrets.OPENROUTER_API_KEY) as 'api_key'. The action never falls back to any other key.");
    }
    append("lens_name", name);
  }

  // Gate: pipe-separated display names from the expected keys.
  //
  // The input is JSON, and it is meant to be the very object that built the
  // caller's matrix — so "the gate's expected set" and "the jobs that ran"
  // are one value rather than two that a comment asks you to keep in sync.
  // A delimited string was the old shape; splitting a list on a character
  // that can occur inside a value is how a preflight once waited out its
  // whole timeout for three checks that never existed.
  let parsed;
  const raw = (env.IN_LENSES || "").trim();
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    die(`lenses must be JSON — the matrix object or an array of keys. Got: ${raw.slice(0, 120)}`);
  }
  const keys = Array.isArray(parsed)
    ? parsed.map((v) => (typeof v === "string" ? v : v && v.lens))
    : Array.isArray(parsed && parsed.include)
      ? parsed.include.map((e) => e && e.lens)
      : die(`lenses JSON must be an array or a matrix object with "include". Got: ${raw.slice(0, 120)}`);
  if (!keys.length || keys.some((k) => typeof k !== "string" || !k)) {
    die(`lenses JSON produced no usable lens keys. Got: ${raw.slice(0, 120)}`);
  }
  const expected = keys.map((k) => NAMES[k] || die(`Unknown lens key '${k}' in lenses input`));
  append("expected", expected.join("|"));
}

module.exports = { run };

if (require.main === module) {
  try {
    run({ env: process.env });
  } catch {
    // die() has already emitted the ::error:: annotation; exit is the only part
    // a module cannot do on a caller's behalf.
    process.exit(1);
  }
}
