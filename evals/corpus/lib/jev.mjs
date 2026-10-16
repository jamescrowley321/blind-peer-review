// Minimal Jev (OpenRouter System One) transport for corpus screening.
//
// Records every call, failed or not, with usage kept as reported: missing usage
// stays unknown, never zero. Error bodies are never copied (they can carry
// billing or account detail); only the HTTP status is kept.

import { parseAnswers } from "./screening.mjs";

export const ENDPOINT = "https://openrouter.ai/api/v1/systemone";
export const MODEL = "typesafe/jev-1.13";
export const FATAL = new Set([400, 401, 402, 403, 404]);

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export async function screenCase(state, questions, {
  key,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  retries = 2,
  sleep = sleepMs,
} = {}) {
  if (!key) throw new Error("OPENROUTER_API_KEY required");
  const started = Date.now();
  const record = { usage: null, attempts: 0 };
  try {
    for (;;) {
      record.attempts++;
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "eval-corpus-screening" },
          body: JSON.stringify({ model: MODEL, state, questions }),
        });
      } catch {
        if (record.attempts <= retries) { await sleep(1000 * record.attempts); continue; }
        record.error = "transport_failure";
        return record;
      }
      if (response.status === 429 && record.attempts <= retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 2000 * record.attempts);
        continue;
      }
      if (!response.ok) {
        record.status = response.status;
        record.error = `http_${response.status}`;
        return record;
      }
      let body;
      try {
        body = await response.json();
      } catch {
        record.error = "malformed_body";
        return record;
      }
      record.usage = body.usage ?? null;
      record.model = body.model ?? null;
      try {
        record.probabilities = parseAnswers(body.answers, questions);
      } catch (error) {
        record.error = error.message;
      }
      return record;
    }
  } finally {
    record.ms = Date.now() - started;
  }
}
