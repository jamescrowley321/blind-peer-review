// A local, free provider for the eval `call` phase.
//
// The harness normally sends each composed prompt to OpenRouter. That is the
// right thing when you are MEASURING A MODEL — a model comparison is the whole
// point of docs/model-selection.md, and codex cannot stand in for a slug it does
// not serve. But it makes every local run cost money, so in practice the suite
// only ever ran on main, and a lens or fixture change could not be checked
// before merge without spending.
//
// This routes the same prompts through `codex exec` instead, on the author's own
// Codex auth. What it is good for: validating a lens edit, a fixture, or a
// harness change locally, for free, against a real model. What it is NOT good
// for: any claim about a named model's score. `--provider codex` therefore
// records the provider in the scorecard, so a run can never be mistaken for a
// measurement of the model named on the command line.
//
// Deliberately NO --output-schema. The CI reviewer uses one, but an eval exists
// partly to measure whether a model emits a parseable contract object at all
// (jsonValidityRate). Forcing the shape here would peg that metric at 100% and
// measure nothing.

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ModelError } from "./openrouter.mjs";

const run = promisify(execFile);

/** True when the `codex` CLI is usable. Cached: this is asked once per run. */
let available = null;
export async function codexAvailable(runner = run) {
  if (available !== null) return available;
  try {
    await runner("codex", ["--version"], { timeout: 15_000 });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/** Reset the cached probe. Tests only. */
export function _resetAvailability() {
  available = null;
}

/**
 * Same shape `chat()` returns, so the call phase does not care which it used.
 *
 * `temperature` and `maxTokens` are accepted and ignored: codex exec exposes
 * neither. That is a real limitation of this provider and the reason reps here
 * measure less variance than an OpenRouter run would — recorded rather than
 * hidden, because a stability number from this path would otherwise look
 * better than it is.
 */
export async function codexChat({ prompt, timeoutMs = 900_000, runner = run }) {
  if (!(await codexAvailable(runner))) {
    throw new ModelError(
      "the `codex` CLI is not on PATH — install it, or run with --provider openrouter and a key.",
    );
  }
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "bpr-eval-codex-"));
  const last = join(dir, "last.txt");
  try {
    const child = runner(
      "codex",
      ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--output-last-message", last, "-"],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    );
    child.child.stdin.end(prompt);
    await child;
    if (!existsSync(last)) throw new ModelError("codex wrote no final message");
    // Same fields chat() returns, so the call phase and the scorecard treat both
    // providers identically. `finishReason` is "stop": codex exec either produces
    // a final message or fails, and it exposes no truncation signal — which is
    // exactly why a ceiling-hit cannot be detected on this path and why the
    // scorecard records the provider.
    return {
      text: readFileSync(last, "utf8"),
      finishReason: "stop",
      usage: null,
      servedBy: "codex-cli",
      resolvedModel: "codex",
      ms: Date.now() - started,
    };
  } catch (e) {
    if (e instanceof ModelError) throw e;
    throw new ModelError(`codex exec failed: ${(e.message || String(e)).split("\n")[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
