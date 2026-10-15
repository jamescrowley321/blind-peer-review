# Required-test evidence: Jev shadow evaluation

This standalone experiment never changes BPR reviewers, findings, severity or the
merge gate. It classifies `visible_missing`, `visible_present`, or `unverifiable`.

## Corpus and provenance

`jev-required-test-cases.json` contains 30 agent-authored synthetic draft cases in
10 related families and 3 original development cases used to tune the question.
Labels have rationales, but **are not independently human validated**. The synthetic
variants are neither executable application tests nor an independent production
benchmark. Review each label before relying on a ranking; keep development and
test results separate. A whole-diff label describes the visible relevant suite,
not proof that no other tests exist elsewhere in a repository.

The path-only baseline assumes a test is present when the named test path appears
in the diff; otherwise it abstains. It cannot judge assertion quality or partial
hunks. Its limitations are deliberately visible rather than disguised as an AI
baseline. No threshold is used to authorize an action.

## Run and rescore

```bash
node evals/jev-evidence.mjs --phase compose --reps 3 --work /tmp/jev-round-1
# Set OPENROUTER_API_KEY only for this phase, via your secret manager:
node evals/jev-evidence.mjs --phase call --work /tmp/jev-round-1
# Remove the key from the environment before offline scoring:
node evals/jev-evidence.mjs --phase score --work /tmp/jev-round-1
```

`--manifest <path>` accepts a separately reviewed case manifest. `--out` aliases
`--work`; `--dry-run` composes a new plan without network traffic. Existing plans
and started paid runs are never overwritten. The question hash is frozen at
compose; changing questions requires a new run. `--reps` is applied at compose,
not call. Run directories hold `plan.json`, per-case per-rep JSON, `report.json`
and `report.md`. Raw evidence is local: do not publish private run directories.

Each provider call is saved immediately, including its usage and latency. A
malformed decision still preserves returned billed usage. Transport failures are
recorded as failed calls, not wrong labels; missing probabilities are rejected.
Provider error bodies and credentials are not saved. This client has no automatic
retries; payment/auth/model errors abandon the live run. An interrupted run can
be scored offline as incomplete but is not resumed automatically.

## Interpretation

Report precision/recall for visible missing tests, unsafe missing predictions
among present/unverifiable cases, unverifiable recall, repeated-label stability,
multiclass Brier score and probability bins. Three repetitions are not three
independent examples; families also share structure. Brier/bins describe this
sample, not a validated calibration guarantee. Errors are excluded from quality
rates and explicitly counted. No denominator yields `null`, never perfect scores.

Cost is API-reported usage only, not billing reconciliation; missing costs leave
total cost unknown with a known subtotal. OpenRouter labels requests
`blind-peer-review-eval/jev-required-test-shadow`.

A future integration needs independent labelled examples, negative/incomplete
cases, repeated rounds, a validated threshold and human review. Initially its
only permissible action is focusing a reviewer on evidence for inspection—not
creating a MUST FIX, disabling a lens, or authorizing a merge. This evaluator
records shadow decisions only; it is **not** a live PR shadow-mode integration.
