# Choosing the model a lens runs on

> **Scope.** How to pick the model behind `blind-peer-review`'s lenses, what to
> measure, what it costs, and the results of the first head-to-head. The action
> takes any OpenRouter slug via `model:`; this is the reference for deciding
> which one.
>
> **Method & honesty note.** Pricing and capability flags are read from the
> OpenRouter `/api/v1/models` catalogue (access date **2026-09-13**) and are
> reproducible — every figure below can be re-derived from that endpoint. Token
> volumes come from this project's own lens runs, cited inline. **Review-quality
> rankings come only from `evals/run.mjs` scores, never from impression.** Where
> a model is untested, it is listed as a candidate and labelled untested rather
> than ranked. That distinction is the whole point of this document: the first
> version of this analysis was written from impression, and two of its three
> conclusions did not survive being checked.

---

## 1. Why this needs measuring rather than arguing

Lens quality is easy to have opinions about and hard to be right about. Two
examples from a real triage of this action's output, both of which looked like
model failures and were not:

- **"The acceptance lens emits findings that are just passes."** It does, because
  `lenses/acceptance.md` instructs exactly that: `PASS → NITPICK (a one-line
  "AC-n [PASS]: verified at file:line" confirmation)`. Prompt, not model.
- **"The lens missed three stale docstrings that contradicted the PR."** Those
  lines were not in the diff. The lenses are diff-only by design, so the model
  was structurally unable to see them. Architecture, not model.

What did survive checking, on the same sample: a lens reporting a PR description
as *"missing the required AI-provenance disclosure"* when the description plainly
contained one, then reaching the opposite (correct) conclusion 21 minutes later
on the identical commit. Same input, two answers, one wrong.

The lesson is not "that model is bad." It is that **three of four confident
quality claims were wrong**, and the two instruments that settle such claims
already exist in this repo.

## 2. What actually decides it

`evals/lib/scorecard.mjs` encodes the thresholds a lens set must clear:

```js
mustBlockRecall:   0.8    // fraction of must-block fixtures that block unanimously
jsonValidity:      0.95   // fraction of reps whose output the action could parse
falsePositiveRate: 0      // ANY must-not-block fixture that blocked, in ANY rep
```

`falsePositiveRate: 0` is the one to weight hardest. A lens that blocks a clean
PR does not merely waste a review — it trains the team to route around the gate,
and a gate people route around is worse than no gate. The fixture set includes
cases built for exactly that failure (`acceptance_absent_claim_is_false`,
`acceptance_requirement_invented`, `acceptance_config_not_overread`).

Three properties are hard requirements before quality is even worth scoring:

| Requirement | Why |
|---|---|
| **Tool calling** | `submit_findings_tool` defaults to `true`; the provider validates the findings schema before delivery. Without it a lens falls back to message-only JSON — historically the largest source of failed lens jobs. |
| **Context ≥ 128k** | `diff_max_bytes` defaults to 204800 (~50k tokens), plus persona, shared contract, and the PR thread. |
| **Availability on OpenRouter** | `provider` defaults to `openrouter`. A slug the catalogue does not serve fails the job, not the review. |
| **A ZDR endpoint, if your account requires one** | See below. This one is not in the catalogue. |

### The two filters you cannot read from the catalogue

**Zero-Data-Retention.** If your OpenRouter account enforces ZDR, a model whose
providers all retain data is **unavailable to you**, and nothing in
`/api/v1/models` says so. `/api/v1/models/{slug}/endpoints` does not carry a retention field either.
You find out by calling it:

```
FATAL: OpenRouter 404 for model "z-ai/glm-5.3":
  "0 endpoints out of 1 requested are available matching your guardrail
   restrictions and data policy. We removed them for the following reasons:
   ZDR violation (account settings): 1 endpoint excluded"
```

**Allowed providers.** The second, found the same way. An OpenRouter account can
restrict which providers it will route to at all, and a model served only by
excluded providers is unavailable no matter what the catalogue says:

```
FATAL: OpenRouter 404 for model "x-ai/grok-4.3":
  "No allowed providers are available for the selected model. Providers serving
   x-ai/grok-4.3-20260430: xai, but your account's allowed-providers setting
   permits only: meta, azure, google-vertex, nvidia, openai, mistral, anthropic,
   cloudflare, amazon-bedrock, google-ai-studio, ..."
```

`moonshotai/kimi-k3` failed this one, `z-ai/glm-5.3` the ZDR one. **Three of
eight candidates in the second comparison were never runnable**, from a list
built entirely on catalogue metadata — and the two rejections are different
settings with different fixes, so the message is worth reading rather than
filing under "unavailable".

