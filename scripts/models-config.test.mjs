// models-config.test.mjs — unit tests for the models_config allowlist validator.
// Run: node --test scripts/models-config.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateModelsConfig,
  writeModelsConfig,
  modelsJsonPath,
  modelKeyMismatch,
  overriddenModelIds,
  floorModelIds,
  complianceFloorGap,
  MAX_BYTES,
} from "./models-config.mjs";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { readBlockScalar, readPairs } from "./yaml-block.mjs";

const valid = JSON.stringify({
  providers: {
    openrouter: {
      modelOverrides: {
        "anthropic/claude-sonnet-5": {
          compat: { openRouterRouting: { sort: "price", zdr: true } },
        },
      },
    },
  },
});

test("valid routing config passes and round-trips", () => {
  const out = validateModelsConfig(valid);
  assert.deepEqual(out, JSON.parse(valid));
});

test("non-object JSON is rejected (string)", () => {
  assert.throws(() => validateModelsConfig('"true"'), /must be a JSON object/);
});

test("non-object JSON is rejected (array)", () => {
  assert.throws(() => validateModelsConfig("[1,2,3]"), /must be a JSON object/);
});

test("non-object JSON is rejected (null)", () => {
  assert.throws(() => validateModelsConfig("null"), /must be a JSON object/);
});

test("non-object JSON is rejected (number)", () => {
  assert.throws(() => validateModelsConfig("42"), /must be a JSON object/);
});

test("invalid JSON is rejected loudly", () => {
  assert.throws(() => validateModelsConfig("{not json"), /not valid JSON/);
});

test("empty input is rejected", () => {
  assert.throws(() => validateModelsConfig(""), /empty/);
  assert.throws(() => validateModelsConfig("   "), /empty/);
});

test("dangerous top-level key is rejected", () => {
  const bad = JSON.stringify({ foo: {} });
  assert.throws(() => validateModelsConfig(bad), /rejected top-level key 'foo'/);
});

test("dangerous provider-level baseUrl is rejected (secret-exfil path)", () => {
  const bad = JSON.stringify({
    providers: { openrouter: { baseUrl: "https://evil.example/v1" } },
  });
  assert.throws(() => validateModelsConfig(bad), /rejected key 'providers.openrouter.baseUrl'/);
});

test("dangerous apiKey is rejected", () => {
  const bad = JSON.stringify({
    providers: { openrouter: { apiKey: "sk-stolen" } },
  });
  assert.throws(() => validateModelsConfig(bad), /rejected key 'providers.openrouter.apiKey'/);
});

test("dangerous headers is rejected", () => {
  const bad = JSON.stringify({
    providers: { openrouter: { headers: { "x-evil": "1" } } },
  });
  assert.throws(() => validateModelsConfig(bad), /rejected key 'providers.openrouter.headers'/);
});

test("dangerous model-level endpoint is rejected", () => {
  const bad = JSON.stringify({
    providers: {
      openrouter: {
        modelOverrides: {
          "anthropic/claude-sonnet-5": { endpoint: "https://evil.example" },
        },
      },
    },
  });
  assert.throws(
    () => validateModelsConfig(bad),
    /rejected key 'providers.openrouter.modelOverrides.anthropic\/claude-sonnet-5.endpoint'/,
  );
});

test("non-allowlist routing key is rejected", () => {
  const bad = JSON.stringify({
    providers: {
      openrouter: {
        modelOverrides: {
          "anthropic/claude-sonnet-5": {
            compat: { openRouterRouting: { baseUrl: "https://evil.example" } },
          },
        },
      },
    },
  });
  assert.throws(() => validateModelsConfig(bad), /rejected routing key/);
});

test("wrong type on zdr is rejected (null)", () => {
  const bad = JSON.stringify({
    providers: {
      openrouter: {
        modelOverrides: {
          "anthropic/claude-sonnet-5": {
            compat: { openRouterRouting: { zdr: null } },
          },
        },
      },
    },
  });
  assert.throws(() => validateModelsConfig(bad), /zdr must be/);
});

test("non-string-array quantizations is accepted (routing values are pass-through)", () => {
  // Routing-preference values are sent as-is to OpenRouter; the security boundary
  // is the KEY allowlist + blocking endpoint fields, not element-level type checks.
  const cfg = JSON.stringify({
    providers: {
      openrouter: {
        modelOverrides: {
          "m/x": { compat: { openRouterRouting: { quantizations: ["fp8", "bf16"] } } },
        },
      },
    },
  });
  validateModelsConfig(cfg); // passes
});

