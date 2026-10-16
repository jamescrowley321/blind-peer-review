import test from "node:test";
import assert from "node:assert/strict";
import { errorCategory, withRateLimitRetry } from "./github.mjs";

const limited = () => Object.assign(new Error("Command failed: gh api graphql"), { stderr: "API rate limit exceeded" });

test("rate-limited calls back off exponentially and then succeed", async () => {
  const waits = [];
  let calls = 0;
  const run = withRateLimitRetry(async () => { if (++calls < 3) throw limited(); return "ok"; }, { sleep: async (ms) => waits.push(ms), baseMs: 10 });
  assert.equal(await run([]), "ok");
  assert.deepEqual(waits, [10, 20]);
});

test("retries stop after the attempt budget, and other errors are not retried", async () => {
  const waits = [];
  const always = withRateLimitRetry(async () => { throw limited(); }, { attempts: 3, sleep: async (ms) => waits.push(ms), baseMs: 1 });
  await assert.rejects(always([]), /rate|Command failed/);
  assert.equal(waits.length, 2);
  let calls = 0;
  const notFound = withRateLimitRetry(async () => { calls++; throw new Error("HTTP 404"); }, { sleep: async () => {} });
  await assert.rejects(notFound([]), /404/);
  assert.equal(calls, 1);
});

test("error categories never depend on the command line text", () => {
  assert.equal(errorCategory(limited()), "rate_limited");
  assert.equal(errorCategory(new Error("HTTP 502")), "server_error");
  assert.equal(errorCategory(new Error("repository is not public")), "not_public");
});
