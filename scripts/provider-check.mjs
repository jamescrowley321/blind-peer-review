#!/usr/bin/env node
// One minimal provider call, before the lens agent spends anything.
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

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** Classify a provider response. Fatal means: no retry, and no later lens, will fix it. */
export function classifyStatus(status) {
  if (status === 402) return { fatal: true, reason: "the account is out of credit (402)" };
  if (status === 401) return { fatal: true, reason: "the provider key is invalid or revoked (401)" };
  if (status === 403) return { fatal: true, reason: "the provider key is not permitted to use this model (403)" };
  if (status === 404) return { fatal: true, reason: "the model id is unavailable to this account (404) — ZDR or allowed-providers, see docs/model-selection.md §2" };
  return { fatal: false, reason: null };
}

export async function probe({ model, key, fetchImpl = fetch }) {
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    // One token. Enough to exercise auth, credit and model availability; not
    // enough to cost anything worth measuring.
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
  });
  if (res.ok) return { ok: true };
  const status = res.status;
  const verdict = classifyStatus(status);
  let detail = "";
  try {
    // Never surface the provider's message body: it carries account state
    // (available credits, in-flight budget). The status is the signal.
    await res.text();
  } catch { /* body is diagnostic only, and we do not use it */ }
  return { ok: false, status, ...verdict, detail };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const model = process.env.LENS_MODEL;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error("provider-check: OPENROUTER_API_KEY is not set"); process.exit(1); }
  if (!model) { console.error("provider-check: LENS_MODEL is not set"); process.exit(1); }
  const r = await probe({ model, key }).catch((e) => ({ ok: false, fatal: false, reason: `probe failed: ${e.message}` }));
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
  console.log(`provider-check: non-fatal provider response${r.status ? ` (${r.status})` : ""} — continuing; the agent retries.`);
}
