import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { findDrift, loadSources } from "./check-citation-sources.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const cat = (source, entries = []) => [{ file: "x.json", source, entries }];
const stub = (pages) => async (url) => (url in pages ? { status: 200, body: Buffer.from(pages[url]) } : { status: 404, body: Buffer.alloc(0) });

test("no drift when every page resolves and the document hash matches", async () => {
  const c = cat({ url: "https://s/", document: "https://s/doc", sha256: sha("pdf") }, [{ id: "A01:2025", url: "https://s/a01" }]);
  assert.deepEqual(await findDrift(c, stub({ "https://s/": "", "https://s/doc": "pdf", "https://s/a01": "" })), []);
});

test("a changed document is drift", async () => {
  const c = cat({ url: "https://s/", document: "https://s/doc", sha256: sha("pdf") });
  const [d] = await findDrift(c, stub({ "https://s/": "", "https://s/doc": "pdf v2" }));
  assert.match(d, /document https:\/\/s\/doc changed/);
});

test("a hashed source URL is fetched once and compared", async () => {
  let calls = 0;
  const get = async () => (calls++, { status: 200, body: Buffer.from("zip") });
  assert.deepEqual(await findDrift(cat({ url: "https://s/cwe.zip", sha256: sha("zip") }), get), []);
  assert.equal(calls, 1);
});

test("an entry page that stops resolving is drift", async () => {
  const c = cat({ url: "https://s/" }, [{ id: "A10:2025", url: "https://s/gone" }]);
  assert.deepEqual(await findDrift(c, stub({ "https://s/": "" })), ["x.json: A10:2025 page https://s/gone returned HTTP 404"]);
});

test("a newer edition named by the probe is drift; the current one is not", async () => {
  const c = cat({ url: "https://s/", edition_probe: { url: "https://s/", pattern: "Top 10:(20\\d{2})", edition: 2025 } });
  assert.deepEqual(await findDrift(c, stub({ "https://s/": "Top 10:2021 Top 10:2025" })), []);
  const [d] = await findDrift(c, stub({ "https://s/": "Top 10:2025 Top 10:2028" }));
  assert.match(d, /mentions edition 2028, newer than the catalogue's 2025/);
});

test("a probe that matches no edition is reported, not passed", async () => {
  const c = cat({ url: "https://s/", edition_probe: { url: "https://s/", pattern: "Top 10:(20\\d{2})", edition: 2025 } });
  const [d] = await findDrift(c, stub({ "https://s/": "<html>Just a moment...</html>" }));
  assert.match(d, /matched no edition/);
});

test("a templated entry URL is checked through one sample entry", async () => {
  const c = cat({ url: "https://s/", entry_url: "https://s/defs/{n}.html" }, [{ id: "CWE-5" }, { id: "CWE-6" }]);
  assert.deepEqual(await findDrift(c, stub({ "https://s/": "", "https://s/defs/5.html": "" })), []);
  assert.deepEqual(await findDrift(c, stub({ "https://s/": "" })), ["x.json: CWE-5 page (entry_url template) https://s/defs/5.html returned HTTP 404"]);
});

test("a network failure is reported, not thrown", async () => {
  const d = await findDrift(cat({ url: "https://s/" }), async () => { throw new Error("ECONNRESET"); });
  assert.deepEqual(d, ["x.json: source page https://s/ could not be fetched (ECONNRESET)"]);
});

test("every shipped OWASP catalogue carries an edition probe whose pattern captures a year", () => {
  for (const { file, source } of loadSources().filter((c) => c.file.startsWith("owasp-"))) {
    assert.ok(source.edition_probe, `${file} has no edition_probe`);
    assert.equal(new RegExp(source.edition_probe.pattern).exec(`x ${source.edition_probe.pattern.replace(/\(20\\d\{2\}\)/, "2030").replace(/\\/g, "")}`)?.[1], "2030", file);
  }
});
