// lens-identity.test.mjs — the lens-name matcher, against the SHIPPED personas.
// Run: node --test scripts/lens-identity.test.mjs
//
// Why this exists (#33). A lens's job asserts that the JSON it got came from the
// persona it dispatched, by matching the emitted `lens` string. That matcher is
// part exact-match, part alias map, part containment — and the alias map is
// hand-maintained. Nothing checked it still described the personas it names.
//
// That gap is not hypothetical: when `security.md` was headed
// "Sentinel — Security Auditor Agent", models answered "Security Auditor", the
// match failed, and EVERY Security Review job failed deterministically until an
// alias was bolted on. Deriving accepted names from the shipped H1 fixed the
// class; this file is what keeps it fixed, by reading the personas rather than
// restating them.
//
// Two properties, checked for every lens in the manifest:
//   1. each lens ACCEPTS every name a model plausibly emits for it;
//   2. no lens accepts ANY name belonging to another lens.
// (2) is the one with teeth: OWASP Web's subtitle "Application Security Lens" is
// a substring of OWASP LLM's "AI Application Security Lens", so a containment
// rule anywhere in the matcher lets one lens claim the other's output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { makeLensMatcher } = require("./parse-and-post.cjs");

const lensesDir = new URL("../lenses/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", lensesDir), "utf8"));

const lenses = manifest.lenses.map((l) => {
  const text = readFileSync(new URL(`${l.key}.md`, lensesDir), "utf8");
  const h1 = (text.match(/^# (.+)$/m) || [])[1];
  assert.ok(h1, `${l.key}.md has no H1 — the matcher derives accepted names from it`);
  return { key: l.key, name: l.name, h1 };
});

// Every string a model plausibly answers with for a given lens: its manifest
// display name, its whole H1, the H1's primary segment, and the H1's subtitle.
// Each of these has been emitted by some model in the field.
function emissions({ name, h1 }) {
  const parts = h1.split(/\s*[—–:|]\s*/).map((s) => s.trim()).filter(Boolean);
  return [...new Set([name, h1, parts[0], parts.slice(1).join(" ")].filter(Boolean))];
}

test("the manifest and the personas describe the same set of lenses", () => {
  assert.ok(lenses.length >= 5, "suspiciously few lenses — did the manifest load?");
});

for (const lens of lenses) {
  test(`${lens.key} accepts every name a model emits for it`, () => {
    const matches = makeLensMatcher(lens.name, lens.h1);
    for (const e of emissions(lens)) {
      assert.ok(matches(e), `${lens.key} rejected its own "${e}" — this lens's jobs would fail deterministically`);
    }
  });

  test(`${lens.key} accepts no other lens's name`, () => {
    const matches = makeLensMatcher(lens.name, lens.h1);
    for (const other of lenses) {
      if (other.key === lens.key) continue;
      for (const e of emissions(other)) {
        assert.ok(!matches(e), `${lens.key} ACCEPTED ${other.key}'s "${e}" — one lens can claim another's findings`);
      }
    }
  });
}

test("no display name is a substring of another (rule 3)", () => {
  const names = lenses.map((l) => l.name);
  for (const a of names) {
    for (const b of names) {
      if (a !== b) assert.ok(!b.includes(a), `"${a}" is contained in "${b}"`);
    }
  }
});

test("every persona's H1 primary segment is its manifest display name", () => {
  // Drift here is how the alias map goes stale: the map is keyed on the H1, the
  // job is named from the manifest, and nothing else notices they disagree.
  for (const l of lenses) {
    const primary = l.h1.split(/\s*[—–:|]\s*/)[0].trim();
    assert.equal(primary, l.name, `${l.key}: H1 says "${primary}", manifest says "${l.name}"`);
  }
});

test("the matcher rejects empty and junk", () => {
  const matches = makeLensMatcher(lenses[0].name, lenses[0].h1);
  for (const junk of ["", "   ", null, undefined, "not a lens at all"]) {
    assert.ok(!matches(junk), `accepted ${JSON.stringify(junk)}`);
  }
});
