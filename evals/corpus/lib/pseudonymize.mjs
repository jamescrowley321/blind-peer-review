// Private-source pseudonymization for the review corpus.
//
// A private case must be usable as eval input without revealing where it came
// from. Two mechanisms: a keyed case id that cannot be reversed without the
// local key, and redaction of every identifier the harvester knows about
// before text reaches a screening input or a provider. Public cases skip both;
// their attribution is already public.

import { createHmac } from "node:crypto";

export const TOKENS = Object.freeze({
  url: "<url>",
  email: "<email>",
  org: "<org>",
  repo: "<repo>",
  pr: "<pr>",
  user: "<user>",
  branch: "<branch>",
  term: "<redacted>",
});

/** Stable, non-reversible id for a private PR. */
export function privateCaseId(key, owner, repo, number) {
  if (typeof key !== "string" || key.length < 32) {
    throw new Error("pseudonymization key must be at least 32 characters");
  }
  const digest = createHmac("sha256", key)
    .update(`${owner}/${repo}#${number}`.toLowerCase())
    .digest("hex");
  return `priv-${digest.slice(0, 16)}`;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Longest first so `org/repo-extra` is not half-replaced by `org/repo`.
function alternation(values) {
  return [...new Set(values.filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|");
}

/**
 * Build a redactor from everything known to identify a private source.
 * `identifiers` = { owners, repos, users, branches, terms } (arrays of strings).
 */
export function makeRedactor({ owners = [], repos = [], users = [], branches = [], terms = [] }, { code = false } = {}) {
  if (!owners.length) throw new Error("redactor needs at least one owner");
  // Substring, not word, matching: private names routinely sit inside code
  // identifiers (AcmeCareClient, ACMECARE_URL, acme_billing_test.py). Over-
  // redacting prose is the accepted cost of never under-redacting.
  const anywhere = (alt) => new RegExp(`(?:${alt})`, "gi");
  const rules = [
    [/\b(?:https?|ssh|git):\/\/\S+|\bgit@[\w.-]+:\S+|\bwww\.\S+/gi, TOKENS.url],
    [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, TOKENS.email],
    [new RegExp(`(?<![\\w.-])(?:${alternation(owners)})/[\\w.-]+#\\d+`, "gi"), TOKENS.pr],
    [new RegExp(`(?<![\\w.-])(?:${alternation(owners)})/[\\w.-]+`, "gi"), `${TOKENS.org}/${TOKENS.repo}`],
  ];
  // In code, `#333` is a colour and `@Override` a decorator, not a PR or a
  // person; only prose gets the generic reference and handle rules.
  if (!code) {
    rules.push([/(?<![\w&])#\d+\b/g, TOKENS.pr], [/(?<![\w.])@[A-Za-z0-9][\w-]*(?:\[bot\])?/g, TOKENS.user]);
  }
  if (branches.length) rules.push([anywhere(alternation(branches)), TOKENS.branch]);
  if (repos.length) rules.push([anywhere(alternation(repos)), TOKENS.repo]);
  if (users.length) rules.push([anywhere(alternation(users)), TOKENS.user]);
  rules.push([anywhere(alternation(owners)), TOKENS.org]);
  if (terms.length) rules.push([anywhere(alternation(terms)), TOKENS.term]);

  return function redact(text) {
    if (typeof text !== "string") return text;
    return rules.reduce((out, [pattern, token]) => out.replace(pattern, token), text);
  };
}

/** Every configured identifier still present anywhere in `text` (case-insensitive substring). */
export function leakedIdentifiers(text, { owners = [], repos = [], users = [], branches = [], terms = [] }) {
  const lower = text.toLowerCase();
  return [...owners, ...repos, ...users, ...branches, ...terms]
    .filter((v) => v && v.length >= 3 && lower.includes(v.toLowerCase()));
}
