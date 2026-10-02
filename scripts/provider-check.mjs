#!/usr/bin/env node
// One short, cancelled streaming call using the lens's output reservation.
//
// WHY. When the account is out of credit every lens job runs the agent, gets
// nothing back, and posts "agent produced no output ... Re-run this job to
// retry." That advice cannot work: a 402 is not transient, and eight jobs
// repeat it on every push while the Merge Gate fails closed as though the
// review had found defects.
//
// The provider key is ALREADY in scope for the lens job, so this adds no
// exposure — it runs in the same job, immediately before the agent, and turns a
// two-minute misleading failure into a two-second accurate one.
//
// It deliberately does NOT decide whether the review passed. It decides whether
// a review was possible at all, which is a different question and the one the
// gate has been answering wrongly.

import { readFileSync } from "node:fs";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const limits = JSON.parse(readFileSync(new URL("./pi-openrouter-limits.json", import.meta.url), "utf8"));

// The pinned engine does not override maxTokens. pi-ai 0.85.1's
// api/simple-options.ts uses model.maxTokens, clamped down for prompt context.
// Reserve the ceiling after the SDK's 4096-token context safety margin:
// conservative for large prompts, and
// unlike a one-token probe subject to the same output-credit reservation.
// Re-check the snapshot whenever the engine/SDK pin changes. No prices or
// account balances are stored or queried. Unknown IDs have no verified budget.
export function requestBudget(model) {
  if (!Object.hasOwn(limits.maxTokens, model)) return null;
  const cap = limits.maxTokens[model];
  const context = limits.contextWindow[model];
  return context > 0 ? Math.min(cap, Math.max(1, context - 4096)) : cap;
}

/** Classify a provider response. Fatal means: no retry, and no later lens, will fix it. */
export function classifyStatus(status, limitSource) {
  // Literal allowlist only; never interpolate provider-controlled metadata.
  // https://openrouter.ai/docs/api_reference/limits (verified 2026-10-01)
  if (status === 402) {
    if (limitSource === "openrouter_key_limit") return { fatal: true, reason: "the API key spending limit cannot cover this request (402) — raise the key limit or wait for its reset" };
    if (limitSource === "openrouter_credits") return { fatal: true, reason: "account credits or the per-request spending budget cannot cover this request (402) — add credits or reduce the request size" };
    if (limitSource === "openrouter_in_flight_budget") return { fatal: false, reason: "the in-flight spending budget is temporarily full (402) — wait for pending requests to settle before retrying" };
    return { fatal: true, reason: "provider credits or a spending limit cannot cover this request (402) — check the account balance and key limit" };
  }
  if (status === 401) return { fatal: true, reason: "the provider key is invalid or revoked (401)" };
  if (status === 403) return { fatal: true, reason: "the provider key is not permitted to use this model (403)" };
  if (status === 404) return { fatal: true, reason: "the model id is unavailable to this account (404) — ZDR or allowed-providers, see docs/model-selection.md §2" };
  return { fatal: false, reason: null };
}

function errorVerdict(status, payload) {
  return { ok: false, status, ...classifyStatus(status, payload?.error?.metadata?.limit_source), detail: "" };
}

export async function probe({ model, key, fetchImpl = fetch, timeoutMs = 20_000 }) {
  const maxTokens = requestBudget(model);
  if (!maxTokens) return { ok: false, fatal: false, reason: "the model has no verified output budget in the pinned SDK snapshot — affordability was not checked" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: controller.signal,
      // Ask for a tiny answer, disable reasoning, and cancel on the first answer
      // chunk. The reservation must be large; the generated answer need not be.
      body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, reasoning: { enabled: false }, messages: [{ role: "user", content: "Reply exactly: ok" }] }),
    });
    if (!res.ok) {
      let payload;
      try { payload = JSON.parse(await res.text()); } catch { /* status alone is sufficient */ }
      return errorVerdict(res.status, payload);
    }
    // A streaming 200 can still carry a provider error. Wait for an actual
    // answer or a completed event, never mistake a keep-alive for success.
    reader = res.body?.getReader();
    if (!reader) return { ok: false, fatal: false, reason: "provider returned no stream — affordability was not confirmed" };
    const decoder = new TextDecoder();
    let pending = "";
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) return { ok: false, fatal: false, reason: "provider stream ended without an answer — affordability was not confirmed" };
      received += value.byteLength;
      if (received > 64 * 1024) return { ok: false, fatal: false, reason: "provider probe exceeded its response limit — affordability was not confirmed" };
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return { ok: false, fatal: false, reason: "provider stream completed without an answer — affordability was not confirmed" };
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (payload.error) return errorVerdict(Number.isInteger(payload.error.code) ? payload.error.code : 500, payload);
        if (payload.choices?.some((c) => c.finish_reason === "error")) return errorVerdict(500);
        if (payload.choices?.some((c) => c.delta?.content || c.finish_reason)) return { ok: true };
      }
    }
  } catch {
    // Fetch exceptions can contain URLs, headers or provider bodies. Do not
    // return their text, even when logging a non-fatal failure.
    return { ok: false, fatal: false, reason: "provider probe failed or timed out — affordability was not confirmed" };
  } finally {
    clearTimeout(timer);
    controller.abort();
    try { await reader?.cancel(); } catch { /* already aborted */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const model = process.env.LENS_MODEL;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error("provider-check: OPENROUTER_API_KEY is not set"); process.exit(1); }
  if (!model) { console.error("provider-check: LENS_MODEL is not set"); process.exit(1); }
  const r = await probe({ model, key });
  if (r.ok) { console.log(`provider-check: ${model} reachable`); process.exit(0); }
  if (r.fatal) {
    console.error(
      `::error::Provider unavailable for "${model}": ${r.reason}. ` +
      `No lens can run, so this is NOT a review result and re-running will not help. ` +
      `Fix the account condition, then re-run.`,
    );
    process.exit(3);
  }
  // Transient: say so and let the agent try — it has its own retries.
  console.log(`provider-check: ${r.reason || "non-fatal provider response"}${r.status ? ` (${r.status})` : ""} — continuing; the agent retries.`);
}
