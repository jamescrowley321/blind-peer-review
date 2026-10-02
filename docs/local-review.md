# Reviewing locally

Three ways to run the lenses on your own machine, before you push. They differ in
**who reviews** and **who pays**, and that is the only thing worth deciding
between them.

| | runs on | costs | reviewer family |
|---|---|---|---|
| **Claude Code plugin** | your Claude subscription | nothing extra | **same as the author**, if you write with Claude |
| **codex dispatch** | your Codex subscription | nothing extra | **different** from Claude |
| **pi runner** | a model provider, via `OPENROUTER_API_KEY` | per-token | whatever model you pick |

## 1. The plugin — start here

```
/plugin marketplace add jamescrowley321/blind-peer-review
/plugin install blind-peer-review@blind-peer-review
/blind-peer-review:check
```

Reviews committed branch changes, staged/unstaged edits, and nonignored
untracked files against the default branch's merge base. The recorded
`origin/HEAD` is preferred, followed by remote/local main or master. Without an
available default branch, the helper explicitly warns that only working edits
are included. An invalid explicit base fails. The scope represents final files
on disk: a staged deletion followed by an identical recreated untracked file
has no net change. To review only the pending commit, supply a separately
captured staged patch to the dispatcher. Options:

```
/blind-peer-review:check --base release/2.1
/blind-peer-review:check --lens security,red_team
/blind-peer-review:check --add owasp_web,policy
```

Each lens runs as a **separate subagent** with a clean context, reading the same
patch file, and none of them sees another's findings. The verdict is fail-closed:
any MUST FIX blocks, and so does a lens whose output could not be read — a review
nobody could read has not passed.

### Keeping it current

The plugin installs from a marketplace clone, which does not auto-update:

```
/plugin marketplace update blind-peer-review
```

Check what you are actually running with `claude plugin list`. A stale plugin is
easy to miss, because it keeps working — it just works like an older release.

### The blind spot

In Claude Code the lenses are subagents of the host. If you authored the diff
with Claude, Claude is reviewing Claude, and a bug that came from this model
family's habits is the one a same-family reviewer is least likely to see. The
skill says so in its verdict, every run, pass or fail. Section 2 is the fix.

## 2. codex dispatch — a different family, still free

If the `codex` CLI is on your PATH, `/blind-peer-review:check` uses it
automatically. To run it directly:

```
node scripts/scope-diff.mjs [--base <ref>]
node scripts/dispatch-codex.mjs --diff .blind-peer-review/out/review-diff.patch --repo .
node scripts/dispatch-codex.mjs --diff my.patch --repo . --lens security,cold_read
```

One `codex exec` **per lens**, in parallel, each in a read-only sandbox. Exit 1 on
BLOCK, 0 on PASS, 2 if `codex` is not installed — which the skill treats as "run
in-host", never as an error.

The contract is enforced through codex's `--output-schema`, the local equivalent
of the CI path's schema-checked `submit_findings`: the provider validates the
response, so a lens cannot answer in prose.

### Why one process per lens, and not one session running five

Because batching loses findings. Measured on a 27 KB diff of real code, same
model, same diff:

| | Cold Read | Edge Cases | verdict |
|---|---|---|---|
| five lenses in one session | `[]` | `[]` | **PASS** |
| one process per lens | SHOULD FIX | **MUST FIX** | **BLOCK** |

Batching turned a blocking defect into a clean pass, and destroyed the agreement
between two independent lenses that made the finding credible. If you drive the
lenses yourself, in any harness, run one agent session per lens.

## 3. The pi runner — cloud models, per-token cost

```
OPENROUTER_API_KEY=... node scripts/run-local.mjs
```

Needs the [`pi`](https://pi.dev) CLI and a provider key. This is the same engine
the CI gate uses, so it is the way to reproduce a CI verdict locally, or to review
with a specific model rather than whichever one your subscription serves.

> The local pi runner has offline CLI regression coverage using a stub provider.
> Live provider behavior still depends on the installed pi CLI and model.

## Combined findings report

Both scripted local runners write `.blind-peer-review/out/review-summary.md`
and `review-summary.json` beside the original per-lens JSON files. The report
keeps every lens's PASS, BLOCK, or FAILED verdict. Identical findings at the
same location share one entry with each lens attributed; distinct issue text,
recommendations, or severities remain separate. Grouping never changes severity
or the review verdict.

The GitHub gate writes the same display to its job summary, using exactly the
latest expected bot reviews at the current PR head that it adjudicates. It also
shows missing lenses and the actual GitHub review states, including dismissed
reviews. Unreadable review bodies are labeled rather than guessed. Summary
write failures warn without changing the gate decision.

Report text is escaped for Markdown and bounded to 256 KiB. Long fields and
omitted display entries are marked explicitly; the original per-lens files or
GitHub reviews retain the complete findings.

## Tuning a lens for your repo

Commit `.blind-peer-review/lenses/<key>.md` and it replaces that persona for all
three local paths. Keys are in
[`lenses/manifest.json`](../lenses/manifest.json).

CI deliberately does **not** read those overrides on an untrusted PR: a pull
request must not be able to rewrite its own reviewer. Local harnesses do, because
you wrote the file.
