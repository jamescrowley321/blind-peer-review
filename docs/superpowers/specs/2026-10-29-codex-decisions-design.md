# Codex decision advisor

An optional `UserPromptSubmit` hook evaluates consequential ambiguity and
exploratory intent. Persistent working preferences remain the primary behavior
control: ask only when an unresolved answer changes scope, behavior or
architecture; prefer the smallest complete change. The hook is an experiment,
not an authorization or review gate.

Use one dependency-free command and a local configuration file. Support Jev and
OpenAI Decisions through OpenRouter, plus direct OpenAI for eligible API credits.
Run one selected model per turn, with a two-second deadline and no retries or
automatic provider fallback. Default to observation only. Optional advisory mode
adds fixed, bounded guidance, never provider-generated instructions.

Only explicitly allowed directories qualify. Read the submitted prompt, not
repository files, credentials on disk or conversation transcripts. Reject
oversized input and recognizable credentials. Log hashes, numeric usage,
probabilities and outcomes; never log prompt text or provider error bodies.
An organization-managed key must be supplied through the configured environment
variable. Local privacy policy still applies: secret-pattern screening cannot
establish that a prompt is free of personal or health information.

Alternatives: a mandatory per-turn classifier adds latency and unproven guidance;
a full orchestration service adds maintenance without evidence of benefit. The
chosen small, optional hook permits comparison against instructions alone.

Limitations: a prompt-only classifier cannot know what prior conversation
already resolved. Its probabilities are not calibrated. No completion verifier,
automatic model routing, tool approval, or AMS implementation is included.

Acceptance: scope checks precede requests; both wire formats are validated;
errors never block Codex; no raw sensitive text in logs/output; shadow mode adds
no advice; explicit advisory mode never requires repeating an answered question.
