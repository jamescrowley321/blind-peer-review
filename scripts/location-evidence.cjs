// Repository-location evidence is independent of finding severity or truth.
// Read immutable Git objects only; never fetch model-supplied URLs or run code.
const { createHash } = require('node:crypto');
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_BLOBS = 100;
const SHA = /^[a-f0-9]{40}$/i;
const unverified = reason => ({ state: 'unverified', reason });

function parseLocation(value) {
  const match = typeof value === 'string' && value.match(/^(.+):([1-9]\d*)$/);
  if (!match) return null;
  const file = match[1], line = Number(match[2]);
  if (file.length > 1024 || /[\x00-\x1f\x7f\\]/.test(file) || file.startsWith('/') ||
      file.split('/').some(p => !p || p === '.' || p === '..') || !Number.isSafeInteger(line)) return null;
  return { file, line };
}

async function inspectLocations({ github, owner, repo, headSha, files, findings }) {
  const reviewed = new Map(files.map(file => [file.filename, file]));
  const cache = new Map();
  let tree, treeAttempted = false, blobs = 0, total = 0;
  async function source(file) {
    if (cache.has(file)) return cache.get(file);
    let result;
    try {
      if (!tree) {
        if (treeAttempted) throw new Error('Tree unavailable');
        treeAttempted = true;
        const response = await github.rest.git.getTree({ owner, repo, tree_sha: headSha, recursive: 'true' });
        if (!response.data || response.data.truncated !== false || !Array.isArray(response.data.tree) ||
            response.data.tree.length > 100000) throw new Error('Incomplete tree');
        const index = new Map();
        for (const item of response.data.tree) {
          if (typeof item.path !== 'string' || index.has(item.path)) throw new Error('Invalid tree');
          index.set(item.path, item);
        }
        tree = index;
      }
      const entry = tree.get(file);
      if (!entry) result = unverified('path-not-at-reviewed-head');
      else if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !SHA.test(entry.sha || '') ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) result = unverified('unsupported-source');
      else if (blobs >= MAX_BLOBS || total + entry.size > MAX_TOTAL_BYTES) result = unverified('source-budget');
      else {
        blobs++;
        const { data } = await github.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
        if (!data || data.sha !== entry.sha || data.size !== entry.size || data.encoding !== 'base64' ||
            typeof data.content !== 'string' || data.content.length > MAX_FILE_BYTES * 2) throw new Error('Invalid blob');
        const encoded = data.content.replace(/\r?\n/g, '');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded || bytes.length !== entry.size) throw new Error('Invalid encoding');
        const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (digest !== entry.sha.toLowerCase()) throw new Error('Blob mismatch');
        total += bytes.length;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (text.includes('\0')) throw new Error('Unsupported source');
        result = { state: 'verified', lines: text ? text.split('\n').length - Number(text.endsWith('\n')) : 0 };
      }
    } catch { result = unverified('source-unavailable'); }
    cache.set(file, result);
    return result;
  }
  const results = [];
  for (const finding of findings) {
    const location = parseLocation(finding.location);
    if (!location || !SHA.test(headSha || '')) { results.push(unverified('invalid-location-or-source')); continue; }
    const file = reviewed.get(location.file);
    if (!file) { results.push(unverified('outside-reviewed-files')); continue; }
    if (file.status === 'removed') { results.push(unverified('removed-file')); continue; }
    const evidence = await source(location.file);
    results.push(evidence.state === 'verified' && location.line > evidence.lines ? unverified('line-out-of-range') : evidence);
  }
  return results;
}

function locationWarning(evidence) {
  const missing = evidence.flatMap((entry, i) => entry.state === 'verified' ? [] : [`#${i + 1} (${entry.reason})`]);
  return missing.length ? `Unverified repository locations: ${missing.join(', ')}. These locations are not established as source evidence.` : '';
}

module.exports = { inspectLocations, locationWarning, parseLocation };