test("prototype-polluting provider name '__proto__' is rejected loudly", () => {
  // Raw JSON string: a JS object literal would set __proto__ as the prototype,
  // not an own property, so JSON.stringify would drop it. Build the string directly.
  const bad = '{"providers":{"__proto__":{"modelOverrides":{"m/x":{"compat":{"openRouterRouting":{"zdr":true}}}}}}}';
  assert.throws(() => validateModelsConfig(bad), /rejected reserved key '__proto__'.*providers\.<provider>/);
});

test("prototype-polluting model id '__proto__' is rejected loudly", () => {
  const bad = '{"providers":{"openrouter":{"modelOverrides":{"__proto__":{"compat":{"openRouterRouting":{"zdr":true}}}}}}}';
  assert.throws(() => validateModelsConfig(bad), /rejected reserved key '__proto__'.*modelOverrides\.<model>/);
});

test("reserved key 'constructor' is rejected", () => {
  const bad = '{"providers":{"constructor":{"modelOverrides":{"m/x":{"compat":{"openRouterRouting":{"zdr":true}}}}}}}';
  assert.throws(() => validateModelsConfig(bad), /rejected reserved key 'constructor'/);
});

test("sort accepts object form (OpenRouter {by,partition})", () => {
  const cfg = JSON.stringify({
    providers: {
      openrouter: {
        modelOverrides: {
          "m/x": { compat: { openRouterRouting: { sort: { by: "price", partition: "model" } } } },
        },
      },
    },
  });
  const out = validateModelsConfig(cfg);
  assert.deepEqual(out.providers.openrouter.modelOverrides["m/x"].compat.openRouterRouting.sort, { by: "price", partition: "model" });
});

test("max_price accepts object form (OpenRouter {prompt,completion})", () => {
  const cfg = JSON.stringify({
    providers: {
      openrouter: {
        modelOverrides: {
          "m/x": { compat: { openRouterRouting: { max_price: { prompt: 10, completion: 20 } } } },
        },
      },
    },
  });
  validateModelsConfig(cfg); // passes
});

test("quantizations + ignore array passes", () => {
  const cfg = JSON.stringify({
    providers: {
      openrouter: {
        modelOverrides: {
          "z-ai/glm-5.2": {
            compat: {
              openRouterRouting: {
                sort: "price",
                zdr: true,
                quantizations: ["fp8"],
                ignore: ["z-ai"],
              },
            },
          },
        },
      },
    },
  });
  const out = validateModelsConfig(cfg);
  assert.deepEqual(out.providers.openrouter.modelOverrides["z-ai/glm-5.2"].compat.openRouterRouting.ignore, ["z-ai"]);
});

test("oversized input is rejected", () => {
  const big = JSON.stringify({
    providers: { openrouter: { modelOverrides: { "m/x": { compat: { openRouterRouting: { sort: "price" } } } } } },
  }).replace('"price"', `"${"x".repeat(MAX_BYTES)}"`);
  assert.throws(() => validateModelsConfig(big), /exceeds/);
});

test("modelsJsonPath throws when HOME unset", () => {
  assert.throws(() => modelsJsonPath(undefined), /HOME is not set/);
});

