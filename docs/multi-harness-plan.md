# Multi-harness lens library — revival plan

> **Historical plan — reconciled 2026-10-01.** The September 7 branch status
> below is an archive, not an active to-do list. The plugin, shared registry,
> shared JSON contract, vendoring installer and Codex dispatch have since shipped
> through v3.3.0. See the current-status section before reviving any work item.
>
> Original plan written 2026-09-07 against `main` @ `0e5a06a` (v1.8.0).

## Current implementation and backlog reconciliation

The released baseline is **v3.3.0** (`version.txt`). The records below distinguish
code that exists from host integration checks that still need evidence.

| Historical item | Current evidence / remaining work |
|---|---|
| W0/W1 — local verdict and shared contract | `contracts/shared_review_contract.md` defines JSON findings; local runners adjudicate parsed severity and fail on invalid output. Offline local tests exist. Personas still contain CI tool wording; decoupling it remains a separate prompt change requiring evals. |
| W2 — plugin distribution and naming | `.claude-plugin/` ships `blind-peer-review@blind-peer-review`, with `/blind-peer-review:check`; release-please tracks both manifest versions. A fresh host install and PASS/BLOCK smoke run are integration checks, not implied by JSON manifest validation. |
| W3 — registry | `lenses/manifest.json` supplies the shared keys and display names to the action and local tooling. |
| W4 — Codex/Cursor | `scripts/vendor.mjs` installs version-stamped local assets; `scripts/dispatch-codex.mjs` runs one read-only Codex process per lens. Cursor has an adapter template; loading/activation and fresh per-lens conversations still need a real Cursor runtime check. |
| Cross-family plugin routing | Shipped in [v3.2.0](../CHANGELOG.md): the plugin prefers Codex dispatch when available and falls back to in-host Claude subagents with a same-family disclosure. It does not guarantee a different model family in every host. |
| Maintenance under review | Current maintenance addresses empty lens selections, tracked working-tree coverage, provider-budget preflight and dependency-pin verification. These fixes are not part of the released v3.3.0 baseline. |
| Further feature proposals | CI base-branch persona overrides and a deduplicated findings report are being implemented separately. Per-lens cross-model routing, focus input, recursion guard, and plan/prompt-review modes remain proposals, not completed acceptance checks. |

### Issue #2 — harness adapters

