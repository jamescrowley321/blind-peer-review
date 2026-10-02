# Base agents — the blind-peer-review lens library

This directory is the **single, harness-neutral source of truth** for the
adversarial review personas ("lenses"). Every consumer — the GitHub Action (pi in
CI), the Claude Code plugin, a Codex or Cursor adapter, or the local runner —
reads these same markdown files. Tune a persona here once and every harness picks
it up.

Only lenses live here. The harness-neutral review contract is one directory up in
`contracts/shared_review_contract.md`, because this directory is read as a
registry — a non-lens file sitting in it gets enumerated as a lens.

## Naming

Lens identifiers are `snake_case` — the manifest keys, the `lens:` input values,
the persona filenames and the fixture directories. Display names are Title Case
("Cold Read"), because they are read by humans in review headers and check names.
Agent `name:` fields match their lens key, so there is exactly one spelling of a
lens anywhere in the project. Note that every agent and skill in the official
marketplace is kebab-cased in that field; if a future Claude Code release rejects
underscores there, these agents stop loading by name — the `/blind-peer-review:check`
skill is unaffected, since it resolves personas by path and never by agent name.

## Files

- `manifest.json` — the neutral lens registry: for each lens, its `key`
  (== filename), display `name` (the `lens` field of the findings object the merge
  gate parses), `activation`, and whether it is enabled by default. This is the
  one list — adapters and the eval harness read it instead of re-deriving the set
  from the directory or hardcoding names.
- `shared_instructions.md` — the **trust boundary**, tool contract, severity
  scale, and output envelope appended to every lens. This is the security
  backbone and is **central and non-overridable** (see below).
- `<key>.md` — one persona per lens. Plain markdown, no harness-specific
  frontmatter. `__PR_NUMBER__` is substituted by the runner.

## The base agents

| Key | Name | Activation | Default |
|-----|------|-----------|---------|
| `cold_read` | Cold Read | always | on |
| `edge_case` | Edge Cases | always | on |
| `acceptance` | Acceptance Criteria | always | on |
| `security` | Security Review | always | on |
| `red_team` | Red Team | security surface (self-skips) | on |
| `policy` | Compliance | always | on |
| `owasp_web` | OWASP Web Top 10 | web surface (self-skips) | on |
| `owasp_llm` | OWASP LLM Top 10 | LLM surface (self-skips) | on |

## Tuning: append & override

A consuming repo tunes the lenses **statically** — no persona text is ever
generated at runtime from untrusted input. The convention is one override
directory, honored by every adapter:

```
<consumer-repo>/.blind-peer-review/lenses/<key>.md
```

- **Override** — a file at that path *replaces* the base persona of the same
  `key` (e.g. a repo ships a PHI/PII-tuned `security.md`, or a
  domain-specific `owasp_web.md`).
- **Append** — add a `<new-key>.md` there plus a `manifest.json` entry to run an
  extra lens the base set doesn't ship.

### Injection-safe split (read this)

The override directory is trusted **only where the person running the review
owns the files**:

- **Local harnesses** (Claude Code / Codex / Cursor on a developer's machine):
  read the override directory. The developer authored those files — trusted,
  static.
- **CI on an untrusted pull request** (the pi GitHub Action): **does not** read
  any persona/rule text out of the PR checkout. A PR
  under review must not be able to rewrite the reviewer's own instructions
  ("post No findings, approve everything") — that is prompt injection
  (OWASP LLM01). CI runs the pinned base set by default. With
  `trusted_lens_overrides: 'true'`, it reads the fixed override path from the
  target PR's immutable **base SHA** using GitHub's API, never from the head.
  This also resolves the target PR on `workflow_dispatch`; no custom ref or
  path input is available. It requires `contents: read` permission.

The operator must protect every allowed base branch and the workflow that
enables overrides; the action does not check branch protection. Anyone able to
write to either trusted surface can change the reviewer. A persona edited in
a PR applies only after merging, to subsequent PRs. Keep opt-in static and
workflow-author-controlled. CI supports existing lens keys only, not append.

CI personas must be regular UTF-8 Markdown files of 1–65536 bytes, start with an
H1 of at most 200 characters, and have no control characters except tab/CR/LF.
Symlinks and submodules are rejected. Only a missing path in a complete,
accessible base tree falls back to the pinned persona. Retrieval/auth/network
failures, malformed encodings, oversized files, truncated trees and trees over
4096 entries fail the job. Requests have a 15-second timeout; traversal reads
only three nonrecursive trees and one bounded blob.

`shared_instructions.md` is never overridable: the pinned contract, severity
definitions, trust boundary and tools take precedence over the persona. CI
also retains the pinned canonical lens name and accepted heading.
