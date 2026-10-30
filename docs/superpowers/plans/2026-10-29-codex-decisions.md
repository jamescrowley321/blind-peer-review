# Codex Decisions Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline.

**Goal:** Prepare a bounded optional Codex decision hook.
**Architecture:** One Node command, one trusted local config, no dependencies.
**Tech Stack:** Node 20+, built-in fetch and node:test.
**Spec:** ../specs/2026-10-29-codex-decisions-design.md

## Global constraints

Observation by default; no blocking, retries, raw prompt logging or implicit
provider fallback. No changes to existing review gates or AMS runtime.

## Review focus

Scope escapes through symlinks; provider redirects; malformed probabilities;
missing credentials; partial conversation mistaken for unresolved requirements.

## Task

- [x] Add `scripts/codex-decisions.test.mjs` covering scope, both provider shapes,
  shadow/advisory behavior, bounded input, failures and privacy of telemetry.
- [x] Run it and observe failure before adding implementation.
- [x] Implement `scripts/codex-decisions.mjs`; document config, hook trust,
  credential setup and experimental limitations in `docs/codex-decisions.md`.
- [x] Run targeted tests and existing related screening tests; fresh review.
- [ ] Install the reviewed local hook/config, verify the no-key path, commit and
  open a PR; monitor checks. Live model quality remains unverified without keys.
