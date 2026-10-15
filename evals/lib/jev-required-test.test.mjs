import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision, scoreDecisions, buildState, validateManifest, deterministicBaseline } from './jev-required-test.mjs';

test('rejects an answer outside the three evidence labels', () => {
 assert.throws(() => parseDecision({type:'choice',choice:'block',probabilities:{block:1}}),/invalid decision/);
});
test('keeps unverified distinct from a visible missing test', () => {
 const results=scoreDecisions([
  {expected:'visible_missing',actual:'visible_missing'},
  {expected:'visible_present',actual:'visible_present'},
  {expected:'unverifiable',actual:'visible_missing'},
 ]);
 assert.equal(results.accuracy,2/3);
 assert.equal(results.confusion.unverifiable.visible_missing,1);
});
test('rejects missing probabilities, unknown keys and distributions that do not sum to one', () => {
 for(const probabilities of [{visible_missing:1},{visible_missing:0.5,visible_present:0.5,unverifiable:0.2},{visible_missing:1,visible_present:0,unverifiable:0,approve:1}]) {
  assert.throws(()=>parseDecision({type:'choice',choice:'visible_missing',probabilities}),/probabilit/);
 }
});
test('reports precision, unsafe missing predictions, abstention recall and multiclass Brier score',()=>{
 const report=scoreDecisions([
  {id:'a',expected:'visible_missing',actual:'visible_missing',probabilities:{visible_missing:1,visible_present:0,unverifiable:0}},
  {id:'b',expected:'unverifiable',actual:'visible_missing',probabilities:{visible_missing:1,visible_present:0,unverifiable:0}},
  {id:'b',expected:'unverifiable',actual:'unverifiable',probabilities:{visible_missing:0,visible_present:0,unverifiable:1}},
 ]);
 assert.equal(report.missingPrecision,0.5);assert.equal(report.missingRecall,1);
 assert.equal(report.falseMissingRate,0.5);assert.equal(report.unverifiableRecall,0.5);
 assert.equal(report.brierScore,2/3);assert.equal(report.stableCaseRate,0.5);
});
test('errors are excluded from quality denominators but counted as failed calls',()=>{
 const r=scoreDecisions([{id:'a',expected:'visible_missing',error:'timeout'}]);
 assert.equal(r.failedCalls,1);assert.equal(r.accuracy,null);assert.equal(r.falseMissingRate,null);
});
test('manifest rejects duplicate ids, invalid labels and absent source rationale',()=>{
 const c={id:'case',expected:'unverifiable',rationale:'Test evidence absent',state:{acceptanceCriteria:'Test status',visibleDiff:'x'},split:'test',testPath:'tests/status.test.js'};
 assert.throws(()=>validateManifest([c,c]),/duplicate/);
 assert.throws(()=>validateManifest([{...c,expected:'approve'}]),/label/);
 assert.throws(()=>validateManifest([{...c,rationale:''}]),/rationale/);
 assert.equal(validateManifest([c]).length,1);
});
test('path-only baseline abstains when the relevant test is absent and makes no missing inference',()=>{
 assert.equal(deterministicBaseline({testPath:'tests/status.test.js',state:{visibleDiff:'+++ b/tests/unrelated.test.js\n+expect(x).toBe(1)'}}),'unverifiable');
 assert.equal(deterministicBaseline({testPath:'tests/status.test.js',state:{visibleDiff:'+++ b/tests/status.test.js\n+expect(x).toBe(1)'}}),'visible_present');
});
test('state never includes eval expectations or guards', () => {
 const state=buildState({prBody:'AC-1: test status',diff:'diff text',expected:'visible_missing',guards:'secret eval description'});
 assert.deepEqual(state,{acceptanceCriteria:'AC-1: test status',visibleDiff:'diff text'});
});
