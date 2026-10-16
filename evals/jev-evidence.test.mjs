import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const CLI=fileURLToPath(new URL('./jev-evidence.mjs',import.meta.url));
const CASE={id:'case',expected:'unverifiable',rationale:'Relevant suite not visible',split:'test',testPath:'tests/status.test.js',state:{acceptanceCriteria:'AC-1: test status',visibleDiff:'+++ b/src/status.js'}};
const fresh=()=>join(mkdtempSync(join(tmpdir(),'jev-cli-')),'run');
function manifest(cases=[CASE]) {
 const path=join(mkdtempSync(join(tmpdir(),'jev-manifest-')),'cases.json');
 writeFileSync(path,JSON.stringify({labelStatus:'draft',cases}));return path;
}
// A data: preload replaces global fetch so the call phase never reaches the network.
const stubFetch=status=>`data:text/javascript,globalThis.fetch=async()=>new Response('{}',{status:${status}})`;
function run(args,{env={},preload}={}) {
 const pre=preload?['--import',preload]:[];
 return spawnSync(process.execPath,[...pre,CLI,...args],{encoding:'utf8',env:{PATH:process.env.PATH,...env}});
}

test('rejects unknown flags, valueless flags, out-of-range reps and unknown phases',()=>{
 for(const [args,message] of [[['--bogus'],/Unknown flag --bogus/],[['--work'],/--work requires a value/],
  [['--work','--dry-run'],/--work requires a value/],[[],/Use --work/],[['--work',fresh(),'--reps','0'],/--reps must be 1..20/],
  [['--work',fresh(),'--reps','1.5'],/--reps must be 1..20/],[['--work',fresh(),'--phase','gate'],/Invalid phase/]]) {
  const r=run(args);assert.notEqual(r.status,0);assert.match(r.stderr,message);
 }
});

test('dry run composes a plan without credentials and refuses to overwrite it',()=>{
 const work=fresh(),args=['--dry-run','--work',work,'--manifest',manifest(),'--reps','2'];
 const first=run(args);
 assert.equal(first.status,0,first.stderr);assert.match(first.stdout,/1 cases, 2 calls planned/);
 const plan=JSON.parse(readFileSync(join(work,'plan.json'),'utf8'));
 assert.deepEqual({reps:plan.reps,labelStatus:plan.labelStatus,cases:plan.cases},{reps:2,labelStatus:'draft',cases:[CASE]});
 const second=run(args);assert.notEqual(second.status,0);assert.match(second.stderr,/Refusing to overwrite/);
});

test('call phase requires a key and refuses a run that already started',()=>{
 const work=fresh();assert.equal(run(['--phase','compose','--work',work,'--manifest',manifest()]).status,0);
 const noKey=run(['--phase','call','--work',work]);
 assert.notEqual(noKey.status,0);assert.match(noKey.stderr,/OPENROUTER_API_KEY required/);
 writeFileSync(join(work,'.started'),'');
 const again=run(['--phase','call','--work',work],{env:{OPENROUTER_API_KEY:'fake'},preload:stubFetch(200)});
 assert.notEqual(again.status,0);assert.match(again.stderr,/Refusing to overwrite a paid run/);
});

test('fatal provider status abandons the run after recording the failed call',()=>{
 const work=fresh(),cases=[CASE,{...CASE,id:'second'}];
 assert.equal(run(['--phase','compose','--work',work,'--manifest',manifest(cases)]).status,0);
 const r=run(['--phase','call','--work',work],{env:{OPENROUTER_API_KEY:'fake'},preload:stubFetch(401)});
 assert.notEqual(r.status,0);assert.match(r.stderr,/Fatal provider response/);
 assert.deepEqual(readdirSync(work).filter(f=>f.endsWith('.json')).sort(),['case.rep0.json','plan.json']);
 assert.equal(JSON.parse(readFileSync(join(work,'case.rep0.json'),'utf8')).error,'OpenRouter HTTP 401');
});

test('non-fatal provider failures continue, and scoring keeps unknown cost distinct from zero',()=>{
 const work=fresh();assert.equal(run(['--phase','compose','--work',work,'--manifest',manifest()]).status,0);
 const called=run(['--phase','call','--work',work],{env:{OPENROUTER_API_KEY:'fake'},preload:stubFetch(429)});
 assert.equal(called.status,0,called.stderr);assert.match(called.stdout,/case rep 0: OpenRouter HTTP 429/);
 assert.equal(run(['--phase','score','--work',work]).status,0);
 const report=JSON.parse(readFileSync(join(work,'report.json'),'utf8'));
 assert.deepEqual(report.usage,{reportedCostUsd:0,missingCostCalls:3,costUsd:null});
 assert.equal(report.bySplit.test.jev.failedCalls,3);
 assert.equal(report.bySplit.test.pathOnlyBaseline.correct,3);
 assert.match(readFileSync(join(work,'report.md'),'utf8'),/Reported classifier cost: unknown/);
});

test('score treats absent rep records as failures and rejects a plan whose question changed',()=>{
 const work=fresh();assert.equal(run(['--phase','compose','--work',work,'--manifest',manifest(),'--reps','1']).status,0);
 assert.equal(run(['--phase','score','--work',work]).status,0);
 assert.equal(JSON.parse(readFileSync(join(work,'report.json'),'utf8')).rows[0].error,'Missing/unreadable record');
 const plan=JSON.parse(readFileSync(join(work,'plan.json'),'utf8'));
 writeFileSync(join(work,'plan.json'),JSON.stringify({...plan,questionSha256:'0'.repeat(64)}));
 const r=run(['--phase','score','--work',work]);
 assert.notEqual(r.status,0);assert.match(r.stderr,/Question changed since compose/);
 assert.equal(existsSync(join(work,'.started')),false);
});
