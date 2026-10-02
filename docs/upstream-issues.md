# Upstream issues — `shaftoe/pi-coding-agent-action`

Defects found in the agent action this project pins, each with the workaround
that is live in this repo. **Nothing here has been filed upstream.** These are
written up so a human can send them; do not auto-file them.

Pinned engine: `shaftoe/pi-coding-agent-action@853a9af5ac64e79c79fa6bb3958314aa1acf7e92` (v2.28.1).
Re-check all three when that pin moves — a fixed upstream defect means a
workaround here can be retired, and a workaround nobody retires becomes folklore.

## Re-check log

**2026-10-01 — v2.28.0 → v2.28.1. All three defects still present; every
workaround still required.**

Fetched both source files at the old and new full commit SHAs and compared
with `cmp`: both are byte-identical. The diff port needs only its provenance
header updated; no behavior changed.

| file | v2.28.0 | v2.28.1 | SHA-256 (both) |
|---|---|---|---|
| `packages/pi-platform-github/src/tools/pr-diff.ts` | 4072 B | 4072 B, identical | `2f5263ad3b1cad399364534cc7b4fbce0a599ff3ef05020032900b21a7b0634f` |
| `packages/pi-orchestrator/src/pi/tools/get-pr-diff.ts` | 10707 B | 10707 B, identical | `a06257cea506ccccfac5d02d1376571836aa13678534a2cf9f7dd7dea8b656a1` |

Verified the unanchored `diff.split(hunkSeparator)`, unfloored byte budget, and
literal triple-backtick result wrapper in the new sources. Replayed the port
against the extracted upstream helpers over seven ASCII, UTF-8, line, byte,
and tiny-budget cases: outputs match, including the `maxBytes=1` defect.
Fixture validation and offline contracts pass with the new pin.

The upstream release changes Opengist session expiration defaults and CI/dev
dependencies. This action does not enable session sharing. Its lockfile still
resolves the pi SDK to **0.85.1**. Rechecked `pi/agent.ts`: it supplies no
output-token override. `pi-ai`'s `api/simple-options.ts` reserves the model's
`maxTokens`, reduced by its context budget (4096-token safety margin plus
estimated input). `scripts/pi-openrouter-limits.json` records only each
OpenRouter model's output limit and context window from that exact package;
its engine SHA is guarded by offline tests so a future upgrade requires a
recheck. The provider preflight uses the model ceiling minus the context
safety margin as a conservative reservation; a large real prompt can reserve
less. Unknown IDs warn that affordability was not checked. A short streaming
probe cancels at its first answer, so reserving a full lens budget does not
require generating a full lens answer.

