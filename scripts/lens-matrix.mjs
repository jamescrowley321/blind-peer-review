// lens-matrix.mjs — resolve the enabled lens set (and each lens's model) into
// the job matrix the caller's review job fans out over. `mode: config`.
//
// This lives in the action, not in the caller's workflow, for two reasons.
//
// 1. The caller's config job used to carry ~60 lines of inline Node, so every
//    consumer pasted a copy and none of them could be tested or fixed centrally.
// 2. That copy hardcoded a lens key -> display name table. lenses/manifest.json
//    is the one list — action.yml is forbidden from growing a second copy by a
//    lint check written after the registry sat wrong ("Compliance" for the policy
//    lens) through a whole release. The example carried exactly the duplicate
//    that check exists to prevent, just outside its reach.
//
// Env in:  ACTION_PATH, ENABLED, LENS_MODELS, DEFAULT_MODEL, GITHUB_OUTPUT
// Out:     matrix={"include":[{lens,name,model}, ...]}

import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/** key -> display name, from the shipped registry. */
export function readRegistry(actionPath) {
  const p = join(actionPath, "lenses", "manifest.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`Could not read the lens registry at ${p}: ${e.message}`);
  }
  // Valid JSON that is not a registry (`{}`, an array, a renamed key) would
  // otherwise surface as "Cannot read properties of undefined (reading 'map')",
  // which names neither the file nor what is wrong with it.
  if (!Array.isArray(parsed?.lenses)) {
    throw new Error(`The lens registry at ${p} has no "lenses" array`);
  }
  const bad = parsed.lenses.filter((l) => !l?.key || !l?.name);
  if (bad.length) {
    throw new Error(`The lens registry at ${p} has ${bad.length} entr(y/ies) missing "key" or "name"`);
  }
  return Object.fromEntries(parsed.lenses.map((l) => [l.key, l.name]));
}

/** One item per line, `#` comments stripped. */
export function parseList(raw) {
  return String(raw || "")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
}

/**
 * `<lens> = <model>` per line.
 *
 * An unknown lens key is an ERROR, not a skip. Ignoring it would leave the lens
 * quietly running on the default while the config claims a tiering that is not
 * in force — the same class of silent-detach as routing overrides keyed to a
 * model nobody runs.
 */
export function parseLensModels(raw, names) {
  const out = {};
  for (const row of parseList(raw)) {
    const eq = row.indexOf("=");
    if (eq === -1) throw new Error(`lens_models line is not "<lens> = <model>": ${row}`);
    const lens = row.slice(0, eq).trim();
    const model = row.slice(eq + 1).trim();
    if (!Object.prototype.hasOwnProperty.call(names, lens)) {
      throw new Error(`lens_models names an unknown lens: ${lens} (known: ${Object.keys(names).join(", ")})`);
    }
    if (!model) throw new Error(`lens_models has no model for lens: ${lens}`);
    out[lens] = model;
  }
  return out;
}

/** The matrix the review job fans out over. */
export function buildMatrix({ enabled, lensModels, defaultModel, names }) {
  const keys = parseList(enabled);
  if (keys.length === 0) throw new Error("At least one review lens must be enabled");
  const unknown = keys.filter((k) => !Object.prototype.hasOwnProperty.call(names, k));
  if (unknown.length > 0) {
    throw new Error(`Unknown review lenses: ${unknown.join(", ")} (known: ${Object.keys(names).join(", ")})`);
  }
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length > 0) {
    // Two matrix entries with the same lens post two reviews for one lens on one
    // commit, and the gate resolves duplicates by latest started_at — so the
    // second silently decides the verdict.
    throw new Error(`Review lens enabled more than once: ${[...new Set(dupes)].join(", ")}`);
  }
  const models = parseLensModels(lensModels, names);
  const dflt = String(defaultModel || "").trim();
  return {
    include: keys.map((k) => ({ lens: k, name: names[k], model: models[k] || dflt })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const names = readRegistry(process.env.ACTION_PATH || ".");
    const matrix = buildMatrix({
      enabled: process.env.ENABLED,
      lensModels: process.env.LENS_MODELS,
      defaultModel: process.env.DEFAULT_MODEL,
      names,
    });
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
    const shown = matrix.include
      .map((i) => `${i.lens}=${i.model || "<action default>"}`)
      .join(", ");
    console.log(`Lenses: ${shown}`);
    const used = [...new Set(matrix.include.map((i) => i.model))].filter(Boolean);
    console.log(
      `Distinct models: ${used.join(", ") || "<action default>"} — ` +
      `each needs a models_config entry, or its routing floor is not in force.`,
    );
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exit(1);
  }
}
