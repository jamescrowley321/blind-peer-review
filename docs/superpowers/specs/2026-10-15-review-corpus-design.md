# Historical review corpus and Jev screening — design

## Goal

Turn hundreds of historical PR reviews into an auditable eval corpus with two uses:

1. **General BPR eval corpus.** Real PRs with recovered review-time evidence, used to measure lens quality and choose models.
2. **Jev required-test slice.** A subset with independent human labels (`visible_missing` / `visible_present` / `unverifiable`), used to evaluate the standalone Jev evaluator (#146) on real data instead of synthetic cases.

Jev's role here is **screening**: it answers bounded questions about whether a case is usable. It never writes the labels it is later scored on, and it never affects a review verdict.

## Sources

- **Public corpus.** PRs in the maintainer's public repositories. Attribution (repo, PR, SHA, URL) is public already and is kept.
- **Private corpus.** PRs in private repositories. Nothing that identifies a private source appears in committed code, docs, fixtures, issues, PR text or published results. Private results stay local; there is no public aggregate.

Sources, output directories and the pseudonymization key come from a local config file outside the repository (`--config`). The committed code ships no source list.

## Pipeline

```
harvest → normalize → deterministic filters → Jev screening → human calibration → accepted corpus → slices
```

Each stage reads the previous stage's frozen JSON output and writes its own. Stages are re-runnable and refuse to overwrite existing output, as the #146 evaluator does.

### 1. Harvest (read-only GitHub API)

For every PR with at least one review output:

- **PR body as of review time.** Recovered from GraphQL `userContentEdits`. If no history covers the review time, the current body is used and the case is flagged `body_approximate`.
- **Reviewed head SHA** (from the review's commit id, marker or text) and base SHA, plus the diff between them. If the reviewed SHA is no longer fetchable, the case is flagged `diff_approximate`. It is never silently replaced with the current head.
- **Review outputs** (issue comments, PR reviews, inline comments), each classified by producing pipeline using deterministic detectors (author + marker/heading/JSON shape). Unknown formats are recorded as `unclassified`, never dropped silently.
- **Outcome.** Merged or closed, merge SHA, and later commits touching flagged files. This is evidence, not ground truth.

### 2. Pseudonymization (private corpus only, applied inside the harvester)

- Case id = `priv-` + truncated HMAC-SHA256(key, `owner/repo#number`). The id → source map is written only to the private output directory.
- Before anything is written to the screening input, or sent to a provider, these are replaced with neutral tokens: owner/repo names, PR/issue references, GitHub URLs, branch names, user handles and emails (`<org>`, `<repo>`, `<pr>`, `<url>`, `<branch>`, `<user>`, `<email>`).
- The provider request title is generic.

### 3. Deterministic filters (code, no model)

A case is rejected or flagged, with a recorded reason, when: no parseable review output exists; the review ran on a superseded head and a later review exists (the latest review per head is kept); the diff is truncated or paths were withheld; the diff is lockfile/generated-only; the PR body has no acceptance-criteria section; the only blocking finding is the unchecked human-accountability box (a policy BLOCK says nothing about the code); or the producing pipeline's lens set is unknown. Every reason is a stable enum, not a string.

### 4. Jev screening

Frozen questions, hashed at compose like #146, sent as Jev `bool` questions (one probability each). State must fit Jev's 32k state budget, so screening sends the PR body, the review text and a diffstat (paths with added/removed counts), never the full diff. A probability outside [0, 1] or a malformed answer fails that call; it is never coerced.

- `has_explicit_acs`: Does the PR body state explicit acceptance criteria?
- `acs_testable`: Is each criterion a concrete, testable behavior?
- `review_cites_code`: Does the review cite specific code locations or behavior, not generic advice?
- `diff_mostly_substantive`: Is the diff mostly the change under review, not renames, formatting or vendored noise?

**No screening question may mention tests being present or missing.** That is the evaluation label, and screening on it would bias the corpus toward cases Jev finds easy.

Per-question thresholds split cases into accept / reject / human-review. Thresholds are set only after calibration (stage 5). Until then every case is human-review.

### 5. Human calibration

- 30–50 cases are sampled at random, stratified by repo and pipeline, and hand-labelled on the same screening questions with Jev's answers hidden.
- Jev agreement, precision and recall are measured per question, and thresholds are set from that.
- A random sample of Jev **rejects** is always re-checked by hand, because rejects are where the bias hides.

### 6. Slices

- **General corpus.** Accepted public cases are converted to the existing fixture format under `evals/fixtures/` with provenance fields. Accepted private cases are converted to the same format in the private directory only.
- **Required-test slice.** For accepted cases with an explicit test AC, a human labels the evidence class blind, with no Jev output visible. Splits are made by PR family. Development cases are excluded from held-out claims. `body_approximate` / `diff_approximate` cases are never held-out. Jev, `openai/gpt-6-luna-decisions` (a second decision model), Gemini Flash and the path-only baseline are then compared on identical frozen inputs with the #146 scorer. Any comparison involving BPR lenses pins the action ref and uses enough repetitions to see past known flaky fixtures (`acceptance_unimplemented_ac` has flipped in both arms of past A/B runs).

## Error handling

Provider failures are recorded per call, and missing usage is recorded as unknown, never zero (as in #146). GitHub API errors stop the harvest for that repo, and that repo's partial output is marked incomplete. Approximation flags carry through every stage into reports.

## Testing

Pure functions (format detectors, SHA resolution, redaction, HMAC ids, filters, threshold application) get unit tests on recorded public fixtures. The harvester is tested against a stubbed `gh` transport. A test asserts that redaction leaves none of the configured private identifiers in any screening input. A test asserts that the committed tree contains no private source names, using a pattern list read from local config when present.

## Relationship to existing work

- Past A/B runs of Jev advising lens prompts (no effect either way) and of a per-turn Jev advisor (accurate but changed no behavior) are why Jev is not placed in the review path here.

- #146 keeps its evaluator, transport and scorer. Its synthetic corpus becomes development-only, and its label issues are resolved under the required-test slice.
- #143 is superseded by this design's stages 5–6.
