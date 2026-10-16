import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvidence } from './jev-required-test-client.mjs';
test('transport sends only evidence and preserves billed usage even with malformed decisions',async()=>{
 let payload;
 const result=await classifyEvidence({acceptanceCriteria:'Test status',visibleDiff:'diff'}, {key:'fake',fetchImpl:async (_url,options)=>{
  payload=JSON.parse(options.body);
  return new Response(JSON.stringify({usage:{input_tokens:10,cost:0.001},answers:{decision:{type:'choice',choice:'approve'}}}),{status:200});
 }});
 assert.deepEqual(Object.keys(payload).sort(),['model','questions','state']);
 assert.deepEqual(payload.state,{acceptanceCriteria:'Test status',visibleDiff:'diff'});
 assert.match(result.error,/invalid decision/);assert.equal(result.usage.cost,0.001);
});
test('provider failures are recorded without copying billing or credential-bearing error bodies',async()=>{
 const result=await classifyEvidence({acceptanceCriteria:'x',visibleDiff:'y'},{key:'fake',fetchImpl:async()=>new Response('private billing state',{status:402})});
 assert.equal(result.error,'OpenRouter HTTP 402'); assert.equal(JSON.stringify(result).includes('private billing'),false);
});
test('timeouts, non-JSON bodies and network errors become a generic transport failure with timing',async()=>{
 for(const fetchImpl of [async()=>{throw new DOMException('aborted','TimeoutError');},async()=>new Response('<html>',{status:200}),async()=>{throw new TypeError('fetch failed: sk-or-secret');}]) {
  const result=await classifyEvidence({acceptanceCriteria:'x',visibleDiff:'y'},{key:'fake',fetchImpl});
  assert.equal(result.error,'Classifier transport failure');assert.equal(result.usage,null);assert.equal(typeof result.ms,'number');
  assert.equal(JSON.stringify(result).includes('sk-or-secret'),false);
 }
});
test('a missing key fails before any request is sent',async()=>{
 let called=false;
 await assert.rejects(classifyEvidence({acceptanceCriteria:'x',visibleDiff:'y'},{key:'',fetchImpl:async()=>{called=true;}}),/OPENROUTER_API_KEY required/);
 assert.equal(called,false);
});
