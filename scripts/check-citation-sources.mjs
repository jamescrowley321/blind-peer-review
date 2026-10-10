#!/usr/bin/env node
// Detect drift between citations/ and the sources it was built from.
//
// The OWASP Web lens reviewed against the 2021 list for a year after the 2025
// edition shipped, because nothing noticed (#121). This re-fetches every
// catalogue source and reports, without changing anything:
//   - a source page or entry page that no longer resolves;
//   - a source document whose sha256 no longer matches the recorded one;
//   - an edition probe that finds a newer edition than the catalogue holds.
// Exit 0 with no output when nothing drifted; exit 1 and print one line per
// drift otherwise; exit 2 when the check itself broke (unreadable catalogue),
// so the workflow fails instead of filing an empty drift issue.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "citations");

export function loadSources(dir = DIR) {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((file) => ({ file, ...JSON.parse(readFileSync(join(dir, file), "utf8")) }));
}

// `get(url)` resolves to { status, body: Buffer }. Injected so the checks are
// testable without the network.
export async function findDrift(catalogues, get) {
  const drift = [];
  const fetchOk = async (file, url, what) => {
    try {
      const res = await get(url);
      if (res.status !== 200) drift.push(`${file}: ${what} ${url} returned HTTP ${res.status}`);
      return res.status === 200 ? res : null;
    } catch (e) {
      drift.push(`${file}: ${what} ${url} could not be fetched (${e.message})`);
      return null;
    }
  };
  for (const { file, source, entries } of catalogues) {
    const page = await fetchOk(file, source.url, "source page");
    if (source.sha256) {
      const docUrl = source.document || source.url;
      const doc = docUrl === source.url ? page : await fetchOk(file, docUrl, "document");
      if (doc) {
        const got = createHash("sha256").update(doc.body).digest("hex");
        if (got !== source.sha256) drift.push(`${file}: document ${docUrl} changed (sha256 ${got}, recorded ${source.sha256})`);
      }
    }
    for (const e of entries) if (e.url) await fetchOk(file, e.url, `${e.id} page`);
    // Templated entry links (CWE) are checked through one sample: the template
    // is what breaks, and 1,400 weekly requests would only re-test it.
    if (source.entry_url && entries.length) {
      const e = entries[0];
      await fetchOk(file, source.entry_url.replace("{n}", e.id.replace(/^CWE-/, "")), `${e.id} page (entry_url template)`);
    }
    if (source.edition_probe) {
      const { url, pattern, edition } = source.edition_probe;
      const res = await fetchOk(file, url, "edition probe");
      if (res) {
        const years = [...res.body.toString("utf8").matchAll(new RegExp(pattern, "g"))].map((m) => Number(m[1]));
        const newer = years.filter((y) => y > edition);
        // A page that names no edition at all (reworded, or a 200 challenge
        // page) would otherwise disable detection silently.
        if (!years.length) drift.push(`${file}: edition probe ${url} matched no edition with /${pattern}/; the probe needs updating`);
        else if (newer.length) drift.push(`${file}: ${url} mentions edition ${Math.max(...newer)}, newer than the catalogue's ${edition}`);
      }
    }
  }
  return drift;
}

async function get(url) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000), headers: { "user-agent": "blind-peer-review citation drift check" } });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const drift = await findDrift(loadSources(), get);
    for (const d of drift) console.log(d);
    process.exit(drift.length ? 1 : 0);
  } catch (e) {
    console.error(`citation source check failed: ${e.stack || e.message}`);
    process.exit(2);
  }
}