[#2](https://github.com/jamescrowley321/blind-peer-review/issues/2) still describes
an unmerged old branch and the former plugin namespace. The namespace decision,
plugin artifacts, vendoring path, and preferred out-of-host Claude → Codex routing
have shipped. Codex and Cursor templates exist. Its original acceptance also asks
for actual host loading and out-of-host review verification: Cursor still uses
in-host fresh chats unless the caller chooses the pi runner. A Codex adapter in a
Codex-authored session also cannot promise a different model family. Recommend
rescoping the issue to those host checks and explicit routing expectations,
rather than claiming all its acceptance criteria are satisfied.

### Issue #33 — lens naming

[#33](https://github.com/jamescrowley321/blind-peer-review/issues/33) proposed
seven acceptance criteria. Descriptive names and snake_case keys shipped as the
[v2.0.0 breaking rename](../CHANGELOG.md); the original proposal was not adopted
verbatim.

| Acceptance | Current status |
|---|---|
| AC-1: H1 equals display name with no subtitle | **Outstanding.** Current H1s retain subtitles, e.g. `# Security Review — Exploitable Vulnerability Agent`. No persona prompts are changed by this reconciliation. |
| AC-2: no display-name containment | Current manifest names are distinct; offline cross-lens identity tests guard against accepting another lens's output. |
| AC-3: old keys resolve with deprecation warning | **Not implemented.** The v2.0.0 release deliberately required callers to migrate their keys. Decide whether this historical compatibility requirement should be superseded. |
| AC-4: retain old display-name aliases | **Not fully implemented.** The parser keeps current heading/subtitle aliases and an older OWASP heading; it does not retain the complete former `Sentinel`/`Viper`/`Blind Hunter` roster. Decide whether old-release output compatibility remains needed. |
| AC-5: docs/examples/workflow use new keys | Current README, caller example and self-review workflow use manifest keys; CONTRIBUTING now describes the eight-persona roster. |
| AC-6: release notes call out required-status-check rename | v2.0.0 records a breaking name/key/path migration, but does not explicitly explain branch-protection check-name migration. That guidance still needs a targeted migration note if this criterion is retained. |
| AC-7: contract suite passes without todo | Offline contract checks pass on this maintenance branch; this does not establish the unfulfilled criteria above. |

Recommend updating #33's scope before closing it. Removing H1 subtitles is a
prompt change requiring fixtures and model evals, and compatibility policy needs
an explicit decision. No issue or PR state was changed as part of this audit.

## Archived September 7 plan


---

## 1. What the revive actually did

The old branch (`feat/claude-code-plugin`, 2 commits, 2026-08-13) was 2 ahead / **93 behind**
`main`. It could not be merged or rebased as-is — its diff against `main` read as a 10,000-line
deletion, because everything `main` gained since Aug 13 (the eval harness, `submit_findings`,
release-please, `models_config`) was simply absent from it.

Both commits were cherry-picked onto current `main` instead:

| Commit | Content |
|---|---|
| `33aae5d` | Claude Code plugin + harness-neutral lens library (was `935de99`) |
| `21d8d32` | Market analysis + roadmap doc (was `9e1be80`) |

Three conflicts, all the same shape — the branch predating `main`'s newer content:

| File | Resolution | Why |
|---|---|---|
| `action.yml` | took `main` wholesale | The branch's only change here was removing the `compliance_rules_file` input. That injection fix **already landed on `main`** by another route, so the branch had nothing left to contribute. |
| `CHANGELOG.md` | took `main` wholesale | release-please owns this file now. Hand-editing already-released sections rewrites history; the entry will be generated from the conventional commit instead. |
| `README.md` | hunk 1 → `main`, hunk 2 → branch | Hunk 1 was `main`'s newer inputs table (`dismiss_superseded`, `cleanup_agent_comments`). Hunk 2 was the branch's genuinely new sentence about the local `.blind-peer-review/lenses/` override. |

`scripts/run-local.mjs`, `.gitignore`, `lenses/compliance.md`, `docs/security-hardening.md` and
`.github/blind-peer-review/compliance.md` auto-merged.

The old branch pointer is untouched at `9e1be80` until you're happy with the replay.

**Net new on the branch** (none of this ever reached `main`):

```
.claude-plugin/plugin.json          .claude-plugin/marketplace.json
skills/review/SKILL.md              agents/{acceptance,blind,compliance,edge_case,
lenses/manifest.json                        owasp_llm,owasp_web,security,red_team}.md
lenses/shared_review_contract.md    adapters/{README.md,codex/AGENTS.md,
lenses/README.md                             cursor/blind-peer-review.mdc}
docs/market-analysis-and-roadmap.md
```

## 2. Verified state of the branch

```
main:   node --test evals/contract.test.mjs  →  147 tests, 147 pass, 0 fail
branch: node --test evals/contract.test.mjs  →  149 tests, 144 pass, 5 fail
```

**All 5 failures have one cause.** `evals/lib/lenses.mjs::shippedLensKeys()` enumerates lenses by
reading `lenses/*.md` and excluding exactly two names:

```js
.filter((f) => f.endsWith(".md") && f !== "shared_instructions.md" && f !== "README.md")
```

The branch adds a third non-lens file to that directory — `shared_review_contract.md` — so the
harness treats it as a ninth lens with no entry in `action.yml`'s `NAMES` table, and
`norm(undefined)` throws. The test count rising 147 → 149 is the same fact: two of the checks are
parameterised per shipped lens.

Not a design flaw in the branch, and **not** a symptom of the 93-commit gap. A file was added to a
directory that an unrelated module treats as a registry.

`.github/workflows/lint.yml`'s layout check uses a hardcoded `LENSES` array, so it does **not**
break — which is itself the finding in §5.

## 3. Strategic frame (from the branch's own market analysis)

Worth restating before planning work, because it constrains how much to invest where. The Aug-13
analysis concluded, about this exact branch:

> the "harness-neutral portable persona library" idea is **not** a defensible moat — it is already
> a crowded, proven pattern.

The defensible wedge it identified: OSS + self-host + BYO-model + a **fail-closed** CI gate + a
documented prompt-injection threat model + an OWASP-LLM lens. Native reviewers (Copilot, Duo,
BugBot) are advisory — Copilot can only post a `COMMENT` review and cannot block a merge.

**Implication for this plan:** multi-harness is a *distribution* play, not the differentiator.
That argues for spending real effort on the one rail that carries distribution (the Claude Code
plugin marketplace) and keeping Codex/Cursor cheap until something proves demand.

## 4. What is actually wrong with the branch (beyond the test break)

### 4.1 The local verdict can false-BLOCK — correctness bug

`skills/review/SKILL.md` §5 adjudicates by substring:

> A lens **BLOCKS** if its section contains any `MUST FIX`.

A lens whose section reads *"No MUST FIX findings."* blocks the review. Every clean run is a coin
flip on phrasing. CI does not have this problem: it parses a JSON `severity` field.

### 4.2 Two output contracts have diverged

| Path | Contract | Transport |
|---|---|---|
| CI / pi | `lenses/shared_instructions.md` | `submit_findings` tool call, schema-validated by the provider |
| Local (plugin/Codex/Cursor) | `lenses/shared_review_contract.md` | markdown `## <Lens Name>` section, free text |

`submit_findings` (PR #42) postdates the branch by three weeks. The neutral contract was written
when both paths emitted markdown. The trust-boundary and severity halves of the two files agree;
only the envelope diverges.

**Live evidence, 2026-09-07:** `healthcloud-console-web` #85 had its Red Team lens return invalid
JSON and block the Merge Gate, while the same lens passed on `healthcheck-hl7-pdex` #15 in the same
sweep. Malformed lens output is still occurring on the CI path — the failure class PR #39 was
closed against. Worth a measurement before deciding whether that closure still holds.

### 4.3 The local path has zero eval coverage

29 fixtures × the contract suite all exercise the CI parse step. Nothing tests the markdown
envelope, the override resolution, or the local adjudication — which is why §4.1 is sitting there
undetected.

### 4.4 The personas are CI-coupled, and the adapters paper over it

All 8 personas name `get_pr_diff` and carry `__PR_NUMBER__`; `shared_instructions.md` names
`submit_findings`. Every local adapter compensates with a variant of *"the persona may mention
GitHub tools — ignore that CI wording; you are local."* Telling a reviewer to disregard part of
its own instructions is a prompt-quality smell and it scales badly to a third and fourth harness.

The clean split: **persona = judgment criteria only**; **adapter = how to fetch the diff and where
to put findings**.

### 4.5 Plugin version will rot

`plugin.json` and `marketplace.json` both pin `1.3.0`; the repo is at `1.8.0`. release-please is
configured `release-type: simple` with no `extra-files`, so it bumps `version.txt` and `CHANGELOG.md`
and will never touch the plugin manifests.

### 4.6 Codex/Cursor adapters are not installable

Both are paste-templates whose footer instructs the consumer to *"vendor `lenses/` into the repo
so the paths resolve."* No versioning, no update path, no way to tell which lens revision a repo
is running. This is the weakest part of the branch and the least load-bearing — see §3.

### 4.7 Needs verification before publishing

- `skills/review/SKILL.md` declares `allowed-tools: Read, Grep, Glob, Bash, Task` and spawns
  `Task` subagents. This session's runtime exposes the subagent tool as **`Agent`**. Confirm which
  name current Claude Code accepts in skill frontmatter before publishing — if it's wrong the skill
  degrades to sequential inline review and silently loses the fresh-context property that is the
  entire method.
- Plugin/marketplace manifest schema (field names, `source: "./"` for a single-plugin repo) against
  current Claude Code.
- `${CLAUDE_PLUGIN_ROOT}` interpolation inside skill and agent bodies.

## 5. The registry problem underneath all of this

There are now **four** definitions of "the set of lenses":

| # | Location | Form |
|---|---|---|
| 1 | `.github/workflows/lint.yml` | hardcoded `LENSES` array |
| 2 | `action.yml` | `const NAMES = {…}` table (evals parse it back out) |
| 3 | `evals/lib/lenses.mjs` | `readdirSync("lenses")` minus an exclusion list |
| 4 | `lenses/manifest.json` | **new on this branch** — key, name, activation, default_enabled, summary |

The branch's stated purpose was "one lens registry", but it added a fifth source rather than
collapsing the others — which is precisely how it broke #3. Fixing this properly removes the whole
class of failure, and it is the strongest technical argument for the branch existing at all.

## 6. Plan

Small PRs, each green before the next, each through the adversarial gate. Note the gate's own
provenance rule: **the PR body must name the AI harness and model plus a human-accountability
line**, or the Compliance lens blocks the merge.

### W0 — Get the revived branch green *(blocking, small)*

Two ways to fix §2:

**DONE.** Both candidate fixes were measured, and each reached 147/147 on its own, so both
were applied:

- `lenses/shared_review_contract.md` → `contracts/shared_review_contract.md` (13 references
  updated). `lenses/` is read as a registry, so a non-lens file in it gets enumerated as a lens.
- `evals/lib/lenses.mjs::shippedLensKeys()` now reads `manifest.json` instead of listing the
  directory — 3 lines.

**Correction to the framing above:** this plan originally called the registry fix "structural,
risky, do it last." That conflated two things. Making the *eval harness* manifest-driven is
trivially safe. Making *`action.yml`* manifest-driven is the risky one, because other repos'
merge gates depend on that file. Only the second waits for W3.

### W1 — Make the local path correct *(the real work)*

1. **DONE — killed the substring verdict (§4.1).** Local lenses now emit the same JSON object the
   CI schema defines; the skill, both adapters and `run-local.mjs` adjudicate on parsed `severity`.
   Each carries an explicit note against reintroducing substring matching. Unreadable output is a
   FAILED lens and blocks — a review nobody could parse has not passed.
2. **DONE — reconciled the two contracts (§4.2).** The contract states the envelope shape once;
   each harness states only its transport (`submit_findings` in CI, the final message locally).
3. **DONE (found while doing the above) — `run-local.mjs` had no trust boundary at all.** The pi
   local path built its own inline markdown envelope and never loaded any shared contract, so a
   local run had no injection defence. It now injects `contracts/shared_review_contract.md`, writes
   `.blind-peer-review/out/<key>.json`, and exits non-zero on a BLOCK.
4. **Extend the eval harness to the local path (§4.3).** Reuse the existing fixtures against the
   local adjudicator. Minimum bar: a fixture whose lens output contains the literal words "no MUST
   FIX findings" must **PASS**, and that test must fail against today's SKILL.md.
5. **Decouple personas from CI wording (§4.4).** Move `get_pr_diff` / `__PR_NUMBER__` / tool naming
   out of the 8 personas into `shared_instructions.md` (CI) and the adapters (local); delete every
   "ignore that CI wording" instruction.

**Done when:** the same fixture set passes on both paths, no adapter tells a lens to disregard its
own persona, and CI behaviour is unchanged (the existing 147 tests are the regression net).

### W2 — Ship the Claude Code plugin *(the distribution rail)*

1. **`Task` is confirmed correct** — two official Anthropic marketplace plugins
   (`pr-review-toolkit`, `hookify`) declare `Task` in `allowed-tools` today. The branch was right;
   no change needed. The remaining §4.7 items (manifest schema, `${CLAUDE_PLUGIN_ROOT}`) still
   need checking.
2. Wire release-please `extra-files` so `plugin.json` and `marketplace.json` track `version.txt` (§4.5).
3. Add a lint step: manifests parse, versions match `version.txt`, and every lens in
   `manifest.json` has both `lenses/<key>.md` and `agents/<key>.md`.
4. Install it from a scratch repo via `/plugin marketplace add jamescrowley321/blind-peer-review`
   and run `/blind-peer-review:check` against a fixture diff end-to-end.
5. Decide the name-collision question the market analysis raised (§6 of that doc) **before**
   the marketplace entry is public — a same-named competitor is easier to fix now than after
   anyone installs it.

**Done when:** a clean install produces a correct BLOCK on a known-bad fixture and a correct PASS
on a known-good one.

### W3 — One registry *(structural, own PR)*

`lenses/manifest.json` becomes the single source; lint, `action.yml`, `evals/lib/lenses.mjs`,
`run-local.mjs` and the plugin all read it. Retire the hardcoded array and the readdir.

**Risk — this is the highest blast-radius item in the plan.** `action.yml` is consumed as the PR
gate by other repos; a bad change there breaks their merges, not just this repo's. Ship it alone,
after W0–W2, on the strength of the eval suite.

### W4 — Codex / Cursor *(cheap until demand appears)*

pi is already served by `run-local.mjs`. For the other two, pick one distribution mechanism
(§4.6) — an `npx blind-peer-review init` that vendors `lenses/` and writes the adapter file is
the only option that also serves people not on Claude Code. Verify current Codex `AGENTS.md` and
Cursor `.cursor/rules/*.mdc` conventions before writing either.

Hold this behind evidence that anyone wants it. Per §3 it is not the moat.

### W5 — Docs

- `docs/market-analysis-and-roadmap.md` is a point-in-time Aug-13 analysis and should be labelled
  as one. One item is already false: NEXT proposes "OWASP rule packs as `compliance_rules_file`
  presets", an input that no longer exists — it was removed as the injection fix.
- Fold this plan's outcome back into that roadmap's NOW section rather than keeping two roadmaps.

## 7. Decisions I need from you

1. **W0:** minimal fix now and registry later (recommended), or do the structural fix in one go?
2. **W1.1:** local lenses emit JSON (recommended — reuses the tested schema), or keep markdown and
   adjudicate on a stricter structure?
3. **W2.5:** resolve the name collision before the marketplace entry goes public — coexist with a
   scoped identity, or rename?
4. **W4:** build the `init` vendoring path, or leave Codex/Cursor as paste-templates until someone
   asks?
5. **Scope of the first PR:** revive + W0 only (small, reviewable), or revive + W0 + W1?

## 8. Repo state right now

| | |
|---|---|
| Worktree | `/home/james/repos/blind-peer-review--plugin` |
| Branch | `feat/multi-harness-lenses` — 2 ahead of `origin/main`, **not pushed** |
| Old branch | `feat/claude-code-plugin` @ `9e1be80` — preserved, delete once the replay is accepted |
| Tests | 144/149 — 5 failures, cause known (§2), fix not applied |
