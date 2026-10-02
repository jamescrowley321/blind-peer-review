// Provider preflight regression guards. All fetches are mocked; no paid calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probe, requestBudget, classifyStatus } from "../../scripts/provider-check.mjs";

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
  assert.equal(snapshot.piAiVersion, "0.85.1");
  assert.equal(snapshot.source, `@earendil-works/pi-ai@${snapshot.piAiVersion}/dist/providers/data/openrouter.json`);
  assert.ok(Object.values(snapshot.maxTokens).every((n) => Number.isSafeInteger(n) && n > 0));
  assert.equal(requestBudget(MODEL), 65536);
  assert.equal(requestBudget("z-ai/glm-5.2"), 131072, "the reported incident budget is not a universal ceiling");
  assert.equal(requestBudget("anthropic/claude-3-haiku"), 4096, "do not impose 65536 on a smaller model");
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
