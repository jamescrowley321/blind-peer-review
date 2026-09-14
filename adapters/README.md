# Harness adapters

The lenses in [`../lenses/`](../lenses) are plain, harness-neutral markdown — one
source of truth. Each harness reads the *same* personas; you tune a lens once and
every harness picks it up. This directory holds the thin adapters for harnesses
that live in the *consuming* repo (Codex, Cursor); the pi and Claude Code adapters
ship in this repo directly.

| Harness | Adapter | Where it lives | Runs |
|---------|---------|----------------|------|
| **pi** (CI gate) | [`../action.yml`](../action.yml) + [`../examples/caller-workflow.yml`](../examples/caller-workflow.yml) | this repo → consumer `.github/workflows/` | On every PR; fail-closed merge gate |
| **pi** (local) | [`../scripts/run-local.mjs`](../scripts/run-local.mjs) | this repo | `node scripts/run-local.mjs` before pushing |
| **Claude Code** | [`../skills/check/`](../skills/check) + [`../agents/`](../agents) | installed plugin | `/blind-peer-review:check`, or invoke a lens agent |
| **Codex** _(verified end-to-end)_ | [`codex/AGENTS.md`](codex/AGENTS.md) + [`../scripts/vendor.mjs`](../scripts/vendor.mjs) | consumer repo `AGENTS.md` + `.blind-peer-review/vendor/` | `npx github:jamescrowley321/blind-peer-review#v3 --into . --print-agents-block` in the target repo, then Codex reads it before working |
| **GitHub (Claude App)** _(needs the app installed)_ | [`github-claude/lens-review.yml`](github-claude/lens-review.yml) | consumer repo `.github/workflows/` | On every PR; one job per lens, billed to your Anthropic key. Same-family if you author with Claude — see [`github-claude/README.md`](github-claude/README.md) |
| **Cursor** _(trigger unverified)_ | [`cursor/blind-peer-review.mdc`](cursor/blind-peer-review.mdc) | consumer repo `.cursor/rules/` | Ask Cursor to run the review. The paths it cites are CI-checked against what the vendor step writes, but whether Cursor loads and fires the `.mdc` is still unexercised — we run Codex, pi and Claude Code. |

## One lens per session — measured, not assumed

Every local adapter says a lens sees no other lens's findings. In CI that is
structural: each lens is a separate agent. In a coding agent it is only true if
you **invoke the agent once per lens**. One session running five lenses carries
each one's output into the next.

Verified against a 27 KB diff of real third-party code, same model, same diff,
same lens:

| how it ran | Cold Read | Edge Cases | verdict |
|---|---|---|---|
| all five lenses in one `codex exec` | `[]` | `[]` | **PASS** |
| one `codex exec` per lens | SHOULD FIX | **MUST FIX** | **BLOCK** |

Batching did not merely weaken the guarantee. It turned a blocking defect into a
clean pass, and it destroyed the cross-validation signal the tool exists to
produce: run separately, two *different* lenses independently converged on the
same bug — a constructor that parses and validates an environment variable before
the CLI flag meant to override it is applied, so a bad env value makes the
override unusable. Confirmed in the source.

`scripts/dispatch-codex.mjs` enforces this rather than asking for it: one process
per lens, read-only sandbox, and the contract shape enforced through codex's
`--output-schema` — the local equivalent of CI's schema-checked `submit_findings`.

## The one override convention (all harnesses honor it)

A consuming repo tunes a lens by committing `.blind-peer-review/lenses/<key>.md`;
that file *replaces* the base persona of the same key for the local harnesses.

**Injection-safe split:** local harnesses (Claude Code, Codex, Cursor, the local
runner) read the override — the developer authored those files, so they're
trusted. **CI on an untrusted PR (the pi Action) never reads them** — a PR must
not be able to rewrite its own reviewer (OWASP LLM01). CI runs the pinned base
set only; see [`../lenses/README.md`](../lenses/README.md).

## Getting the lenses into a consumer repo

The local harnesses need the persona files on disk. Claude Code needs nothing —
installing the plugin makes `${CLAUDE_PLUGIN_ROOT}/lenses/` resolve. For Codex and
Cursor, run this from the consumer repo's root:

```
npx -y github:jamescrowley321/blind-peer-review#v3 --into .
```

Both templates cite the paths that command writes (`.blind-peer-review/vendor/…`)
verbatim, so there is nothing to adjust — and `lint.yml` fails the build if a
template ever names a file the vendor step does not produce. Don't hand-edit the
vendored copies; to change a lens for your repo, commit
`.blind-peer-review/lenses/<key>.md`, which overrides the base persona of the same
key and survives a re-vendor.
