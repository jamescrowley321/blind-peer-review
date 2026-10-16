import test from "node:test";
import assert from "node:assert/strict";
import { privateCaseId, makeRedactor, leakedIdentifiers, TOKENS } from "./pseudonymize.mjs";

const KEY = "k".repeat(32);
const IDS = {
  owners: ["acme-health"],
  repos: ["acme-billing", "acme-billing-ui"],
  users: ["jdoe", "ci-bot"],
  branches: ["feat/claims-export"],
  terms: ["AcmeCare"],
};

test("case ids are stable, case-insensitive, distinct per PR and need a real key", () => {
  const id = privateCaseId(KEY, "acme-health", "acme-billing", 7);
  assert.match(id, /^priv-[0-9a-f]{16}$/);
  assert.equal(privateCaseId(KEY, "ACME-Health", "Acme-Billing", 7), id);
  assert.notEqual(privateCaseId(KEY, "acme-health", "acme-billing", 8), id);
  assert.notEqual(privateCaseId("x".repeat(32), "acme-health", "acme-billing", 7), id);
  assert.equal(id.includes("acme"), false);
  assert.throws(() => privateCaseId("short", "o", "r", 1), /at least 32/);
});

test("redacts urls, emails, qualified refs, bare refs, handles, branches, repos, owners and terms", () => {
  const redact = makeRedactor(IDS);
  const input = [
    "See https://github.com/acme-health/acme-billing/pull/12 and git@github.com:acme-health/acme-billing-ui.git",
    "Fixes acme-health/acme-billing#44, follows #45. Mail jdoe@acme.example.",
    "@jdoe and @ci-bot[bot] reviewed acme-billing-ui on feat/claims-export for AcmeCare (acme-health).",
    "Plain prose: billing, ui, claims, export, care remain.",
  ].join("\n");
  const out = redact(input);
  assert.deepEqual(leakedIdentifiers(out, IDS), []);
  assert.equal(out, [
    `See ${TOKENS.url} and ${TOKENS.url}`,
    `Fixes ${TOKENS.pr}, follows ${TOKENS.pr}. Mail ${TOKENS.email}.`,
    `${TOKENS.user} and ${TOKENS.user} reviewed ${TOKENS.repo} on ${TOKENS.branch} for ${TOKENS.term} (${TOKENS.org}).`,
    "Plain prose: billing, ui, claims, export, care remain.",
  ].join("\n"));
});

test("a longer repo name is never half-replaced by a shorter one", () => {
  const out = makeRedactor(IDS)("acme-billing-ui and acme-billing");
  assert.equal(out, `${TOKENS.repo} and ${TOKENS.repo}`);
});

test("leak detection reports any configured identifier that survives", () => {
  assert.deepEqual(leakedIdentifiers("contact jdoe about AcmeCare", IDS), ["jdoe", "AcmeCare"]);
});

test("a redactor without an owner is refused", () => {
  assert.throws(() => makeRedactor({ repos: ["x"] }), /at least one owner/);
});
