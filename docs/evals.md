# The eval process

> **Scope.** How this project decides whether a lens set works: what is measured,
> how a round is run, how a scorecard is read, and which results are allowed to
> count. `docs/model-selection.md` reports the *findings*; this is the *method*.
>
> Everything here is offline-reproducible except the model calls themselves, and
> every measurement it has produced is committed under `evals/results/`.

---

## 1. What is being measured, and why not "is the review good"

A lens is a reviewer. The useful question is not whether its prose is insightful
but whether its **verdict** is right, because the verdict is the only part that
reaches a pull request. So the suite scores four things per lens:

| Metric | Question | Threshold |
|---|---|---|
| `mustBlockRecall` | Of the changes that *should* block, how many did? | ≥ 0.80 |
| `falsePositiveRate` | Did any clean change get blocked? | **0** |
| `jsonValidityRate` | Could the action parse the reply at all? | ≥ 0.95 |
| `stability` | Does the same fixture get the same verdict across reps? | reported |

`falsePositiveRate: 0` is weighted hardest, and the reason is behavioural rather
than statistical: **a gate that blocks clean code teaches a team to route around
it, and a gate people route around is worse than no gate.** A missed bug costs
one bug; a false positive costs the gate.

It is also, empirically, the metric that replicates — see §6.

## 2. Fixtures

A fixture is a diff plus an expectation, under `evals/fixtures/<id>/`:

```
evals/fixtures/acceptance_absent_claim_is_false/
  ├── *.diff          the change under review
  └── expected.json   which lens, and whether it must block
```

Two classes, and the split matters more than the count:

- **must-block** — a real defect. Measures recall.
- **must-not-block** — clean code that *looks* like it might not be. Measures
  false positives. These are the expensive ones to write and the ones that catch
  the failure mode that actually matters.

`node evals/validate-fixtures.mjs` asserts every diff is well formed and every
expectation is satisfiable before any model is called — a fixture that cannot be
satisfied scores every model identically and silently.

Adding one: create the directory, write the diff and `expected.json`, run the
validator, then run `--set smoke` against a known-good model to confirm it
behaves as intended before it is used to judge anything.

## 3. The three phases, and why they are separate

```
compose  →  call  →  score
```

| Phase | Needs a key? | What it does |
|---|---|---|
| `compose` | no | Freezes model, reps and **ceiling** into `plan.json`, and renders every prompt to disk. |
| `call` | **yes** | Sends what the plan says. The only phase with `OPENROUTER_API_KEY` in scope. |
| `score` | no | Runs the action's own findings parser over the responses. |

The split is a security boundary — the provider key is in scope for exactly one
step, which executes no repo script text — and a reproducibility boundary:
`compose` writes what will be measured, and later phases cannot quietly change
it.

