// Provider preflight regression guards. All fetches are mocked; no paid calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probe, requestBudget, classifyStatus, probeOutcome } from "../../scripts/provider-check.mjs";

const MODEL = "google/gemini-2.5-pro";
const SECRET = "account-state-and-secret-key";
const args = { model: MODEL, key: SECRET };
const sse = (value) => `data: ${JSON.stringify(value)}\n\n`;
const answer = sse({ choices: [{ delta: { content: "ok" } }] });

function errorResponse(limitSource, status = 402) {
  return new Response(JSON.stringify({ error: { code: status, message: SECRET, metadata: { limit_source: limitSource, remedy_hint: SECRET } }, user_id: SECRET }), { status });
}

test("SDK snapshot is tied to the engine pin and names the exact package source", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../../scripts/pi-openrouter-limits.json", import.meta.url)));
  const action = readFileSync(new URL("../../action.yml", import.meta.url), "utf8");
  assert.equal(snapshot.engineSha, action.match(/shaftoe\/pi-coding-agent-action@([0-9a-f]{40})/)[1], "re-check SDK output budgets whenever the engine pin moves");
  assert.equal(snapshot.piAiVersion, "1.0.4");
  assert.equal(snapshot.source, `@earendil-works/pi-ai@${snapshot.piAiVersion}/dist/providers/data/openrouter.json`);
  assert.ok(Object.values(snapshot.maxTokens).every((n) => Number.isSafeInteger(n) && n > 0));
  assert.equal(requestBudget(MODEL), 65536);
  assert.equal(requestBudget("z-ai/glm-5.2"), 131072, "the reported incident budget is not a universal ceiling");
  assert.equal(requestBudget("openai/gpt-3.5-turbo"), 4096, "do not impose 65536 on a smaller model");
});

test("a key affordable for one token but not a full lens is rejected", async () => {
  let requested;
  const r = await probe({ ...args, fetchImpl: async (url, opts) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(opts.headers.Authorization, `Bearer ${SECRET}`);
    requested = JSON.parse(opts.body);
    return requested.max_tokens > 6659 ? errorResponse("openrouter_key_limit") : new Response(answer);
  } });
  assert.equal(requested.max_tokens, 65536);
  assert.deepEqual(requested.reasoning, { enabled: false });
  assert.equal(r.fatal, true);
  assert.match(r.reason, /key spending limit.*raise the key limit/);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});

test("402 remedies distinguish key, account, temporary holds and unknown sources safely", async () => {
  for (const [source, fatal, reason] of [
    ["openrouter_key_limit", true, /key spending limit/],
    ["openrouter_credits", true, /account credits or the per-request spending budget/],
    ["openrouter_in_flight_budget", false, /temporarily full/],
    [SECRET, true, /credits or a spending limit/],
    [null, true, /credits or a spending limit/],
  ]) {
    const r = await probe({ ...args, fetchImpl: async () => errorResponse(source) });
    assert.equal(r.fatal, fatal);
    assert.match(r.reason, reason);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
  }
  assert.equal(classifyStatus(401, "openrouter_in_flight_budget").fatal, true);
});

test("malformed and unreadable provider bodies retain the fatal HTTP verdict", async () => {
  for (const text of [async () => "not-json " + SECRET, async () => { throw Error(SECRET); }]) {
    const r = await probe({ ...args, fetchImpl: async () => ({ ok: false, status: 402, text }) });
    assert.equal(r.fatal, true);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
  }
});

test("a streamed 200 with a 402 error is rejected before marking the probe reachable", async () => {
  const stream = ': keepalive\n\n' + sse({ error: { code: 402, message: SECRET, metadata: { limit_source: "openrouter_key_limit" } } });
  const r = await probe({ ...args, fetchImpl: async () => new Response(stream) });
  assert.equal(r.status, 402);
  assert.equal(r.fatal, true);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});

test("success cancels the stream at the first answer and aborts the request", async () => {
  let canceled = false;
  let signal;
  const r = await probe({ ...args, fetchImpl: async (_url, opts) => {
    signal = opts.signal;
    return new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(answer)); },
      cancel() { canceled = true; },
    }));
  } });
  assert.equal(r.ok, true);
  assert.equal(canceled, true);
  assert.equal(signal.aborted, true);
});

test("partial SSE chunks are decoded without treating keepalives as answers", async () => {
  let read = 0;
  const values = [": keepalive\n\n", 'data: {"choices":', '[{"delta":{"content":"ok"}}]}\n\n'];
  const r = await probe({ ...args, fetchImpl: async () => new Response(new ReadableStream({
    pull(c) { c.enqueue(new TextEncoder().encode(values[read++])); },
  })) });
  assert.equal(r.ok, true);
  assert.equal(read >= 3, true);
});

test("timeout cancels a pending stream and never exposes fetch exception text", async () => {
  const r = await probe({ ...args, timeoutMs: 5, fetchImpl: async (_url, opts) => ({
    ok: true,
    body: { getReader: () => ({
      read: () => new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(Error(SECRET)))),
      cancel: async () => {},
    }) },
  }) });
  assert.equal(r.ok, false);
  assert.equal(r.fatal, false);
  assert.match(r.reason, /timed out/);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});

