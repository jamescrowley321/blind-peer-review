# Choosing the model a lens runs on

> **Scope.** How to pick the model behind `blind-peer-review`'s lenses, what to
> measure, what it costs, and the results of four measured rounds. The action
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

**Cheap — viable for mechanical lenses (see §7)**

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

Note that **the current default is not cheap for what it is**:
`gemini-2.5-pro`'s $10/M output is priced like a frontier model while its
per-token input is not, so at $0.53/push it sits above every model in the Strong
value tier while scoring below the best of them (§5).

Every model in the Frontier judgment table costs *more* per push than the default
— $0.58 to $3.64 against $0.53 — so moving up-tier is a real spend increase, and
on this project's evidence it has not bought anything. **The measured winner,
`google/gemini-3.8-flash`, is in the Strong value tier at $0.27/push: half the
default's cost and the only clean scorecard in four rounds.**

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
>
> The detector earns its keep and bounds its own importance: it fired on 6
> fixture-reps at 8000 and none at 24000 (§5). Raising the ceiling removes this
> failure mode completely — and changes almost nothing else, so do it to make the
> measurement valid, not to make a model score better.

## 5. Results

Four rounds. **Round three is the first that ran at the ceiling it was dispatched
at** — rounds one and two silently ran every call at 8000 (#72). Round four
widened the field. Round five is void and is reported here because how it failed
is worth more than what it "measured".

### The result

| Model | Violations | must-not-block FP | JSON validity | stability | provider errors | $/run |
|---|---|---|---|---|---|---|
| **`google/gemini-3.8-flash`** | **0** | **0% every lens** | **100%** | **100%** | **0/123** | **2.54** |
| `z-ai/glm-5.2` | 3 | 0% every lens | 88–100% | 92–100% | 0/123 | 2.08 |
| `openai/gpt-6-astra` | 3 | 11% acceptance, 50% cold_read | 97–100% | 100% | 0/123 | 33.83 |
| `google/gemini-2.5-pro` *(incumbent)* | 5 | **50% cold_read** | 89–100% | 86–100% | 0/123 | 4.92 |
| `openai/gpt-5.6-luna-pro` | 14 | 22% acceptance, 50% cold_read | 88–100% | 85% | 26/123 | — |
| `anthropic/claude-sonnet-5` | 16 | 11% acceptance | 21–83% | 33% | 0/123 | — |
| `moonshotai/kimi-k2-thinking` | 17 | 22% acceptance, 100% cold_read | 91–100% | 0% | 26/123 | — |

`gemini-3.8-flash` is the only clean scorecard in four rounds: every lens at 0%
false positives, 100% JSON validity across all 123 reps, 100% verdict stability,
full recall on seven of eight lenses and 80% (4/5) on `security`. Zero upstream
failures. It is also **cheaper than the incumbent it replaces**.

It matters that it is the same family one generation on. The incumbent's defining
defect is a 50% `cold_read` false-positive rate, and the mechanism is known: a
training cutoff predating 2026 makes it read legitimate 2026 dates and
identifiers in a diff as fabricated — it has issued a `MUST FIX` against a real,
current CVE on that basis. At 3.8-flash that rate is 0%. **The fix was a newer
model in the same family, not a change of vendor.**

### Availability is an account setting, and it dominates

Round four dispatched eight candidates chosen purely on catalogue metadata
(tool calling, ≥128k context). **Six were unavailable**, in seconds, at no cost:

| Model | Rejected by | Detail |
|---|---|---|
| `z-ai/glm-5.3-flash` | **ZDR** | 1 endpoint excluded |
| `deepseek/deepseek-v4-pro-0813` | **ZDR** | 1 endpoint excluded |
| `anthropic/claude-fable-5.1` | **ZDR** | 4 endpoints excluded |
| `anthropic/claude-fable-5` | **ZDR** | (round five) |
| `qwen/qwen3.8-max-0902` | allowed-providers | served only by `alibaba` |
| `x-ai/grok-4.6` | allowed-providers | served only by `xai` |
| `nvidia/nemotron-3.5-lightning` | allowed-providers | served by `darkbloom, phala, deepinfra, coreweave` |

The last row is the trap: the slug is `nvidia/` and `nvidia` **is** on the
account's allow-list, but **the vendor prefix in a slug is not the serving
provider**. No amount of catalogue reading predicts that. Note also that ZDR is
per-model, not per-vendor — `claude-sonnet-5` ran fine while both Fable builds
were excluded.

This is why §2 says dispatch the candidates anyway. A blocked model answers in
seconds and bills nothing; a predicted one answers never.

### Round five: void, and instructive

Nine dispatches (`claude-opus-5`, `claude-opus-4.8`, `claude-fable-5`,
`gpt-6-astra-pro`, `gpt-5.6-terra-pro`, `gemini-3.7-flash`,
`mistral-medium-3-5`, and two `glm-5.2` repeats) ran **after the account's
monthly credit cap was exhausted** by rounds three and four. Every call returned
**402** (credits) or **429** (rate limit).

The glm-5.2 repeat is the control that proves it: the same model that scores **3
violations** scored **16**, with all 41 fixtures reporting *"failed UPSTREAM at
the provider after retries — infrastructure, not a lens result."*

**Not one number from round five is a measurement, and Opus remains untested.**

The danger is that the scorecards still *look* like results — 16 violations, 0%
false positives, 84–100% validity. Ranked naively, `opus-4.8` and
`gemini-3.7-flash` would appear to have tied each other and lost badly to
`gemini-3.8-flash`. All of it is noise. **The only thing that made it detectable
was the reason string on every fixture.** A scorecard that reported scores
without reasons would have put this straight into the table above as fact.

> Round three is runs `34802992000` (gemini-2.5-pro), `34802996543` (glm-5.2),
> `34803000910` (claude-sonnet-5), `34803005520` (kimi-k2-thinking),
> `34803009816` (gpt-5.6-luna-pro). Round four is `34804028580`
> (gemini-3.8-flash) and `34804056266` (gpt-6-astra), plus six availability
> rejections. All at ref `760dae8`, `max_tokens: 24000`. Round five
> (`348044*`) is void — cited so it is not re-run in the belief it is missing.

## 6. What these numbers can and cannot tell you

The most useful thing this comparison produced is a measurement of its own
reliability. Read this section before ranking anything.

### The suite is underpowered for recall, and it says so

`gemini-2.5-pro` was run twice at the same ceiling, on the same fixture set, at
`reps: 3`. The two runs disagree:

| Run | Violations | acceptance recall | mean recall | min stability |
|---|---|---|---|---|
| `34788304781` | 2 | **1.00** | 1.00 | 0.92 |
| `34788309942` | 3 | **0.50** | 0.94 | 0.75 |

Same model, same ceiling, same fixtures, same number of reps. Acceptance recall
halved. **Three reps inside one run does not stabilise recall** — the variance
lives across runs, not across reps within a run, so adding reps to a single
dispatch does not buy what it looks like it buys.

`glm-5.2` shows the same swing across rounds (acceptance recall 1.00 at 8000,
0.50 at 24000). It is tempting to read that as a ceiling effect. It is not
distinguishable from the variance the incumbent shows at a *fixed* ceiling, and
the honest reading is that one run cannot tell those apart.

### False-positive rate replicates; recall does not

The same data that makes recall untrustworthy at n=1 leaves the
false-positive axis solid:

| Model | FP profile, every round, both ceilings |
|---|---|
| `z-ai/glm-5.2` | **0% on every lens**, consistently |
| `google/gemini-2.5-pro` | **50% cold_read**, consistently |

That is four runs for the incumbent and three for the challenger, at two
ceilings, with the same answer each time. So:

> **Rank on false positives. Treat recall as provisional until a model has been
> run at least twice at the same ceiling.** A single run is enough to disqualify
> a model on false positives and not enough to promote one on recall.

This is also why §2 weights `falsePositiveRate: 0` hardest — it turns out to be
both the most damaging failure *and* the most reliably measured one.

### The recommendation is held to the same standard

`gemini-3.8-flash` has been run **once**. By the rule directly above, its recall
is provisional — a clean sweep is exactly the kind of result a single run can
flatter. Two things stop that from being fatal:

- Its **false-positive rate is 0% on every lens**, and that is the axis that
  replicates at n=1. On the measure that decides the ranking, one run is enough.
- The defect it has to beat is not a close call. The incumbent's 50% `cold_read`
  false positives reproduce in **every** round at **both** ceilings, with a known
  mechanism. Replacing a reproducible defect with a clean sweep is a different
  claim from separating two models by a violation or two.

**It should still be re-run twice at 24000 before the recall figure is quoted as
settled.** That costs about $5 and was blocked only by the exhausted cap (§5).
Until then, quote the false-positive result and label the recall provisional —
which is the same standard applied to every other row here.

### Three things that are not the model, and are reported separately

A comparison that ranks on a single number will rank infrastructure. The
scorecard deliberately refuses to:

| Signal | What it means | Why it is not a review-quality score |
|---|---|---|
| `failed UPSTREAM at the provider` | the call never completed after retries | `gpt-5.6-luna-pro` lost 73 of 123 calls in round two — 59% of the run. Nothing in that column measures the model. |
| `hit the max-tokens ceiling` | the reply ran out of room | A harness limit. It was real at 8000 (6 fixture-reps) and gone at 24000. |
| `output the action could not accept` | delivered, but unparseable | A contract failure. More headroom does not fix it — see §5. |

Read the reason strings before the ranks. Every number in this document that is
not trustworthy has a reason string saying why.

### A dispatch that cannot lie about what it ran

Rounds one and two were dispatched at `max_tokens: 24000` and ran every call at
8000, because `compose` freezes the ceiling into the plan and the ceiling was
being set on `call`. Nothing failed; every scorecard recorded `8000` accurately
while the dispatch said otherwise. Two full comparisons were spent before anyone
read the header against the dispatch.

The lesson generalises past this one bug: **when the failure mode is silent, the
guard belongs in the launcher, not in the review.** The round-three dispatcher
refuses to fire unless `main` actually sets the ceiling on the compose step:

```
REFUSING: main's evals.yml does not set EVAL_MAX_TOKENS on the compose step (no).
  Merge #72 first, or every run below silently uses the 8000 default.
```

It checks the deployed workflow, not the local checkout, because the runs execute
against `main`. A guard that reads the wrong copy is not a guard.

### Bail out early, or pay 123 calls to learn nothing

Round five burned nine full runs discovering that the credit cap was exhausted.
Every one completed, and every one emitted a scorecard. The harness had the
information to stop at call three and kept going to call 123, nine times.

Two rules fix this, and both belong in `run.mjs` rather than in the reader:

| Rule | Why |
|---|---|
| **Abort when the opening calls fail upstream.** More than ~80% upstream failure across the first 10 calls → exit non-zero, emit **no** scorecard, report "provider unusable, not measured". | A run whose first ten calls all failed has nothing to learn from the remaining 113. |
| **Abort on the first 402.** | A payment error is never transient and never a lens result. It should stop the run *and* every run queued behind it — the failure is account-wide, not per-model. |

A third is worth considering: once a model has recorded false positives on two
lenses it is already disqualified by §2's own weighting, so the remaining
must-block fixtures are only refining a number that will not change the decision.

**Emit no scorecard on an aborted run.** This is the important half. A scorecard
that exists will be read, and round five's looked entirely plausible. The safe
failure is an absent artifact, not a caveated one.

### Budget the round before you dispatch it, not after

Rounds three through five spent a $100 monthly cap without anyone tracking the
running total, and the overrun landed as corrupted data rather than as a billing
error — which is the expensive way to find out.

- **Estimate the whole round up front** with the formula below and compare it to
  what is left, not to what the cap is.
- **Design one wide round, not three narrow ones.** Each of rounds three, four
  and five was a reaction to the previous one. A single round of the eight
  candidates that actually mattered would have cost less than the three did and
  finished sooner.
- **Frontier tier has not won anything here.** The clean scorecard came from a
  $2.54 model; the two $33.83 models produced false positives and a void run.
  Order candidates cheapest-first so a cap is hit by the least informative runs.

### Cost before you spend it

A full comparison is 123 model calls. Estimate before dispatching, from the
catalogue's own pricing, rather than after:

```
est $ = (123 x ~20k input / 1e6) x $in_per_M
      + (123 x ~1.5k output / 1e6) x $out_per_M
```

Across the candidates in §5 that ranges from **$0.23** to **$33.83** per model —
a two-order-of-magnitude spread that decides how wide a round you can afford. The
frontier tier is not where the wins have been.

### What a round costs in wall-clock

Models do not finish together. In round three the four challengers completed in
roughly the time the incumbent took to reach its halfway point, and the control
was still running long after the rest were collected. Collect what has landed
rather than blocking on the slowest — but do not conclude until the control is
in, because the incumbent is the row every decision is measured against.

## 7. One model per lens, not one model per repo

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

## 8. The trap when you change `model:`

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
edit.** Under the per-lens matrix of §7 this becomes sharper: every distinct slug
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
