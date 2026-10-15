# Jev Required-Test Evidence Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether Jev can classify visible required-test evidence before any BPR workflow relies on it.

**Architecture:** Add a standalone evaluator over explicitly labelled acceptance fixtures. It sends only the PR acceptance criteria and visible relevant test evidence to OpenRouter's System One endpoint, records typed decisions plus usage, and reports accuracy/confusion/calibration. It never changes the BPR review prompt, lens activation, or merge verdict.

**Tech Stack:** Node 20 native fetch, OpenRouter System One API, existing fixture loader.

**Spec:** User request in this session; the three labels are `visible_missing`, `visible_present`, and `unverifiable`.

## Global Constraints

- Reuse existing fixture ground truth; do not derive labels from model output.
- Do not send expected labels, guards, or scorecard metadata to Jev.
- Preserve zero-dependency eval operation and keep credentials only in the live call phase.
- Treat missing API usage as unknown, never zero.
- Advisory/eval-only: no production gate behavior changes.

## Review Focus

- A fixture whose relevant test file is not visible must be `unverifiable`, not missing.
- Visible implementation code is not a substitute for a required test assertion.
- Injection-shaped text in PR/diff remains untrusted state, never model instructions.
- Model output outside the three labels must fail the eval record, not coerce a label.
- Cost/usage absence must not become a zero-cost claim.

### Task 1: Labelled fixture contract and pure scoring
- [ ] Write failing tests for fixture-label validation and confusion-matrix scoring.
- [ ] Add a `jev_required_test` label contract to selected fixtures.
- [ ] Implement pure parsing, validation, scoring and report rendering.
- [ ] Run focused tests and fixture validation.

### Task 2: System One caller and CLI phases
- [ ] Write failing transport tests for request shape, output validation, usage persistence, and no expected-label leakage.
- [ ] Implement compose/call/score phases using OpenRouter `/api/v1/systemone`.
- [ ] Run offline tests, dry run, and one labelled live smoke call.

### Task 3: Documentation and full validation
- [ ] Document the evaluator, its non-gating status, and interpretation rules.
- [ ] Run the full offline suite and fixture validator.
- [ ] Run the labelled live set only with explicit approval/credit usage and record results outside committed fixtures.
