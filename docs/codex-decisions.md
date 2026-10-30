# Optional Codex decision advisor

This experimental `UserPromptSubmit` hook measures two narrow judgments:
consequential ambiguity and exploratory intent. It does not replace blind peer
review, check completion evidence, select a chat model, approve tools or block a
turn. Start with concise `AGENTS.md` preferences; compare the hook against that
baseline before enabling advice. No improvement in agent behavior is established.

## Configure

Requires Node 20+; no install or package dependencies. Copy
`scripts/codex-decisions.mjs` to a stable user-owned location outside repositories.
Create a local configuration file, for example `~/.codex/decisions.json`:

```json
{
  "provider": "openrouter",
  "model": "typesafe/jev-1.14",
  "keyEnv": "ORG_OPENROUTER_API_KEY",
  "mode": "shadow",
  "allowedRoots": ["/absolute/path/to/workspace"],
  "excludedRoots": ["/absolute/path/to/workspace/personal-material"],
  "logPath": "/absolute/path/to/private/advisor.jsonl"
}
```

All configured roots must exist. Symlinks are resolved before directory checks;
an unavailable scope is skipped. Use `excludedRoots: []` when no exclusions are
needed. Use a private, user-owned directory for the config, script and log.
`logPath` is optional; its parent must exist. Log files are mode `0600`.

Supply the organization's credential through the explicitly named environment
variable in the Codex process. This command never reads `.env`, Pi auth storage,
Codex auth storage or another credential file, and never selects a fallback key.
The operator must verify the key's account, spend cap and data policy; an
environment variable's name cannot establish those properties.

Supported selections:

| Provider | Model | Billing |
| --- | --- | --- |
| `openrouter` | `typesafe/jev-1.14` (or pinned `typesafe/jev-1.13`) | Selected OpenRouter account |
| `openrouter` | `openai/gpt-6-luna-decisions` | Selected OpenRouter account |
| `openai` | `gpt-6-luna` | Selected OpenAI API organization |

For direct OpenAI, change `provider`, `model` and `keyEnv` together. Verify the
organization's required retention policy before enabling it. Requests through
OpenRouter explicitly require `provider.zdr: true` and disable provider fallback.
If no eligible route exists, the hook records an error and continues without
advice. It never retries with weaker routing requirements.

Merge this handler into `~/.codex/hooks.json`, preserving any existing handlers.
Replace paths with your actual absolute paths:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/codex-decisions.mjs --config /absolute/path/decisions.json",
        "timeout": 3,
        "additionalContextLimit": 400
      }]
    }]
  }
}
```

Open `/hooks` in Codex and review/trust the new handler. Restart sessions to load
new global instructions. The model request deadline is two seconds, with no
retries, and the handler timeout bounds the entire invocation. Shadow mode still
waits for classification and consumes API usage; it adds no model-visible advice.
Remove/disable the handler for a true no-classifier baseline.

## Data and behavior

Only the current user prompt goes to the selected API. No transcript, repository
files, directory paths or session identifiers are sent. Empty prompts, prompts
over 16,000 UTF-8 bytes and recognizable credential patterns are skipped. This
tripwire is not a redactor, PHI detector or guarantee that arbitrary text is safe.
Use only inputs allowed by the organization's policy; disable the hook for
sessions that may contain prohibited data. Observation mode has the same remote
data transfer as advisory mode.

Logs contain prompt/turn hashes, question-set hash, probabilities, numeric usage,
elapsed time and fixed outcomes. They contain no raw prompts, provider text or
error bodies. Missing usage stays `null`; OpenAI dollar cost is not inferred.
Hashes remain potentially linkable metadata. No retention/rotation service is
installed: rotate or delete the local JSONL file using existing local practice.

`missing_key` means no network request was made. `http_error`, `transport_error`
and `invalid_response` are abstentions, never successful decisions.

After evaluation, explicitly set `mode: "advisory"` to permit a fixed short
reminder. `threshold` defaults to `0.9`; this is an experimental trigger, not a
calibrated accuracy claim. Select thresholds separately for each model. Advice
always defers to prior conversation and asks only about unresolved consequential
choices. The main agent still has to determine what question, if any, is useful.

The prompt-only design cannot see answers provided earlier. In particular,
"do that" may be fully specified by the conversation. Never use these judgments
as authorization, a requirement to ask, or evidence that work is wrong.

## Evaluate

Run offline transport/behavior checks:

```sh
node --test scripts/codex-decisions.test.mjs
```

For quality, label frozen examples independently: explicit implementation,
exploration, material ambiguity, harmless omitted details, already-answered
questions, follow-ups and explicit permission to use judgment. Keep development
and held-out examples separate. Compare instructions alone, Jev and OpenAI on
the same cases and subsequent agent behavior. Measure unnecessary questions,
missed consequential questions, unwanted scope expansion, completion quality,
turn latency and total cost. Classification accuracy alone is not evidence of
improvement. No paid evaluation is included in the offline tests.

## Sources

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [OpenRouter Jev and decision models](https://openrouter.ai/docs/guides/community/jev)
- [OpenRouter Decisions wire contract](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)
- [Subscription API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)

Eligible Pro/Business credits must be claimed for a linked OpenAI organization.
They cover direct Decisions API usage, not calls billed by OpenRouter. Account
eligibility and available balances must be checked in billing.
