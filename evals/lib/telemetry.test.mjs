import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTelemetry, requestTitle, writeTelemetry } from './telemetry.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chat } from './openrouter.mjs';

test('reports known tokens and cost without counting cached/reasoning subsets twice', () => {
 const r = summarizeTelemetry({model:'m',arm:'control'}, [{ms:200, attempts:[{usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,cost:0.01,prompt_tokens_details:{cached_tokens:30},completion_tokens_details:{reasoning_tokens:5}}}]}]);
 assert.equal(r.chat.tokens.input,100); assert.equal(r.chat.tokens.cachedInput,30);
 assert.equal(r.chat.tokens.output,20); assert.equal(r.chat.tokens.reasoning,5);
 assert.equal(r.chat.costUsd,0.01); assert.equal(r.chat.costComplete,true);
 assert.equal(r.chat.latencyMs.median,200);
});
test('missing and failed attempts make total cost unknown while preserving a known subtotal', () => {
 const r=summarizeTelemetry({}, [{ms:400,attempts:[{usage:null},{usage:{cost:0.02,prompt_tokens:2,completion_tokens:1}}]}, {error:'failed',attempts:[{usage:null}]}]);
 assert.equal(r.chat.attempts,3); assert.equal(r.chat.costUsd,null);
 assert.equal(r.chat.reportedCostUsd,0.02); assert.equal(r.chat.missingCostAttempts,2);
 assert.equal(r.chat.failedCalls,1);
});
test('zero is a reported cost, invalid numbers are not', () => {
 const r=summarizeTelemetry({},[{attempts:[{usage:{cost:0}},{usage:{cost:-1}}]}]);
 assert.equal(r.chat.reportedCostUsd,0);assert.equal(r.chat.costComplete,false);
});
test('old records and absent classifier usage cannot masquerade as zero-cost runs', () => {
 const r=summarizeTelemetry({},[{ms:50}], [{usage:null,ms:10}]);
 assert.equal(r.chat.costUsd,null); assert.equal(r.advisor.costUsd,null);assert.equal(r.combinedCostUsd,null);
});
test('classifier and chat cost are combined and secrets never appear in the summary', () => {
 const r=summarizeTelemetry({model:'m',arm:'jev-advisory'},[{text:'secret prompt',usage:{cost:0.1},ms:100}], [{usage:{input:30,output:5,totalTokens:35,cost:{total:0.01}},ms:20}]);
 assert.ok(Math.abs(r.combinedCostUsd-0.11)<1e-10);
 assert.equal(r.advisor.tokens.input,30);assert.equal(JSON.stringify(r).includes('secret prompt'),false);
 assert.equal(requestTitle('control'),'blind-peer-review-eval/control');
 assert.throws(()=>requestTitle('evil\nheader'),/arm/);
});
test('telemetry scans only plan-owned records and persists an honest missing-response summary', () => {
 const work=mkdtempSync(join(tmpdir(),'telemetry-test-'));
 try {
  writeFileSync(join(work,'a__security.rep0.json'),JSON.stringify({usage:{cost:0.1},ms:10}));
  writeFileSync(join(work,'stale__security.rep0.json'),JSON.stringify({usage:{cost:500}}));
  const summary=writeTelemetry(work,{meta:{arm:'control',reps:2},runs:[{id:'a',lensKey:'security'}]});
  assert.equal(summary.chat.calls,2); assert.equal(summary.chat.failedCalls,1);
  assert.equal(summary.chat.reportedCostUsd,0.1);assert.equal(summary.combinedCostUsd,null);
  assert.deepEqual(JSON.parse(readFileSync(join(work,'experiment.json'),'utf8')),summary);
 } finally {rmSync(work,{recursive:true,force:true});}
});
test('an assisted plan with a missing advisor record cannot report complete combined cost', () => {
 const work=mkdtempSync(join(tmpdir(),'telemetry-advisor-'));
 try {
  writeFileSync(join(work,'a__security.rep0.json'),JSON.stringify({usage:{cost:0.1}}));
  const summary=writeTelemetry(work,{meta:{arm:'jev-advisory',advisor:{mode:'jev'},reps:1},runs:[{id:'a',lensKey:'security'}]});
  assert.equal(summary.combinedCostUsd,null);assert.equal(summary.advisor.failedCalls,1);
 } finally {rmSync(work,{recursive:true,force:true});}
});
test('OpenRouter client labels requests and retains usage for an empty-response retry', async () => {
 const oldFetch=globalThis.fetch; const oldKey=process.env.OPENROUTER_API_KEY;
 process.env.OPENROUTER_API_KEY='test-key'; let calls=0;
 globalThis.fetch=async (_url,options)=>{
  assert.equal(options.headers['X-Title'],'blind-peer-review-eval/control');
  calls++;
  return new Response(JSON.stringify({id:'gen-'+calls,provider:'provider',model:'m',usage:{cost:0.01,prompt_tokens:10,completion_tokens:1},choices:[{finish_reason:calls===1?'error':'stop',message:{content:calls===1?'':'ok'}}]}),{status:200});
 };
 try{
  const r=await chat({model:'m',prompt:'p',arm:'control',attempts:2});
  assert.equal(r.attempts.length,2); assert.equal(r.attempts[0].usage.cost,0.01);
  assert.equal(r.generationId,'gen-2'); assert.equal(r.attempts[1].generationId,'gen-2');
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldKey;}
});