test("probe limits response bytes, empty streams, unknown models and unsafe exceptions", async () => {
  for (const fetchImpl of [
    async () => new Response("x".repeat(65537)),
    async () => new Response(": keepalive\n\n"),
    async () => new Response("data: [DONE]\n\n"),
    async () => new Response(sse({ choices: [{ finish_reason: "error" }] })),
    async () => { throw Error(SECRET); },
  ]) {
    const r = await probe({ ...args, fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.fatal, false);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
  }
  const r = await probe({ ...args, model: "unknown/model", fetchImpl: async () => { assert.fail("do not invent a budget for unknown models"); } });
  assert.equal(r.ok, false);
  assert.equal(r.fatal, false);
  assert.match(r.reason, /no verified output budget.*affordability was not checked/);
  assert.equal(requestBudget("__proto__"), null);
});

test("the affordability probe carries the lens's validated routing policy", async () => {
  const routing = { zdr: true, data_collection: "deny", ignore: ["siliconflow"], sort: "price" };
  const modelsConfig = JSON.stringify({ providers: { openrouter: { modelOverrides: {
    [MODEL]: { compat: { openRouterRouting: routing } },
  } } } });
  let calls = 0;
  const result = await probe({ ...args, modelsConfig, fetchImpl: async (_url, options) => {
    calls++;
    assert.deepEqual(JSON.parse(options.body).provider, routing);
    return new Response(answer);
  } });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

for (const modelsConfig of ["not JSON", JSON.stringify({ providers: { openrouter: { apiKey: SECRET } } }),
  JSON.stringify({ providers: { openrouter: { modelOverrides: {
    other: { compat: { openRouterRouting: { zdr: true, data_collection: "deny" } } },
  } } } })]) {
  test("invalid or inapplicable floors stop the probe before network access", async () => {
    let calls = 0;
    const result = await probe({ ...args, modelsConfig, fetchImpl: async () => { calls++; throw Error(SECRET); } });
    assert.equal(result.ok, false);
    assert.equal(result.fatal, true);
    assert.equal(calls, 0);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  });
}

test("strict pilot refuses an unknown output reservation without a model call", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const [strict, code] of [["true", 3], ["false", 0], ["tru", 3]]) {
    const result = spawnSync(process.execPath, [new URL("../../scripts/provider-check.mjs", import.meta.url).pathname], {
      env: { ...process.env, LENS_MODEL: "synthetic-unknown-model", OPENROUTER_API_KEY: SECRET, REQUIRE_SUCCESSFUL_PROBE: strict },
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, code, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET));
  }
});

test("the probe reads routing from the provider the lens runs, and fails closed when the floor is filed elsewhere", async () => {
  const routing = { zdr: true, data_collection: "deny" };
  const under = (provider) => JSON.stringify({ providers: { [provider]: { modelOverrides: { [MODEL]: { compat: { openRouterRouting: routing } } } } } });
  let sent;
  const ok = await probe({ ...args, provider: "custom", modelsConfig: under("custom"), fetchImpl: async (_u, o) => { sent = JSON.parse(o.body).provider; return new Response(answer); } });
  assert.equal(ok.ok, true);
  assert.deepEqual(sent, routing, "routing under the active provider was not sent");
  let calls = 0;
  const gap = await probe({ ...args, provider: "openrouter", modelsConfig: under("custom"), fetchImpl: async () => { calls++; return new Response(answer); } });
  assert.equal(gap.ok, false);
  assert.equal(gap.fatal, true);
  assert.equal(calls, 0, "probe went out without the floor written for this model");
  const allowed = await probe({ ...args, provider: "openrouter", modelsConfig: under("custom"), allowUnflooredModel: true, fetchImpl: async () => new Response(answer) });
  assert.equal(allowed.ok, true, "allow_unfloored_model no longer opts out");
});

test("strict mode fails every non-success, but only a fatal result says re-running will not help", () => {
  const fatal = probeOutcome({ ok: false, fatal: true, reason: "credit exhausted" }, "m", "true");
  assert.equal(fatal.exit, 3);
  assert.match(fatal.message, /re-running will not help/);
  for (const r of [
    { ok: false, fatal: false, status: 503, reason: "provider error" },
    { ok: false, fatal: false, reason: "malformed stream" },
    { ok: false, fatal: false, reason: "timed out" },
    { ok: false, fatal: false, reason: "the model has no verified output budget" },
  ]) {
    const strict = probeOutcome(r, "m", "true");
    assert.equal(strict.exit, 3, r.reason);
    assert.doesNotMatch(strict.message, /re-running will not help/, r.reason);
    assert.match(strict.message, new RegExp(r.reason), "the strict message hides the reason");
    assert.match(strict.message, /require_successful_probe/);
    const lenient = probeOutcome(r, "m", "false");
    assert.equal(lenient.exit, 0, r.reason);
  }
  assert.deepEqual(probeOutcome({ ok: true }, "m", "true").exit, 0);
});

test("the action passes the lens's provider to the probe", () => {
  const action = readFileSync(new URL("../../action.yml", import.meta.url), "utf8");
  const step = action.split("- name: Check the provider can be reached")[1].split("\n    - name:")[0];
  assert.match(step, /LENS_PROVIDER: \$\{\{ inputs\.provider \}\}/);
});
