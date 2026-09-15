---
name: check
description: Run the multi-lens adversarial code review on the working diff — fresh-context skeptical reviewers (Cold Read, Edge Cases, Acceptance Criteria, Security Review, Red Team, Policy & Provenance, OWASP Web and OWASP LLM) that hunt bugs, security holes, and unmet acceptance criteria before you push. Use when the user asks to adversarially review changes, review the diff/branch, run the lenses, or check a change before committing, pushing, or opening a PR.
argument-hint: "[--base <ref>] [--lens cold_read,security,...] [--skip owasp_web,owasp_llm,policy]"
allowed-tools: Read, Grep, Glob, Bash, Task
---

# Blind Peer Review (local)

Run the blind-peer-review lenses against the working change and return a
fail-closed verdict. Each lens is a **fresh, independent** reviewer that sees only
the diff — never the plan, the intent, or the other lenses' findings. This is the
local twin of the CI merge gate; the personas are the same markdown files.

## 1. Scope the diff

- Base ref = the `--base <ref>` argument if given, else `origin/main`. Compute the
  change with `git diff <base>...HEAD`. If `<base>` is unresolved (not fetched),
  fall back to `git diff --merge-base <default-branch> HEAD`, then `git diff HEAD`.
- If the diff is empty, say so and stop.
- Write the diff to `.blind-peer-review/out/review-diff.patch` so every lens reads
  the exact same bytes. This is required, not an optimisation: the lens agents have
  no shell — they read this file and cannot produce a diff themselves. That is
  deliberate. A lens marinates in untrusted content, so it holds no capability to
  act on it; you do the shell work before any lens sees anything.

## 2. Choose the lenses

- Read `${CLAUDE_PLUGIN_ROOT}/lenses/manifest.json` — the lens registry.
- Default set = every lens in the manifest with `default_enabled: true`, which is
  now all of them. Read the flag; do not hard-code a list here, or a lens added
  upstream silently stops running.
- Four of them carry an `activation` other than `always` and self-skip when the
  diff has no matching surface (`red_team` → auth/crypto/infra, `owasp_web` →
  web/HTTP, `owasp_llm` → LLM/AI). A self-skip is a PASS with an explaining
  summary, not a failure, and not a reason to drop the lens from the table.
- `--lens a,b,c` replaces the set entirely; `--skip x,y` removes named lenses from
  it. `--add x,y` is still accepted for compatibility but is now a no-op on lenses
  that are already default — it cannot turn anything on that is not already on.

## 3. Resolve each persona (local override wins)

For lens `<key>`:

- If `.blind-peer-review/lenses/<key>.md` exists in THIS repo, use it as the
  persona — a trusted, developer-authored local override.
- Otherwise use `${CLAUDE_PLUGIN_ROOT}/lenses/<key>.md` (the base agent).
- Always also load `${CLAUDE_PLUGIN_ROOT}/contracts/shared_review_contract.md`
  (trust boundary, severity, output envelope).

Overrides are read only from local, committed repo files — never from untrusted
input. The persona files may mention GitHub tools (`get_pr_diff`); that is the CI
wording — ignore it here, you are local and read the patch file directly.

## 4. Prefer an out-of-host reviewer

Check whether the `codex` CLI is on PATH (`command -v codex`). If it is, dispatch
the lenses to it instead of running them in-host:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/dispatch-codex.mjs \
  --diff .blind-peer-review/out/review-diff.patch --repo . [--lens a,b]
```

It runs one `codex exec` per lens, in parallel, each in a read-only sandbox, and
writes `.blind-peer-review/out/<key>.json` per lens. It exits 1 on BLOCK, 0 on
PASS, 2 if codex is unavailable. Report its table and verdict as your own and
**skip sections 5 and 6** — it has already adjudicated, and the same-family
caveat does not apply because a different family did the reviewing.

Why prefer it: in-host, the lenses are subagents of the model that wrote the
diff, so the reviewer shares the author's blind spots. Codex is a different
family, runs on the author's existing Codex auth, and costs nothing at this
project's usual provider. It also enforces the contract via `--output-schema`,
the local equivalent of CI's schema-checked `submit_findings` — a lens cannot
answer in prose.

If `codex` is **not** installed, do not treat that as an error and do not ask the
user to install it. Fall through to section 4a and say plainly which path ran.

## 4a. Otherwise, run the lenses as fresh, parallel subagents

For each chosen lens, spawn a **separate** `Task` subagent (so each starts with a
clean context) with this prompt:

> LOCAL MODE — there is no pull request. The full diff to review is in
> `.blind-peer-review/out/review-diff.patch`. Read that file; read surrounding
> source on disk ONLY to confirm a finding; do NOT modify any file.
>
> {the resolved persona for this lens, with `__PR_NUMBER__` → "N/A (local)"}
>
> {contracts/shared_review_contract.md}
>
> There is no submission tool here: your FINAL message is the contract's JSON
> object and nothing else — no prose, no markdown fences.

Run them concurrently; never let one lens see another's output. Save each lens's
returned object to `.blind-peer-review/out/<key>.json`.

## 5. Adjudicate (fail closed)

Parse each lens's returned JSON and decide on the parsed `severity` values:

- A lens **BLOCKS** if any finding has `"severity": "MUST FIX"`.
- A lens whose output does not parse as the contract object **FAILED** — treat that
  as blocking, not as clean. A review nobody could read has not passed. Say what the
  lens returned instead so it can be re-run.
- **Never decide by searching the text for the words "MUST FIX".** A lens reporting
  "no MUST FIX findings" is a PASS, and substring matching would block it — the
  reason this step reads parsed fields and not prose.
- Print a summary table: lens → PASS / BLOCK / FAILED / (skipped), with each lens's
  MUST FIX count.
- Verdict: **BLOCK** if any lens blocked or failed, else **PASS**. State it plainly
  and list every MUST FIX finding (lens, `location`, `detail`) so they can be fixed
  before pushing.

Do not soften or re-adjudicate a lens's MUST FIX — surface it as written.

## 6. State who reviewed it

Only when section 4a ran — the in-host path. If the lenses were dispatched to
codex, say that instead: the reviewer was a different family, which is the whole
point of preferring it.

End the summary with this line, verbatim:

> Reviewed in-host: the lenses ran on the same model family that wrote this diff.
> A same-family reviewer shares the author's blind spots. CI reviews with a
> different family — see `docs/model-selection.md`.

This is a real limitation of the local path, not boilerplate. The lenses here are
`Task` subagents of the host, so when you author in Claude Code, Claude is
reviewing Claude: a bug that came from a habit of this model family is one the
reviewer is least likely to see. The CI gate does not have this problem — it
dispatches to a different family entirely.

Print the line whether the verdict is PASS or BLOCK. A clean PASS is exactly when
the caveat matters most, because that is when it is easiest to read the result as
stronger evidence than it is. Do not reword it into a reassurance, and do not drop
it because the run found nothing.
