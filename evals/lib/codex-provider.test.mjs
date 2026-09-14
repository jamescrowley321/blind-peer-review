// codex-provider.test.mjs — the free local eval path.
// Run: node --test evals/lib/codex-provider.test.mjs
//
// The value of this provider is that a lens or fixture change can be checked
// locally without spending. Its danger is that a run through it looks exactly
// like a run against the model named by --model. These tests pin the parts that
// keep the two distinguishable, and the failure modes that must not be silent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { codexAvailable, codexChat, _resetAvailability } from "./codex-provider.mjs";
import { ModelError } from "./openrouter.mjs";

const fakeOk = (finalText) => {
  const calls = [];
  const runner = (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === "--version") return Object.assign(Promise.resolve({ stdout: "1.0" }), { child: { stdin: { end() {} } } });
    const outIdx = args.indexOf("--output-last-message");
    const path = args[outIdx + 1];
    const p = Promise.resolve().then(() => {
      writeFileSync(path, finalText);
      return { stdout: "" };
    });
    return Object.assign(p, { child: { stdin: { end() {} } } });
  };
  return { runner, calls };
};

test("an absent codex is a clear error, not a crash", async () => {
  _resetAvailability();
  const runner = () => Promise.reject(new Error("ENOENT"));
  await assert.rejects(() => codexChat({ prompt: "x", runner }), (e) => {
    assert.ok(e instanceof ModelError);
    assert.match(e.message, /not on PATH/);
    assert.match(e.message, /--provider openrouter/, "must name the way out");
    return true;
  });
});

test("availability is probed once, not per prompt", async () => {
  _resetAvailability();
  let probes = 0;
  const runner = (cmd, args) => {
    if (args[0] === "--version") probes++;
    return Object.assign(Promise.reject(new Error("no")), { child: { stdin: { end() {} } } }).catch(() => {});
  };
  await codexAvailable(runner);
  await codexAvailable(runner);
  assert.equal(probes, 1, "each prompt re-probing codex would add a process per call");
});

test("the review runs read-only and takes the prompt on stdin", async () => {
  _resetAvailability();
  const { runner, calls } = fakeOk('{"lens":"X","summary":"","findings":[]}');
  await codexChat({ prompt: "hello", runner });
  const exec = calls.find((c) => c.args[0] === "exec");
  assert.ok(exec, "never invoked codex exec");
  assert.ok(exec.args.includes("--sandbox"), "no sandbox flag");
  assert.equal(exec.args[exec.args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(exec.args.at(-1), "-", "the prompt must arrive on stdin, never as an argv element");
});

test("it does NOT force the contract shape", async () => {
  // An eval measures whether a model emits a parseable contract object at all.
  // Passing --output-schema here would peg jsonValidityRate at 100% and measure
  // nothing — unlike the reviewer path, which does want the schema enforced.
  _resetAvailability();
  const { runner, calls } = fakeOk("{}");
  await codexChat({ prompt: "p", runner });
  const exec = calls.find((c) => c.args[0] === "exec");
  assert.ok(!exec.args.includes("--output-schema"), "the eval path must not constrain the output shape");
});

test("the result carries the same fields the openrouter path returns", async () => {
  _resetAvailability();
  const { runner } = fakeOk("hello world");
  const r = await codexChat({ prompt: "p", runner });
  for (const k of ["text", "finishReason", "usage", "servedBy", "resolvedModel", "ms"]) {
    assert.ok(k in r, `missing ${k} — the call phase and scorecard read this`);
  }
  assert.equal(r.text, "hello world");
  assert.equal(r.servedBy, "codex-cli");
  assert.equal(r.resolvedModel, "codex", "must not claim to be the requested slug");
});

test("prose comes back unchanged, so the parser is genuinely exercised", async () => {
  _resetAvailability();
  const { runner } = fakeOk("Here are my findings: nothing.");
  const r = await codexChat({ prompt: "p", runner });
  assert.equal(r.text, "Here are my findings: nothing.");
});

test("a run that produces no final message fails loudly", async () => {
  _resetAvailability();
  const runner = (cmd, args) => {
    if (args[0] === "--version") return Object.assign(Promise.resolve({}), { child: { stdin: { end() {} } } });
    return Object.assign(Promise.resolve({}), { child: { stdin: { end() {} } } }); // writes nothing
  };
  await assert.rejects(() => codexChat({ prompt: "p", runner }), /no final message/);
});

// ── attribution: a codex run must never read as a measurement of a model ──

test("the scorecard renderer distinguishes a codex run", () => {
  const src = readFileSync(new URL("./scorecard.mjs", import.meta.url), "utf8");
  assert.match(src, /meta\.provider === "codex"/, "the scorecard does not branch on provider");
  assert.match(src, /not a measurement of any named model/i, "a codex scorecard must say so in words");
});

test("run.mjs freezes the provider into the plan", () => {
  // score/report read the plan, not argv. A provider that is not frozen there
  // cannot be reported, and the run silently reads as an openrouter measurement.
  const src = readFileSync(new URL("../run.mjs", import.meta.url), "utf8");
  assert.match(src, /provider: args\.provider/, "the provider is not frozen into plan.meta");
  assert.match(src, /--provider must be openrouter or codex/, "an unknown provider is not rejected");
});
