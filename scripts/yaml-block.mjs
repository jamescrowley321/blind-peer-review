// yaml-block.mjs — read a `key: |` block scalar out of a workflow file.
//
// Used by the tests that check examples/caller-workflow.yml against the action's
// registry and against its own models_config. Those checks were regexes with a
// hardcoded indentation (`\s{10}`) and a "followed by another input" assumption:
// reformat the example and the pattern matches nothing, the loop body never
// runs, and the test PASSES while checking nothing. A vacuous guard is worse
// than none — it reports coverage it does not have.
//
// This locates the key, then takes every following line indented deeper than it,
// which is what a block scalar IS. It has no opinion about what comes after.
// Callers must still assert the block was non-empty; `null` means "not found",
// never "empty", so the two cannot be confused.

/**
 * @returns {string[]|null} the block's lines, dedented and comment-stripped,
 *   or null when the key has no block scalar.
 */
export function readBlockScalar(yml, key) {
  const lines = String(yml).split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\s*${key}:\\s*\\|\\s*$`).test(l));
  if (at === -1) return null;
  const indent = lines[at].search(/\S/);
  const body = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") { body.push(""); continue; }
    if (l.search(/\S/) <= indent) break;
    body.push(l);
  }
  return body
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
}

/** `<a> = <b>` lines from a block scalar, as [left, right] pairs. */
export function readPairs(yml, key) {
  const rows = readBlockScalar(yml, key);
  if (rows === null) return null;
  return rows
    .map((r) => { const i = r.indexOf("="); return i === -1 ? null : [r.slice(0, i).trim(), r.slice(i + 1).trim()]; })
    .filter(Boolean);
}
