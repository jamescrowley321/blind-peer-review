# GitHub adapter — Claude GitHub App

Adversarial review on pull requests, **one lens per job**, billed to your
Anthropic key rather than a third-party provider.

## Install

Once per repo, from Claude Code:

```
/install-github-app
```

That installs the Claude GitHub App and sets `ANTHROPIC_API_KEY`. Then copy
[`lens-review.yml`](lens-review.yml) to `.github/workflows/` in the consumer repo.

Nothing to vendor: the workflow checks out this repo's `lenses/` at a **pinned
tag**, so an upstream release cannot change your reviewers mid-PR.

## Why one job per lens

Each matrix job is a separate `claude-code-action` invocation, so every lens
starts from an empty context and cannot see any other lens's output. That is the
whole product, and it is measured rather than assumed. On a 27 KB diff of real
code, same model, same diff:

| | Cold Read | Edge Cases | verdict |
|---|---|---|---|
| all five lenses batched into one session | `[]` | `[]` | **PASS** |
| one session per lens | SHOULD FIX | **MUST FIX** | **BLOCK** |

Batching turned a blocking defect into a clean pass, and destroyed the agreement
between two independent lenses that made the finding credible.

## Differences from the pi CI gate

| | pi gate (`action.yml`) | this adapter |
|---|---|---|
| Model | any OpenRouter slug | whatever your Anthropic key serves |
| Reviewer family | different from the author's by construction | **the same** if you author with Claude |
| Delivery | schema-checked `submit_findings` tool call | a prompt asking for a shape |
| Verdict | parsed from `severity`, machine-adjudicated | read the lens comments |
| Blocks a merge | `Merge Gate` as a required check | `Lens Gate`, only if you make it required |

The second row is the honest cost. The pi gate reviews with a **different model
family** from the one that wrote the diff; here, if you author with Claude, Claude
reviews Claude and shares the author's blind spots. One job per lens buys
independence, not a different family. If cross-family review is what you need,
use the pi gate or dispatch locally to codex (`scripts/dispatch-codex.mjs`).

The fourth row matters too: this adapter asks for a severity-prefixed comment
rather than validating a JSON object against a schema, so the "unparseable output
is a failed lens" rule the pi path enforces mechanically is here only a request.

## Injection posture

The persona always comes from the **pinned upstream checkout** or from the **base
branch's** `.blind-peer-review/lenses/<key>.md` — never from the PR's own copy. A
pull request must not be able to rewrite its own reviewer (OWASP LLM01). The
prompt states that the diff, title and body are untrusted data and that an
embedded instruction is itself a MUST FIX finding.

The job holds `pull-requests: write` and no `contents: write`, and the tool
allowlist grants no write tool.

## Making it block

`Lens Gate` fails closed when any lens job did not complete — an unreviewed diff
must not read as an approved one. It is **not** a required check until you add it
to branch protection. Read the lens comments for the actual verdict; unlike the pi
gate, no step parses severities and decides for you.