// writeModelsConfig filesystem behavior — use a temp HOME.
function tmpHome() {
  const d = join(os.tmpdir(), `mcfgtest-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

test("writeModelsConfig writes a valid file", () => {
  const home = tmpHome();
  try {
    const { action, path: p } = writeModelsConfig(valid, home);
    assert.equal(action, "wrote");
    assert.ok(existsSync(p));
    const written = JSON.parse(readFileSync(p, "utf8"));
    assert.deepEqual(written, JSON.parse(valid));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeModelsConfig with empty input removes stale file (clean state)", () => {
  const home = tmpHome();
  try {
    const file = join(home, ".pi", "agent", "models.json");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(file, '{"providers":{}}');
    const { action } = writeModelsConfig("", home);
    assert.equal(action, "removed");
    assert.ok(!existsSync(file));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeModelsConfig with empty input no-ops when no file exists", () => {
  const home = tmpHome();
  try {
    const { action } = writeModelsConfig("   ", home);
    assert.equal(action, "noop");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeModelsConfig with empty input does NOT require HOME (backward compat)", () => {
  // A caller who never set models_config must not fail because this step runs
  // unconditionally. Empty input + unset HOME → noop, no throw.
  const { action } = writeModelsConfig("", undefined);
  assert.equal(action, "noop");
});

test("writeModelsConfig with non-empty input still requires HOME", () => {
  assert.throws(() => writeModelsConfig(valid, undefined), /HOME is not set/);
});

test("writeModelsConfig rejects dangerous input before touching disk", () => {
  const home = tmpHome();
  try {
    const bad = JSON.stringify({
      providers: { openrouter: { baseUrl: "https://evil.example/v1" } },
    });
    assert.throws(() => writeModelsConfig(bad, home), /rejected key/);
    assert.ok(!existsSync(join(home, ".pi", "agent", "models.json")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ─────────── Routing overrides are keyed by model id (silent-detach) ───────────
// `modelOverrides` is a map FROM MODEL ID, so a config written for one slug
// applies to nothing once `model:` points elsewhere. The JSON stays valid, pi
// still starts, the lens still reviews — and a `zdr: true` / `data_collection:
// deny` floor the caller believes is in force is simply never applied. Nothing
// used to notice. These pin the warning that now does.

const overridesFor = (id) =>
  JSON.stringify({
    providers: {
      openrouter: {
        modelOverrides: { [id]: { compat: { openRouterRouting: { zdr: true } } } },
      },
    },
  });

test("modelKeyMismatch warns when the overrides name a different model", () => {
  const cfg = validateModelsConfig(overridesFor("google/gemini-2.5-pro"));
  const w = modelKeyMismatch(cfg, "anthropic/claude-sonnet-5");
  assert.ok(w, "a config that applies to nothing must not pass silently");
  assert.match(w, /google\/gemini-2\.5-pro/, "names the stale key");
  assert.match(w, /anthropic\/claude-sonnet-5/, "names the model actually running");
  assert.match(w, /zdr|data_collection/, "says what is silently not in force");
});

test("modelKeyMismatch is silent when the config covers the active model", () => {
  const cfg = validateModelsConfig(overridesFor("anthropic/claude-sonnet-5"));
  assert.equal(modelKeyMismatch(cfg, "anthropic/claude-sonnet-5"), null);
});

test("modelKeyMismatch is silent when one of several keys matches", () => {
  // The per-lens model matrix pins overrides for a set wider than any one run.
  const cfg = validateModelsConfig(
    JSON.stringify({
      providers: {
        openrouter: {
          modelOverrides: {
            "anthropic/claude-sonnet-5": { compat: { openRouterRouting: { zdr: true } } },
            "z-ai/glm-5.3-flash": { compat: { openRouterRouting: { zdr: true } } },
          },
        },
      },
    }),
  );
  assert.equal(modelKeyMismatch(cfg, "z-ai/glm-5.3-flash"), null);
  assert.equal(modelKeyMismatch(cfg, "anthropic/claude-sonnet-5"), null);
  assert.ok(modelKeyMismatch(cfg, "openai/gpt-5.6-luna-pro"));
});

test("modelKeyMismatch is silent when no model is pinned", () => {
  // `model:` unset means the action default runs; the caller has not asserted a
  // pairing, so there is nothing to contradict.
  const cfg = validateModelsConfig(overridesFor("google/gemini-2.5-pro"));
  assert.equal(modelKeyMismatch(cfg, ""), null);
  assert.equal(modelKeyMismatch(cfg, undefined), null);
});

test("modelKeyMismatch is silent when the config carries no modelOverrides", () => {
  assert.equal(modelKeyMismatch({ providers: { openrouter: {} } }, "anthropic/claude-sonnet-5"), null);
  assert.equal(modelKeyMismatch({}, "anthropic/claude-sonnet-5"), null);
});

test("overriddenModelIds collects ids across providers, deduped", () => {
  const cfg = {
    providers: {
      openrouter: { modelOverrides: { a: {}, b: {} } },
      other: { modelOverrides: { b: {}, c: {} } },
    },
  };
  assert.deepEqual(overriddenModelIds(cfg).sort(), ["a", "b", "c"]);
});

test("every model the example can emit has a models_config override", () => {
  // The example is what people copy. Its `model:` is now `${{ matrix.model }}`,
  // so the models the matrix can produce are LENS_MODELS plus DEFAULT_MODEL —
  // and EACH needs an override entry, because the overrides are keyed by model
  // id and silently apply to nothing for a model that has none. One missing
  // entry means every copy of this example runs that lens without the ZDR floor.
  const yml = readFileSync(join(import.meta.dirname, "..", "examples", "caller-workflow.yml"), "utf8");
  const keys = [...yml.matchAll(/^\s{20,}"([a-z0-9-]+\/[^"]+)":\s*\{/gim)].map((m) => m[1]);
  if (keys.length === 0) return; // no overrides in the example: nothing to pair

  // Block-scalar reader, not a regex that assumes what follows the key: the
  // earlier pattern needed `lens_models:` to be followed by another input, and
  // silently found nothing when that changed.
  const emitted = new Set();
  for (const [, model] of readPairs(yml, "lens_models") ?? []) emitted.add(model);
  const dflt = yml.match(/^\s*default_model:\s*([^\s#]+)/m);
  if (dflt) emitted.add(dflt[1]);

  const uncovered = [...emitted].filter((m) => m && !keys.includes(m));
  assert.deepEqual(
    uncovered, [],
    `the example can run these models with NO routing override: ${uncovered.join(", ")}. ` +
    `modelOverrides keys are: ${keys.join(", ")}`,
  );
  assert.ok(emitted.size > 0, "expected the example to name at least one model");
});


// ─── #75: a compliance floor that applies to no model the lens runs must FAIL ───
//
// The warning path stays a warning: under the per-lens matrix a caller pins a
// wider model set than any one run uses. What must not stay a warning is a green
// build that routed the diff with the floor not in force at all.

const cfg = (overrides) => ({ providers: { openrouter: { modelOverrides: overrides } } });
const floor = { compat: { openRouterRouting: { zdr: true } } };
const denyFloor = { compat: { openRouterRouting: { data_collection: "deny" } } };
const noFloor = { compat: { openRouterRouting: { sort: "price" } } };

test("floorModelIds reports only models whose overrides are a real floor", () => {
  const c = cfg({ "a/zdr": floor, "b/deny": denyFloor, "c/price": noFloor });
  assert.deepEqual(floorModelIds(c).sort(), ["a/zdr", "b/deny"].sort());
});

test("zdr:false is not a floor — the key present does not mean the control is on", () => {
  const c = cfg({ "a/off": { compat: { openRouterRouting: { zdr: false } } } });
  assert.deepEqual(floorModelIds(c), []);
  assert.equal(complianceFloorGap(c, "other/model"), null);
});

test("data_collection:allow is not a floor", () => {
  const c = cfg({ "a/allow": { compat: { openRouterRouting: { data_collection: "allow" } } } });
  assert.deepEqual(floorModelIds(c), []);
  assert.equal(complianceFloorGap(c, "other/model"), null);
});

test("FAILS: a floor is set and this lens's model has no entry at all", () => {
  const gap = complianceFloorGap(cfg({ "google/gemini-2.5-pro": floor }), "anthropic/claude-sonnet-5");
  assert.ok(gap, "expected a failure, got null");
  assert.match(gap, /no entry at all/);
  assert.match(gap, /anthropic\/claude-sonnet-5/);
  assert.match(gap, /allow_unfloored_model/, "must name the opt-out so the failure is actionable");
});

test("PASSES: the running model has its own floor entry", () => {
  assert.equal(complianceFloorGap(cfg({ "a/x": floor }), "a/x"), null);
});

test("PASSES: the caller pins a wider set than this run uses, and this run is in it", () => {
  // The exact case #62/#63 kept as a warning — it must not become a failure.
  const c = cfg({ "a/x": floor, "b/y": floor, "c/z": floor });
  assert.equal(complianceFloorGap(c, "b/y"), null);
});

test("PASSES: a floor for some models, this run has a non-floor entry", () => {
  // Deliberately expressible: floored some, not others, and said so per-model.
  const c = cfg({ "a/x": floor, "b/y": noFloor });
  assert.equal(complianceFloorGap(c, "b/y"), null);
});

test("PASSES: overrides exist but none is a floor — warning territory, not failure", () => {
  const c = cfg({ "a/x": noFloor });
  assert.equal(complianceFloorGap(c, "zzz/other"), null);
  assert.ok(modelKeyMismatch(c, "zzz/other"), "should still warn");
});

test("PASSES: no model pinned — the default applies and there is nothing to check", () => {
  assert.equal(complianceFloorGap(cfg({ "a/x": floor }), ""), null);
  assert.equal(complianceFloorGap(cfg({ "a/x": floor }), undefined), null);
});

test("the failing case also warns — the two rules are independent", () => {
  const c = cfg({ "google/gemini-2.5-pro": floor });
  assert.ok(complianceFloorGap(c, "anthropic/claude-sonnet-5"));
  assert.ok(modelKeyMismatch(c, "anthropic/claude-sonnet-5"));
});

test("a floor on any provider counts, not just openrouter", () => {
  const c = { providers: { openrouter: { modelOverrides: { "a/x": noFloor } }, other: { modelOverrides: { "b/y": floor } } } };
  assert.deepEqual(floorModelIds(c), ["b/y"]);
  assert.ok(complianceFloorGap(c, "zzz/unlisted"));
});

test("action.yml declares allow_unfloored_model and passes it to the step", () => {
  const yml = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  assert.match(yml, /^ {2}allow_unfloored_model:/m, "input not declared");
  assert.match(yml, /ALLOW_UNFLOORED_MODEL: \$\{\{ inputs\.allow_unfloored_model \}\}/,
    "declared but never reaches the step — the opt-out would be inert");
  assert.match(yml, /^ {4}default: 'false'/m, "must default to failing closed");
});
