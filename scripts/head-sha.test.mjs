// Unit tests for scripts/head-sha.cjs.
// Run: node --test scripts/head-sha.test.mjs
//
// The incident: every step that anchors to the commit under review read
// `context.payload.pull_request.head.sha` directly, so the workflow_dispatch
// path this action advertises threw `TypeError: Cannot read properties of
// undefined (reading 'head')` and no on-demand review could ever run.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { headSha } = createRequire(import.meta.url)("./head-sha.cjs");

const SHA = "0".repeat(39) + "1";
const OTHER = "0".repeat(39) + "2";
const repo = { owner: "acme", repo: "widget" };

const githubStub = (sha = SHA) => {
  const calls = [];
  return {
    calls,
    rest: {
      pulls: {
        get: async (p) => {
          calls.push(p);
          return { data: { head: { sha } } };
        },
      },
    },
  };
};

describe("headSha", () => {
  test("reads the event payload when there is one, without an API call", async () => {
    const github = githubStub(OTHER);
    const context = { repo, payload: { pull_request: { head: { sha: SHA } } } };

    assert.equal(await headSha({ github, context, env: {} }), SHA);
    assert.equal(github.calls.length, 0, "the event value must not cost an API call");
  });

  test("resolves from the PR when there is no pull_request payload", async () => {
    const github = githubStub();
    const context = { repo, payload: {} }; // workflow_dispatch

    assert.equal(await headSha({ github, context, env: { PR_NUMBER: "42" } }), SHA);
    assert.deepEqual(github.calls, [{ owner: "acme", repo: "widget", pull_number: 42 }]);
  });

  test("the event value wins over the API when both could answer", async () => {
    const github = githubStub(OTHER);
    const context = { repo, payload: { pull_request: { head: { sha: SHA } } } };
    assert.equal(await headSha({ github, context, env: { PR_NUMBER: "42" } }), SHA);
  });

  for (const [label, env] of [
    ["unset", {}],
    ["empty", { PR_NUMBER: "" }],
    ["whitespace", { PR_NUMBER: "  " }],
    ["not a number", { PR_NUMBER: "abc" }],
    ["zero", { PR_NUMBER: "0" }],
    ["negative", { PR_NUMBER: "-3" }],
    ["fractional", { PR_NUMBER: "4.5" }],
  ]) {
    test(`fails by name when PR_NUMBER is ${label}`, async () => {
      const github = githubStub();
      await assert.rejects(
        () => headSha({ github, context: { repo, payload: {} }, env }),
        /Cannot resolve the PR head SHA/,
        "a missing PR number must say so, not throw a TypeError on undefined",
      );
      assert.equal(github.calls.length, 0, "nothing to ask the API about");
    });
  }

  test("fails by name when the PR carries no head SHA", async () => {
    const github = { rest: { pulls: { get: async () => ({ data: {} }) } } };
    await assert.rejects(
      () => headSha({ github, context: { repo, payload: {} }, env: { PR_NUMBER: "42" } }),
      /returned no head SHA/,
    );
  });

  test("a half-formed event payload falls through to the API rather than throwing", async () => {
    const github = githubStub();
    for (const payload of [{ pull_request: {} }, { pull_request: { head: {} } }, { pull_request: null }]) {
      assert.equal(await headSha({ github, context: { repo, payload }, env: { PR_NUMBER: "42" } }), SHA);
    }
  });
});