Sources: [engine comparison](https://github.com/shaftoe/pi-coding-agent-action/compare/1f0be2391705316c12e0f504eab2e39c74ec2da8...853a9af5ac64e79c79fa6bb3958314aa1acf7e92),
[`agent.ts`](https://github.com/shaftoe/pi-coding-agent-action/blob/853a9af5ac64e79c79fa6bb3958314aa1acf7e92/packages/pi-orchestrator/src/pi/agent.ts),
[`pi-ai@0.85.1`](https://www.npmjs.com/package/@earendil-works/pi-ai/v/0.85.1),
[OpenRouter 402 limit sources](https://openrouter.ai/docs/api_reference/limits).
No paid provider calls were used for validation.

**2026-09-14 — v2.27.1 → v2.28.0. All three defects still present; every
workaround still required.**

The two files carrying them are **byte-identical** between the two tags:

| file | v2.27.1 | v2.28.0 |
|---|---|---|
| `packages/pi-platform-github/src/tools/pr-diff.ts` | 4072 B | 4072 B, identical |
| `packages/pi-orchestrator/src/pi/tools/get-pr-diff.ts` | 10707 B | 10707 B, identical |

v2.28.0 is additive elsewhere: an opt-in `update_comment` input (default
`'false'`, and we do not pass it), a CodeQL bump, and the pi SDK to v0.85.1. The
release touches `comments.ts` heavily, which is worth knowing because
`cleanup_agent_comments` deletes the agent's raw-JSON comment — but with
`update_comment` off, posting behaviour is unchanged.

Verified rather than assumed, on the upgraded pin:

- **#1** — `evals/validate-fixtures.mjs` rejects a literal `diff --git ` planted in
  a fixture, naming the `DIFFGIT ` encoding. 31 fixtures validate clean.
- **#2** — `evals/lib/pi-diff.mjs` was diffed against a verbatim transliteration of
  v2.28.0's `truncateDiffByBytes` across seven inputs, including the multi-byte
  UTF-8 and `maxBytes=1` cases: identical on every one, defect included.
- **#3** — `renderGetPrDiff` reproduces v2.28.0's fence line byte-for-byte, and
  still refuses a payload containing ``` rather than emitting one the real tool
  never produces or silently escaping it.

---

## 1. `filterDiffByIgnoreFiles` splits on an unanchored substring

**Where:** `packages/pi-platform-github/src/tools/pr-diff.ts`

```ts
const hunkSeparator = 'diff --git ';
const hunks = diff.split(hunkSeparator);   // substring split, not line-anchored
```

**What goes wrong.** The split is on the *substring* `diff --git `, not on a
line start. Any file whose **content** contains that sequence — a committed
`.patch` or `.diff` fixture, documentation showing a diff, a test snapshot — is
cut into extra chunks. Each phantom chunk's path is then parsed out of the
file's *own internal* header:

```ts
const match = headerLine.match(/^(a\/.+?)\s+b\//);
const filePath = match?.[1] ?? headerLine;   // falls back to raw text on no match
```

So `diff_ignore_patterns` is matched against a path that exists only inside the
ignored file. The result inverts the feature: the fixture file *is* excluded,
while its contents leak through as separate pseudo-files that no ignore pattern
can address. The `?? headerLine` fallback also means an unparseable header
yields a garbage path, which never matches a pattern and is therefore kept.

**Observed impact.** On PR #28 of this repo, five lenses blocked the merge
reporting a planted IDOR and a planted hardcoded credential as real defects in
`src/routes/documents.js` — a file this repository does not contain. Adding
`evals/fixtures/` to `diff_ignore_patterns` did not help, and could not.

**Suggested fix.** Anchor the split to a line start, e.g. split on
`/^diff --git /m`, and skip a chunk whose header does not parse rather than
falling back to the raw line.

**Our workaround (live).** Fixture patches are stored with `DIFFGIT ` where a
real patch says `diff --git `, and decoded at load time — so the token never
appears verbatim on disk and there is no split point to trip over.
`evals/lib/fixtures.mjs` → `decodeFixtureDiff`; enforced for every fixture by
`evals/validate-fixtures.mjs`, which fails the build if a literal `diff --git `
is committed.

---

## 2. `truncateDiffByBytes` can return more than `maxBytes`

**Where:** `packages/pi-orchestrator/src/pi/tools/get-pr-diff.ts`

```ts
const marker = BYTE_TRUNCATION_MARKER(maxBytes);   // "\n... (truncated at N bytes)"
const budget = maxBytes - Buffer.byteLength(marker, 'utf8');   // not floored at 0
let cutAt = Math.min(budget, buf.length);
...
let sliced = buf.subarray(0, cutAt).toString('utf8');
```

**What goes wrong.** The marker is 26 + `digits(maxBytes)` bytes. When
`maxBytes` is smaller than that — anything under roughly 30 — `budget` is
**negative**. `Buffer.subarray` interprets a negative end index as an offset
from the end of the buffer, so instead of slicing nothing it slices *almost
everything*, and the marker is then appended to it. The function returns more
data than the caller asked for: the opposite of its contract.

Reproduction:

```js
truncateDiffByBytes("line one\nline two\nline three\n", 1)
// → "lin\n... (truncated at 1 bytes)"   — 30 bytes returned for a 1-byte cap
```

**Impact.** Cosmetic at production caps (the shipped default is 102400) and no
crash, so this is low severity. It matters to anyone deliberately passing a
small `diff_max_bytes`, who silently gets *more* diff than they budgeted for
rather than less.

**Suggested fix.** Floor the budget at zero — `Math.max(0, maxBytes - markerBytes)` —
or return just the marker when the cap cannot accommodate it.

**Our workaround (live).** The compose step in `action.yml` validates
`diff_max_bytes` before it reaches the engine and refuses anything below a
1024-byte floor, falling back to the shipped default with a warning. Covered by
`evals/contract.test.mjs` → `diff cap validation`. The ported copy of this
algorithm in `evals/lib/pi-diff.mjs` reproduces the defect **deliberately** —
it mirrors the tool rather than improving on it, so a fixture measures what a
lens actually sees — and pins the behaviour in a test so the port cannot be
"fixed" into divergence by accident.

---

## 3. `get_pr_diff` wraps the diff in a markdown fence without escaping it

**Where:** `packages/pi-orchestrator/src/pi/tools/get-pr-diff.ts`

```ts
return diffToolResult(`PR #${pullNumber} Diff:\n\`\`\`diff\n${truncated.text}\n\`\`\``, details);
```

**What goes wrong.** The diff is interpolated into a fenced block with no
escaping. A pull request that changes a file containing a line of three
backticks — a README, a prompt file, any Markdown — closes the fence early. From
the model's point of view the remainder of that file's contents is no longer
quoted tool output but ordinary prose in the conversation.

**Impact.** It is a prompt-injection surface, and an easy one: the attacker
controls the file contents in the PR under review, which is precisely the
untrusted input the fence exists to delimit. Severity depends on the consumer's
prompt — this action wraps the tool result in its own `----- BEGIN DIFF UNDER
REVIEW -----` markers and instructs the lens to treat everything between them as
data, which limits but does not eliminate the exposure.

**Suggested fix.** Choose a fence longer than the longest backtick run in the
payload (the CommonMark rule), or drop the fence and delimit with a token that
cannot occur in a diff.

**Our workaround (partial).** The composed prompt wraps the whole tool result in
`----- BEGIN/END DIFF UNDER REVIEW -----` markers, and `shared_instructions.md`
opens with a trust boundary telling the lens that everything it reads through a
tool is untrusted data and that smuggled instructions are themselves a MUST FIX
finding. Three fixtures (`injection_diff_comment`, `injection_hidden_unicode`,
`injection_pr_body`) measure that the lens reports rather than obeys. The port
in `evals/lib/pi-diff.mjs` reproduces the unescaped fence **deliberately**, for
the same reason it reproduces the byte-budget defect: a fixture has to show a
lens what the real tool would have handed it.
