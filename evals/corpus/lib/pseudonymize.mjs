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

// Identifiers are matched literally, never compiled into a RegExp: config
// values stay data. Longest first so `org/repo-extra` is not half-replaced by
// `org/repo`.
const needles = (values) => [...new Set(values.filter(Boolean).map((v) => v.toLowerCase()))]
  .sort((a, b) => b.length - a.length);
const REF_CHAR = /[\w.-]/;
const DIGIT = /\d/;
const at = (text, i, needle) => text.slice(i, i + needle.length).toLowerCase() === needle;

/** Case-insensitive substring replacement of any of `values`. */
function replaceLiterals(values, token) {
  const list = needles(values);
  return (text) => {
    let out = "";
    for (let i = 0; i < text.length;) {
      const hit = list.find((n) => at(text, i, n));
      if (hit) { out += token; i += hit.length; } else { out += text[i++]; }
    }
    return out;
  };
}

/** `owner/repo#123` → <pr>, `owner/repo` → <org>/<repo>, for any configured owner. */
function replaceOwnerRefs(owners) {
  const list = needles(owners);
  return (text) => {
    let out = "";
    for (let i = 0; i < text.length;) {
      const hit = (i === 0 || !REF_CHAR.test(text[i - 1]))
        && list.find((n) => at(text, i, n) && text[i + n.length] === "/" && REF_CHAR.test(text[i + n.length + 1] ?? ""));
      if (!hit) { out += text[i++]; continue; }
      let j = i + hit.length + 1;
      while (j < text.length && REF_CHAR.test(text[j])) j++;
      let k = j + 1;
      while (text[j] === "#" && k < text.length && DIGIT.test(text[k])) k++;
      if (k > j + 1) { out += TOKENS.pr; i = k; } else { out += `${TOKENS.org}/${TOKENS.repo}`; i = j; }
    }
    return out;
  };
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
  const regex = (pattern, token) => (text) => text.replace(pattern, token);
  const rules = [
    regex(/\b(?:https?|ssh|git):\/\/\S+|\bgit@[\w.-]+:\S+|\bwww\.\S+/gi, TOKENS.url),
    regex(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, TOKENS.email),
    replaceOwnerRefs(owners),
  ];
  // In code, `#333` is a colour and `@Override` a decorator, not a PR or a
  // person; only prose gets the generic reference and handle rules.
  if (!code) {
    rules.push(regex(/(?<![\w&])#\d+\b/g, TOKENS.pr), regex(/(?<![\w.])@[A-Za-z0-9][\w-]*(?:\[bot\])?/g, TOKENS.user));
  }
  if (branches.length) rules.push(replaceLiterals(branches, TOKENS.branch));
  if (repos.length) rules.push(replaceLiterals(repos, TOKENS.repo));
  if (users.length) rules.push(replaceLiterals(users, TOKENS.user));
  rules.push(replaceLiterals(owners, TOKENS.org));
  if (terms.length) rules.push(replaceLiterals(terms, TOKENS.term));

  return function redact(text) {
    if (typeof text !== "string") return text;
    return rules.reduce((out, rule) => rule(out), text);
  };
}

/** Every configured identifier still present anywhere in `text` (case-insensitive substring). */
export function leakedIdentifiers(text, { owners = [], repos = [], users = [], branches = [], terms = [] }) {
  const lower = text.toLowerCase();
  return [...owners, ...repos, ...users, ...branches, ...terms]
    .filter((v) => v && v.length >= 3 && lower.includes(v.toLowerCase()));
}
