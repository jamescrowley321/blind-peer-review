import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { evaluate, QUESTIONS } from './codex-decisions.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-decisions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { allowedRoots: [root], excludedRoots: [], provider: 'openrouter',
    model: 'typesafe/jev-1.14', keyEnv: 'ORG_KEY', mode: 'shadow' };
  const event = { hook_event_name: 'UserPromptSubmit', cwd: root,
    prompt: 'Improve the account workflow.', session_id: 's', turn_id: 't' };
  return { root, config, event };
}
function reply(provider = 'openrouter', probability = 0.99) {
  const answers = Object.fromEntries(Object.keys(QUESTIONS).map(name => [name,
    { type: 'noul', noul: probability }]));
  return new Response(JSON.stringify({ answers: provider === 'openrouter' ? answers :
    Object.keys(answers).map(name => ({ name, type: 'predicate', probability })),
    usage: { input_tokens: 500, cost: 0.001, unsafe: 'not telemetry' } }));
}
test('shadow batches questions, pins ZDR and does not inject guidance', async t => {
  const { config, event } = await fixture(t);
  let calls = 0;
  const result = await evaluate(event, config, { env: { ORG_KEY: 'test' }, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.provider, { zdr: true, allow_fallbacks: false });
    assert.equal(body.state.userRequest, event.prompt);
    assert.equal(Object.keys(body.questions).length, 2);
    return reply();
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.output, {});
  assert.equal(result.record.outcome, 'evaluated');
  assert.equal(result.record.probabilities.consequential_ambiguity, 0.99);
  assert.ok(!JSON.stringify(result.record).includes(event.prompt));
  assert.ok(!JSON.stringify(result.record).includes('unsafe'));
});
test('direct OpenAI maps predicates and validates its response', async t => {
  const { config, event } = await fixture(t);
  Object.assign(config, { provider: 'openai', model: 'gpt-6-luna' });
  const result = await evaluate(event, config, { env: { ORG_KEY: 'test' }, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    const body = JSON.parse(options.body);
    assert.equal(body.questions[0].type, 'predicate');
    assert.equal(body.input, JSON.stringify({ userRequest: event.prompt }));
    return reply('openai');
  } });
  assert.equal(result.record.outcome, 'evaluated');
});
test('explicit advice respects previous answers and cannot authorize actions', async t => {
  const { config, event } = await fixture(t);
  config.mode = 'advisory'; config.threshold = 0.9;
  const result = await evaluate(event, config, { env: { ORG_KEY: 'test' }, fetchImpl: async () => reply() });
  const context = result.output.hookSpecificOutput.additionalContext;
  assert.match(context, /already resolved/);
  assert.match(context, /not evidence or authorization/);
  assert.ok(context.length < 1500);
  assert.equal(result.output.decision, undefined);
});
test('no key and invalid config never call any provider', async t => {
  const { config, event } = await fixture(t);
  const noNetwork = { fetchImpl: () => { throw Error('must not call'); }, env: {} };
  assert.equal((await evaluate(event, config, noNetwork)).record.outcome, 'missing_key');
  for (const change of [{ provider: 'other' }, { mode: 'block' }, { model: 'arbitrary' },
    { threshold: NaN }, { threshold: 1.1 }, { keyEnv: 'bad-name' }, { allowedRoots: [] }]) {
    assert.equal((await evaluate(event, { ...config, ...change }, noNetwork)).record.outcome, 'invalid_config');
  }
});
test('realpath scope rejects siblings, excluded paths and symlink escapes', async t => {
  const { root, config, event } = await fixture(t);
  const allowed = join(root, 'allowed'); const excluded = join(allowed, 'excluded');
  const sibling = join(root, 'allowed-other');
  await mkdir(excluded, { recursive: true }); await mkdir(sibling);
  await symlink(sibling, join(allowed, 'escape'));
  config.allowedRoots = [allowed]; config.excludedRoots = [excluded];
  let calls = 0;
  for (const cwd of [sibling, excluded, join(allowed, 'escape')]) {
    const result = await evaluate({ ...event, cwd }, config, { env: { ORG_KEY: 'test' }, fetchImpl: async () => { calls++; return reply(); } });
    assert.equal(result.record.outcome, 'out_of_scope');
  }
  assert.equal(calls, 0);
});
test('bad inputs and credential-like prompts never reach network', async t => {
  const { config, event } = await fixture(t);
  for (const prompt of ['', 'x'.repeat(16001), 'Bearer abc.def.ghi', 'OPENAI_API_KEY=example', 'sk-or-v1-example']) {
    let called = false;
    const result = await evaluate({ ...event, prompt }, config, { env: { ORG_KEY: 'test' }, fetchImpl: async () => { called = true; return reply(); } });
    assert.equal(called, false);
    assert.deepEqual(result.output, {});
  }
  assert.equal((await evaluate({ ...event, hook_event_name: 'Stop' }, config)).record.outcome, 'ignored_event');
});
test('malformed probabilities, duplicate answers, refusal and missing answers abstain', async t => {
  const { config, event } = await fixture(t);
  for (const body of [{}, { answers: { consequential_ambiguity: { type: 'noul', noul: '1' } } },
    { answers: Object.fromEntries(Object.keys(QUESTIONS).map(k => [k, { type: 'noul', noul: 1.1 }])) }]) {
    const result = await evaluate(event, config, { env: { ORG_KEY: 'test' }, fetchImpl: async () => new Response(JSON.stringify(body)) });
    assert.equal(result.record.outcome, 'invalid_response');
    assert.deepEqual(result.output, {});
  }
  Object.assign(config, { provider: 'openai', model: 'gpt-6-luna' });
  for (const answers of [[{ name: 'consequential_ambiguity', type: 'refusal' }],
    [...Object.keys(QUESTIONS), 'consequential_ambiguity'].map(name => ({ name, type: 'predicate', probability: 1 }))]) {
    assert.equal((await evaluate(event, config, { env: { ORG_KEY: 'test' }, fetchImpl: async () => new Response(JSON.stringify({ answers })) })).record.outcome, 'invalid_response');
  }
});
test('HTTP errors and transport failures do not retry or leak provider content', async t => {
  const { config, event } = await fixture(t);
  for (const fetchResult of [() => new Response('SECRET BODY', { status: 429 }), () => { throw Error('SECRET EXCEPTION'); }]) {
    let calls = 0;
    const result = await evaluate(event, config, { env: { ORG_KEY: 'test' }, fetchImpl: async () => { calls++; return fetchResult(); } });
    assert.equal(calls, 1);
    assert.deepEqual(result.output, {});
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.notEqual(result.record.outcome, 'evaluated');
  }
});
test('CLI logs missing-key metadata, ignores transcript files, and always emits JSON', async t => {
  const { config, event, root } = await fixture(t);
  const configPath = join(root, 'config.json');
  config.logPath = join(root, 'log.jsonl');
  await writeFile(configPath, JSON.stringify(config));
  event.transcript_path = '/file/that/must/not/be/read';
  const run = input => spawnSync(process.execPath, [new URL('./codex-decisions.mjs', import.meta.url).pathname,
    '--config', configPath], { input, encoding: 'utf8', env: {} });
  let result = run(JSON.stringify(event));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
  const log = await readFile(config.logPath, 'utf8');
  assert.equal(JSON.parse(log).outcome, 'missing_key');
  assert.ok(!log.includes(event.prompt));
  result = run('{malformed');
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.ok(!result.stderr.includes('malformed'));
});
test('response body size cap and UTF-8 input cap abstain rather than truncate', async t => {
  const { config, event } = await fixture(t);
  const large = await evaluate(event, config, { env: { ORG_KEY: 'test' }, fetchImpl: async () => new Response('x'.repeat(65537)) });
  assert.equal(large.record.outcome, 'invalid_response');
  let calls = 0;
  const result = await evaluate({ ...event, prompt: '😀'.repeat(4001) }, config, { env: { ORG_KEY: 'test' }, fetchImpl: async () => { calls++; return reply(); } });
  assert.equal(result.record.outcome, 'oversized_prompt');
  assert.equal(calls, 0);
});
test('low scores produce no guidance and requests carry a bounded abort signal', async t => {
  const { config, event } = await fixture(t);
  config.mode = 'advisory';
  const result = await evaluate(event, config, { env: { ORG_KEY: 'test' }, fetchImpl: async (_, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return reply('openrouter', 0.1);
  } });
  assert.deepEqual(result.output, {});
});