> **The ceiling is frozen at `compose`, not read at `call`.** Two full
> comparisons were dispatched at `max_tokens: 24000` and ran every call at the
> 8000 default, because the workflow set `EVAL_MAX_TOKENS` on the `call` step —
> which reads the plan. Nothing failed; every scorecard recorded 8000 correctly
> while the dispatch said 24000. A phase now **refuses** a setting it cannot
> apply rather than ignoring it (#72).

## 4. Running a round

### Locally, for free, through codex

The `call` phase is the only one that needs a provider key, which is why the
suite in practice only ever ran on `main` — a lens or fixture change could not be
checked before merge without spending. `--provider codex` routes the same
composed prompts through `codex exec` on your own Codex auth instead:

```
node evals/run.mjs --provider codex --fixture acceptance_unimplemented_ac --reps 1
node evals/run.mjs --provider codex --lens security
```

No `OPENROUTER_API_KEY`, no spend. Everything else is identical: the same
fixtures, the same prompts composed from `action.yml`'s own steps, and the same
findings parser scoring the result — so it genuinely exercises the harness.

**What it cannot tell you.** It is not a measurement of the model named by
`--model`, and no amount of care in reading makes it one. Codex serves whatever
model your CLI is configured for; a scorecard from this path therefore prints

```
- **Model:** `codex` (local CLI) — **not a measurement of any named model**
- **Requested slug:** `google/gemini-3.8-flash` (recorded only; codex served this run)
```

and the run header says the same thing before the first call. That is deliberate:
a full set of plausible-looking scorecards for calls that never reached a provider
is the specific way this suite has already misled once.

Two further limits worth knowing. `codex exec` exposes neither temperature nor a
token ceiling, so every rep is the same draw — a stability number from this path
is not comparable to an OpenRouter one, and a ceiling-hit cannot be detected at
all. And the provider deliberately does **not** pass `--output-schema`, unlike the
reviewer path: an eval partly measures whether a model emits a parseable contract
object, and forcing the shape would peg that metric at 100% and measure nothing.

Use it to answer "did my lens edit break a fixture?". Use OpenRouter to answer
"which model should we ship?".


```bash
# one model, locally
EVAL_MODEL=z-ai/glm-5.2 OPENROUTER_API_KEY=... \
  node evals/run.mjs --full --reps 3 --max-tokens 24000

# a comparison, in CI, one dispatch per model
gh workflow run evals.yml -R <repo> --ref main \
  -f set=full -f model=<slug> -f reps=3 -f max_tokens=24000 -f concurrency=8
```

Rules learned the expensive way:

- **One dispatch per model.** They share no concurrency group, so they run in
  parallel without cancelling each other.
- **Design the whole round before firing any of it.** Three narrow reactive
  rounds cost more than one wide one and take longer.
- **Order candidates cheapest-first**, so a budget cap is hit by the least
  informative runs.
- **Estimate the spend first**, from catalogue pricing:
  `(calls × ~20k in ÷ 1e6 × $in) + (calls × ~1.5k out ÷ 1e6 × $out)`. A full
  round is 123 calls per model; across real candidates that has ranged from
  $0.23 to $33.83 each.
- **Include candidates you expect to be blocked.** An unavailable model fails in
  seconds and bills nothing, and availability is an account setting no catalogue
  reports (§7).

## 5. Reading a scorecard

Read the **header** before the scores: it records the model and ceiling the run
*actually* used, which is the only check that the run you got is the run you
meant.

Then read the **reason strings** before the ranks. Every fixture carries one, and
they separate three failures that a single ranking number would merge:

| Reason | Means | Not |
|---|---|---|
| `failed UPSTREAM at the provider after retries` | the call never completed | a bad reviewer |
| `hit the max-tokens ceiling — a HARNESS limit` | the reply ran out of room | a bad reviewer |
| `produced output the action could not accept` | delivered but unparseable | a bad *verdict* |

This is load-bearing. A nine-run comparison once ran against an exhausted credit
cap; every run completed and emitted a scorecard reading 16 violations, 0% false
positives, 84–100% JSON validity. The control proved what those were worth — a
model that scores **3** scored **16**. The reason strings were the only thing
that revealed it as infrastructure.

## 6. What the numbers can and cannot tell you

**Recall does not replicate at n=1.** The same model, same ceiling, same fixtures,
same `reps: 3`:

| Model | Run | acceptance recall |
|---|---|---|
| `gemini-2.5-pro` | `34788304781` | 1.00 |
| `gemini-2.5-pro` | `34788309942` | **0.50** |
| `glm-5.2` | `34802996543` | 0.50 |
| `glm-5.2` | `34805120232` | **1.00** |

Three reps *inside* one run does not stabilise it — the variance lives across
runs, so adding reps to a single dispatch does not buy what it appears to.

**False-positive rate does replicate.** `glm-5.2` has scored 0% on every lens in
every run; `gemini-2.5-pro` has scored 50% `cold_read` in every run at both
ceilings. So:

> **Rank on false positives. Treat recall as provisional until a model has been
> run at least twice at the same ceiling.** One run is enough to disqualify a
> model and not enough to promote one.

**Raising the ceiling buys validity, not quality.** Fixture-reps that hit the
ceiling: 6 at 8000, 0 at 24000. Meanwhile the dominant failure — unparseable
output — did not improve. Raise it so the measurement is honest, not to make a
model score better.

## 7. Availability is an account setting

Two filters are invisible in `/api/v1/models` and decide more than quality does:

- **Zero-Data-Retention.** If the account enforces ZDR, a model whose endpoints
  all retain data is unavailable. It is **per-model, not per-vendor** —
  `claude-sonnet-5` ran while both Fable builds were excluded.
- **Allowed providers.** An account can restrict which providers it routes to.
  **The vendor prefix in a slug is not the serving provider**:
  `nvidia/nemotron-3.5-lightning` is served by `darkbloom, phala, deepinfra,
  coreweave`, so it is rejected even though `nvidia` is on the allow-list.

Both surface as an OpenRouter **404 whose message names the reason**. Read it —
the two have different fixes. Of eight catalogue-qualified candidates in one
round, **six were unavailable**, split evenly between the two.

## 8. Guard rails

Each exists because its absence cost a round:

| Guard | Stops |
|---|---|
| **Dispatch refusal** — the launcher verifies the deployed workflow sets the ceiling on `compose` before firing | Dispatching into a silent 8000 default |
| **`402` is fatal** | Retrying a payment error 123 times and scoring the result |
| **Early bail-out** — ≥80% upstream failure over the first 10 calls abandons the run | Paying for 123 calls to learn the provider is down |
| **No scorecard on an abandoned run** | The absent artifact cannot be misread; a caveated one demonstrably can |
| **Health check** — a run that tested many mutants and killed none is config drift, not bad tests | Waiving away a broken harness |
| **`validate-fixtures`** | A fixture that scores every model identically |

## 9. The results store

Workflow artifacts expire in 30 days. A document that cites run ids for
reproducibility stops being reproducible a month later, so every measurement is
committed:

```
evals/results/<round>/<model>.<run-id>.json   # baseline + computed validity
evals/results/<round>/<model>.<run-id>.md     # the scorecard as rendered
```

```bash
node evals/collect.mjs                          # render every stored round
node evals/collect.mjs --round <name>
node evals/collect.mjs --ingest <dir> --round <name>
```

Scorecards quote the provider's raw error verbatim, and those bodies carry
account state — available-credit messages, `in_flight_budget_exhausted`. The
store is public and permanent, so **`ingest` scrubs provider error bodies**,
keeping the status code and model (402 = credit, 429 = rate limit) and dropping
the prose. The classification is the diagnostic signal; the billing detail is
not.

`collect.mjs` computes a validity class from the reason strings and **refuses to
rank anything that is not a measurement**:

| Class | Upstream failures | Treatment |
|---|---|---|
| `measured` | < 10% | ranked |
| `degraded` | 10–50% | reported, not ranked |
| `void` | ≥ 50% | listed so it is not re-run as if missing |

The void section is the point. It currently lists `glm-5.2` at 16 violations
directly below the measured section listing the same model at 2 — the same
model, the same ceiling, one number real and one an artifact of a dead provider.
