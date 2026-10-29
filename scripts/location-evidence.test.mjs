import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runParseStep, makeGithub, defaultFiles, HEAD_SHA } from '../evals/lib/harness.mjs';
const { inspectLocations } = createRequire(import.meta.url)('./location-evidence.cjs');
const { parseReview, buildReport, renderReport } = createRequire(import.meta.url)('./findings-report.cjs');

const response = (location, severity = 'NITPICK') => JSON.stringify({
  lens: 'Security Review', summary: 'Synthetic review',
  findings: [{ severity, location, detail: 'Synthetic issue', recommendation: 'Synthetic fix' }],
});

test('nonexistent locations remain visible but are explicitly unverified', async () => {
  const result = await runParseStep({ lensName: 'Security Review', agentResponse: response('missing.js:1', 'MUST FIX') });
  assert.equal(result.failed, null);
  assert.equal(result.event, 'REQUEST_CHANGES', 'Location evidence must not erase finding severity');
  assert.match(result.body, /Unverified repository locations/);
  assert.match(result.body, /Synthetic issue/);
  assert.equal(result.comments.length, 0);
  const findings = parseReview(result.body);
  assert.match(findings[0].detail, /^\[UNVERIFIED LOCATION: outside-reviewed-files\] Synthetic issue$/);
  assert.match(renderReport(buildReport([{ lens: 'Security Review', findings }], { verdict: 'BLOCK' })), /UNVERIFIED LOCATION/);
});

test('out-of-range locations are not presented as repository evidence', async () => {
  const result = await runParseStep({ lensName: 'Security Review', agentResponse: response('src/app.js:999') });
  assert.equal(result.failed, null);
  assert.match(result.body, /Unverified repository locations/);
  assert.equal(result.comments.length, 0);
});

test('valid added and context lines remain useful without invented inline anchors', async () => {
  for (const [line, inline] of [[2, 1], [1, 0]]) {
    const result = await runParseStep({ lensName: 'Security Review', agentResponse: response(`src/app.js:${line}`) });
    assert.equal(result.failed, null);
    assert.doesNotMatch(result.body, /Unverified repository locations/);
    assert.equal(result.comments.length, inline);
  }
});

async function inspect(locations, { files = defaultFiles(), sourceFiles, alter = () => {} } = {}) {
  const github = makeGithub({ files, sourceFiles });
  const calls = { trees: [], blobs: [] };
  for (const [method, list] of [['getTree', calls.trees], ['getBlob', calls.blobs]]) {
    const original = github.rest.git[method];
    github.rest.git[method] = async args => { list.push(args); return original(args); };
  }
  alter(github);
  const evidence = await inspectLocations({
    github, owner: 'acme', repo: 'widget', headSha: HEAD_SHA, files,
    findings: locations.map(location => ({ location })),
  });
  return { evidence, calls };
}

test('location reads use the immutable head tree and content-addressed blobs once per file', async () => {
  const { evidence, calls } = await inspect(['src/app.js:1', 'src/app.js:2', 'src/app.js:4']);
  assert(evidence.every(item => item.state === 'verified'));
  assert.equal(calls.trees.length, 1);
  assert.equal(calls.trees[0].tree_sha, HEAD_SHA);
  assert.equal(calls.blobs.length, 1);
  assert.match(calls.blobs[0].file_sha, /^[a-f0-9]{40}$/);
  assert(!('ref' in calls.blobs[0]), 'Blob retrieval must not use a mutable branch');
});

test('model paths outside the reviewed files and malformed locations trigger no source reads', async () => {
  const { evidence, calls } = await inspect(['elsewhere.js:1', '../escape.js:1', '/absolute.js:1', 'src/app.js:0', 'src/app.js:1-2']);
  assert(evidence.every(item => item.state === 'unverified'));
  assert.equal(calls.trees.length + calls.blobs.length, 0);
});