The practical consequence for a comparison: **include the candidates anyway.** A
blocked model fails in the call phase within seconds and costs nothing, and the
failure is the answer. Filling availability in empirically is more honest than
predicting it — and both settings are account-specific, so no static list is
correct for two readers.

Of 445 catalogue models, **377 support tool calling** and **362 of those clear
128k context** — so these filters exclude little, and any model failing them is
disqualified regardless of how good it is.

## 3. Running the comparison

```bash
# Locally, with your own key — no repo secret involved
export OPENROUTER_API_KEY=...
node evals/run.mjs --full --model anthropic/claude-sonnet-5 --reps 3

# Or in CI, on main only (the live layer refuses other refs by design)
gh workflow run evals.yml --ref main \
  -f set=full -f model=<slug> -f reps=3 -f max_tokens=24000 -f concurrency=8
```

Each run uploads `lens-eval-scorecard-<run_id>` containing `evals/baseline/scorecard.md`
and `baseline.json`.

Dispatch the whole candidate list at once: the concurrency group carries
`inputs.model`, so the runs no longer displace one another (they did until #64 —
GitHub keeps one *pending* run per group, so a fan-out sharing a group silently
dropped all but two and yielded a comparison with holes in it that looked
complete).

> **Read the scorecard header before the scores.** It records the model and the
> ceiling the run actually used. Those come from the plan `compose` wrote, not
> from what you typed, and the one time they disagreed the whole comparison was
> a ceiling nobody asked for (§5). A phase now refuses a setting it cannot apply
> (#72), but the header is what confirms the run you got is the run you meant.

## 4. What a review costs

Grounded in this project's own telemetry rather than a guess. Lens runs on
`jamescrowley321/identity-model` (2026-09-13, `google/gemini-2.5-pro`) reported
**24.0K–56.9K tokens per lens at $0.03–$0.09**, mean ≈35K. The model below is
therefore **33k in / 2.5k out, × 8 lenses per push**; reasoning tokens bill as
output, so the second column assumes 10k out.

| | | $/M in / out | $/push | $/push (10k out) |
|---|---|---|---|---|
| **Current default** | `google/gemini-2.5-pro` | 1.25 / 10.00 | **$0.53** | $1.13 |

**Frontier judgment**

| Model | ctx | $/M in / out | $/push | $/push (10k out) |
|---|---|---|---|---|
| `openai/gpt-6-astra` | 1050k | 10.00 / 50.00 | $3.64 | $6.64 |
| `anthropic/claude-opus-5` | 1000k | 5.00 / 25.00 | $1.82 | $3.32 |
| `moonshotai/kimi-k3` | 1048k | 2.65 / 13.28 | $0.96 | $1.76 |
| `anthropic/claude-sonnet-5` | 1000k | 2.00 / 10.00 | $0.73 | $1.33 |
| `openai/gpt-5.6-sol-pro` | 1050k | 2.00 / 10.00 | $0.73 | $1.33 |
| `x-ai/grok-4.6` | 500k | 2.00 / 6.00 | $0.65 | $1.01 |
| `google/gemini-3.5-flash` | 1048k | 1.50 / 9.00 | $0.58 | $1.12 |

**Strong value**

| Model | ctx | $/M in / out | $/push | $/push (10k out) |
|---|---|---|---|---|
| `x-ai/grok-4.3` | 1000k | 1.25 / 2.50 | $0.38 | $0.53 |
| `z-ai/glm-5.3` | 1310k | 1.09 / 3.43 | $0.36 | $0.56 |
| `google/gemini-3.8-flash` | 1048k | 0.75 / 3.75 | $0.27 | $0.50 |
| `moonshotai/kimi-k2.7-code` | 262k | 0.71 / 3.50 | $0.26 | $0.47 |
| `z-ai/glm-5.2` | 1048k | 0.60 / 2.00 | $0.20 | $0.32 |
| `moonshotai/kimi-k2-thinking` | 262k | 0.60 / 2.50 | $0.21 | $0.36 |
| `minimax/minimax-m3` | 1048k | 0.30 / 1.20 | $0.10 | $0.18 |
| `openai/gpt-5.6-luna-pro` | 1050k | 0.20 / 1.20 | $0.08 | $0.15 |

**Cheap — viable for mechanical lenses (see §6)**

| Model | ctx | $/M in / out | $/push |
|---|---|---|---|
| `mistralai/devstral-2512` | 262k | 0.40 / 2.00 | $0.15 |
| `google/gemini-3.5-flash-lite` | 1048k | 0.30 / 2.50 | $0.13 |
| `z-ai/glm-5.3-flash` | 1310k | 0.15 / 0.50 | $0.05 |
| `deepseek/deepseek-v4.1-flash` | 1048k | 0.15 / 0.60 | $0.05 |
| `qwen/qwen3.8-flash` | 1000k | 0.15 / 0.47 | $0.05 |
| `tencent/hy3` | 262k | 0.08 / 0.33 | $0.03 |
| `z-ai/glm-4.7-flash` | 200k | 0.06 / 0.40 | $0.02 |
| `deepseek/deepseek-v4-flash` | 1048k | 0.05 / 0.09 | $0.01 |
| `inception/mercury-2.5` | 260k | 0.04 / 0.15 | $0.01 |

All of the above support tool calling. `mistralai/devstral-2512` is the only
entry with **no reasoning support** — relevant for the judgment lenses, less so
for mechanical ones.

Note that **several frontier models cost less per push than the current
default**, because `gemini-2.5-pro`'s $10/M output is priced like a frontier
model while its per-token input is not. Moving up-tier is not necessarily a
spend increase.

> [!WARNING]
> **Set `max_tokens` before comparing reasoning models.** Reasoning tokens bill
> against the same ceiling as the reply, so a reasoning model can spend it
> thinking and run out mid-JSON. The action cannot parse a truncated response,
> an unparseable response cannot block, and recall therefore collapses as a
> *consequence* of truncation — the model scores as catastrophically bad at
> review when the measurement was bad instead. `scorecard.mjs` says so when it
> detects it ("a HARNESS limit, not a lens failure"), and the scorecard header
> records the ceiling each run used. Read that line first — it is the line that
> would have caught the dispatched-but-never-applied ceiling in §5 on the day it
> happened.

## 5. Results

Two rounds, 31 fixtures, 3 reps, 123 model calls per model. Both ran **at the
8000-token ceiling**, including the round that was dispatched at 24000 — see the
box below before reading the sonnet row.

Second round, action ref `c756efa`:

| Model | Violations | must-not-block FP | JSON validity | provider errors | Verdict |
|---|---|---|---|---|---|
| `z-ai/glm-5.2` | **1** | **0% on every lens** | 94.9–100% | 0/123 | cleanest measured |
| `google/gemini-2.5-pro` *(incumbent)* | 3 | 11% acceptance, 50% cold_read | 97–100% | 0/123 | false-positives on clean PRs |
| `moonshotai/kimi-k2-thinking` | 6 | 50% cold_read, 50% red_team | 83–100% | 2/123 | more false positives than the incumbent |
| `anthropic/claude-sonnet-5` | 14 | **0% on every lens** | **33–89%** | 1/123 | **not a valid measurement** |
| `openai/gpt-5.6-luna-pro` | 18 | 11% acceptance, 50% cold_read | 89–100% | **73/123** | **not a valid measurement** |
| `z-ai/glm-5.3` | — | — | — | — | no ZDR endpoint |
| `moonshotai/kimi-k3` | — | — | — | — | provider not allowed |
| `x-ai/grok-4.3` | — | — | — | — | provider not allowed |

Three of the eight were never runnable, for the two account reasons in §2. Two
of the five that ran produced numbers that say nothing about review quality, and
the scorecard says which and why rather than ranking them:

- **`gpt-5.6-luna-pro` lost 73 of 123 calls upstream** — 59% of the run, after
  retries. `scorecard.mjs` reports that separately from JSON validity precisely
  so a bad provider hour is not read as a bad reviewer. Nothing in its column is
  a measurement of the model.
- **Sonnet's violations are format, not judgment.** Its false-positive rate is
  0% on every lens — the number weighted hardest here — while JSON validity
  falls to 33%, and recall follows validity because a response the action cannot
  parse cannot block. That is the truncation signature §4 warns about.

> [!IMPORTANT]
> **The re-run that was supposed to settle sonnet has not happened yet.** The
> second round was dispatched at `max_tokens: 24000` and ran every call at
> 8000: `compose` freezes the ceiling into the plan, and `evals.yml` set
> `EVAL_MAX_TOKENS` on the `call` step, which reads the plan rather than the
> environment. The input was accepted and dropped, and every scorecard recorded
> `Max tokens: 8000` correctly while the dispatch said otherwise.
>
> Fixed in #72, which also makes a phase refuse a setting it cannot apply rather
> than ignoring it. Until a round actually runs at a raised ceiling, **the sonnet
> row stays a non-result** — it has now been measured twice under the same cap
> and twice reported as invalid for the same reason.

**The incumbent's 3 violations are real** and they reproduce: two false positives
on must-not-block fixtures (`acceptance_absent_claim_is_false` on the acceptance
lens, `acceptance_downstream_issue` on cold read) plus one truncated rep. A lens
blocking a clean PR is the failure that teaches a team to route around the gate,
and it is the same pair of fixtures that failed in the first round.

**GLM-5.2 is the only model measured with a 0% false-positive rate across every
lens on a run with no provider trouble.** Its single violation is acceptance-lens
JSON validity at 94.9% against a 95% threshold — 37 of 39 reps — which is two
malformed replies, not a pattern. It also costs a third of the incumbent (§4).

For the record, the first round (earlier ref, same 8000 ceiling) put glm-5.2 at 4
violations and the incumbent at 3, with the incumbent's acceptance FP rate at
22%. The direction of both is unchanged; the absolute numbers moved because the
action and the fixtures did. **Neither round licenses a default-model change on
its own** — that decision wants one round at a real ceiling, which is the work
#72 unblocks.

> Every figure above is reproducible with the command in §3, from the scorecards
> attached to runs `34788299034`, `34788304781`, `34788309942`, `34788323330` and
> `34788327297`. Nothing here is an impression; where a number is not
> trustworthy, the row says why instead of reporting a rank.

## 6. One model per lens, not one model per repo

The `review` job is a matrix over lenses and `model:` sits inside it, so each
lens can run on its own model. The action's `mode: config` resolves it — the
caller writes inputs, not a script:

```yaml
- id: pick
  uses: jamescrowley321/blind-peer-review@v3
  with:
    mode: config
    enabled: |
      cold_read
      security
      policy
    lens_models: |
      cold_read = anthropic/claude-sonnet-5
    default_model: google/gemini-2.5-pro
```

Anything unlisted takes `default_model`; drop both inputs to run one model
everywhere. An unknown lens key fails the job rather than silently falling back,
because a config that claims a tiering which is not in force is the failure this
whole area keeps producing.

This matters because the lenses are not the same kind of work. Policy &
Provenance checks whether a checkbox is ticked and whether two lines of the PR
description exist. Cold Read and Red Team are looking for defects nobody has
found yet. Paying frontier rates for the first to get frontier quality on the
second is the only reason to run one model everywhere.

An illustrative split — **numbers are cost, not quality**. §5 has measured only
three models so far, and one of those measurements is not yet valid, so do not
read a tier assignment out of it:

```
cold_read, red_team, security   → frontier tier     3 x $0.09 = $0.28
acceptance, edge_case           → value tier        2 x $0.03 = $0.07
policy, owasp_web, owasp_llm    → cheap tier        3 x $0.01 = $0.02
                                                    ──────────────────
                                                              ~$0.37/push
```

Better judgment where judgment is needed, for less than a single-model frontier
deployment — and less than the current single-model default.

## 7. The trap when you change `model:`

`models_config` pins OpenRouter routing **per model slug**:

```yaml
models_config: |
  { "providers": { "openrouter": { "modelOverrides": {
      "google/gemini-2.5-pro": {
        "compat": { "openRouterRouting": { "zdr": true, "data_collection": "deny" } } } } } } }
```

`scripts/models-config.mjs` validates the structure and the key allowlist. It
does **not** check that the `modelOverrides` key matches the `model:` input. Change
one and not the other and the Zero-Data-Retention floor silently stops applying —
no error, no warning, and the only symptom is diffs routing to providers you
excluded on purpose.

**Whenever you change `model:`, change the `modelOverrides` key in the same
edit.** Under the per-lens matrix of §6 this becomes sharper: every distinct slug
in the matrix needs its own override entry, or the lenses on the slugs you forgot
run without the floor.

The action now warns when the model it is running has no entry:

```
::warning::models_config has routing overrides for 'google/gemini-2.5-pro' but
this lens runs 'anthropic/claude-sonnet-5', so NONE of them apply to this
request — any zdr/data_collection floor they set is silently not in force.
```

A warning rather than an error, because a per-lens matrix legitimately pins a
wider model set than any single run uses. The `config` job also prints the
distinct models it resolved, to cross-check against the block.

This interacts with §2: a ZDR floor that is silently not applied does not fail
loudly the way a ZDR-blocked model does. The model simply routes somewhere you
excluded on purpose, and the review looks completely normal.