test('removed files and symlink/submodule tree modes are never followed', async () => {
  const removed = await inspect(['src/app.js:1'], { files: [{ filename: 'src/app.js', status: 'removed' }] });
  assert.equal(removed.evidence[0].reason, 'removed-file');
  assert.equal(removed.calls.trees.length, 0);
  for (const mode of ['120000', '160000']) {
    const result = await inspect(['src/app.js:1'], { alter(github) {
      const original = github.rest.git.getTree;
      github.rest.git.getTree = async args => {
        const response = await original(args); response.data.tree[0].mode = mode; return response;
      };
    } });
    assert.equal(result.evidence[0].reason, 'unsupported-source');
    assert.equal(result.calls.blobs.length, 0);
  }
});

test('failed or truncated trees are not retried or reused as partial evidence', async () => {
  for (const kind of ['error', 'truncated', 'duplicate']) {
    let attempts = 0;
    const result = await inspect(['a.js:1', 'b.js:1'], {
      files: [{ filename: 'a.js' }, { filename: 'b.js' }], sourceFiles: { 'a.js': 'a\n', 'b.js': 'b\n' },
      alter(github) {
        const original = github.rest.git.getTree;
        github.rest.git.getTree = async args => {
          attempts++;
          if (kind === 'error') throw new Error('PRIVATE_ERROR_SENTINEL');
          const response = await original(args);
          if (kind === 'truncated') response.data.truncated = true;
          else response.data.tree.push(response.data.tree[0]);
          return response;
        };
      },
    });
    assert.equal(attempts, 1);
    assert(result.evidence.every(item => item.state === 'unverified'));
    assert.equal(result.calls.blobs.length, 0);
    assert(!JSON.stringify(result.evidence).includes('PRIVATE_ERROR_SENTINEL'));
  }
});

test('malformed blobs, hash mismatches, binary and invalid UTF8 cannot verify a location', async () => {
  for (const kind of ['encoding', 'sha', 'size', 'bytes', 'binary', 'utf8']) {
    const result = await inspect(['src/app.js:1'], {
      sourceFiles: { 'src/app.js': kind === 'binary' ? Buffer.from([0]) : kind === 'utf8' ? Buffer.from([255]) : 'source\n' },
      alter(github) {
        const original = github.rest.git.getBlob;
        github.rest.git.getBlob = async args => {
          const response = await original(args);
          if (kind === 'encoding') response.data.content += '!';
          if (kind === 'sha') response.data.sha = 'f'.repeat(40);
          if (kind === 'size') response.data.size++;
          if (kind === 'bytes') response.data.content = Buffer.from('forged\n').toString('base64');
          return response;
        };
      },
    });
    assert.equal(result.evidence[0].state, 'unverified', kind);
  }
});

test('source lookups stop at the fixed blob budget', async () => {
  const files = Array.from({ length: 101 }, (_, i) => ({ filename: `src/file-${i}.js` }));
  const sourceFiles = Object.fromEntries(files.map(f => [f.filename, 'source\n']));
  const result = await inspect(files.map(f => `${f.filename}:1`), { files, sourceFiles });
  assert.equal(result.calls.blobs.length, 100);
  assert.equal(result.evidence.at(-1).reason, 'source-budget');
});

test('oversized source is not downloaded and aggregate source bytes are bounded', async () => {
  const tooLarge = await inspect(['src/app.js:1'], { alter(github) {
    const original = github.rest.git.getTree;
    github.rest.git.getTree = async args => {
      const response = await original(args); response.data.tree[0].size = 1024 * 1024 + 1; return response;
    };
  } });
  assert.equal(tooLarge.evidence[0].reason, 'unsupported-source');
  assert.equal(tooLarge.calls.blobs.length, 0);
  const files = Array.from({ length: 9 }, (_, i) => ({ filename: `src/large-${i}.js` }));
  const sourceFiles = Object.fromEntries(files.map(f => [f.filename, 'x'.repeat(1024 * 1024 - 1) + '\n']));
  const result = await inspect(files.map(f => `${f.filename}:1`), { files, sourceFiles });
  assert.equal(result.calls.blobs.length, 8);
  assert.equal(result.evidence.at(-1).reason, 'source-budget');
});
