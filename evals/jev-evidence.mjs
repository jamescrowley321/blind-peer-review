#!/usr/bin/env node
// Standalone shadow evaluator. Never changes a review or merge verdict.
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {validateManifest,scoreDecisions,deterministicBaseline} from './lib/jev-required-test.mjs';
import {classifyEvidence,QUESTIONS} from './lib/jev-required-test-client.mjs';

const args=process.argv.slice(2), options={phase:'all',reps:3,manifest:new URL('./jev-required-test-cases.json',import.meta.url),work:null,dry:false};
for(let i=0;i<args.length;i++) {
 const flag=args[i];
 if(flag==='--dry-run'){options.dry=true;continue;}
 if(!['--phase','--reps','--manifest','--work','--out'].includes(flag))throw new Error(`Unknown flag ${flag}`);
 const value=args[++i];if(!value||value.startsWith('--'))throw new Error(`${flag} requires a value`);
 options[flag==='--out'?'work':flag.slice(2)]=value;
}
if(!options.work)throw new Error('Use --work <new-directory> (or --out)');
options.work=resolve(options.work);options.reps=Number(options.reps);
if(!Number.isSafeInteger(options.reps)||options.reps<1||options.reps>20)throw new Error('--reps must be 1..20');
if(!['all','compose','call','score'].includes(options.phase))throw new Error('Invalid phase');
const planPath=join(options.work,'plan.json');
function compose() {
 if(existsSync(planPath))throw new Error('Refusing to overwrite an existing plan/results; use a new directory');
 const manifest=JSON.parse(readFileSync(options.manifest,'utf8'));
 const cases=validateManifest(manifest.cases);
 const plan={schemaVersion:1,labelStatus:manifest.labelStatus,reps:options.reps,model:'typesafe/jev-1.13',questionSha256:createHash('sha256').update(JSON.stringify(QUESTIONS)).digest('hex'),cases};
 mkdirSync(options.work,{recursive:true});writeFileSync(planPath,JSON.stringify(plan,null,2)+'\n');return plan;
}
function readPlan() {
 const plan=JSON.parse(readFileSync(planPath,'utf8'));validateManifest(plan.cases);
 if(plan.questionSha256!==createHash('sha256').update(JSON.stringify(QUESTIONS)).digest('hex'))throw new Error('Question changed since compose; use a new run');
 if(!Number.isSafeInteger(plan.reps)||plan.reps<1||plan.reps>20)throw new Error('Invalid planned reps');
 return plan;
}
async function call(plan) {
 if(!process.env.OPENROUTER_API_KEY)throw new Error('OPENROUTER_API_KEY required only for call phase');
 if(existsSync(join(options.work,'.started')))throw new Error('Refusing to overwrite a paid run');
 writeFileSync(join(options.work,'.started'),'');
 for(const c of plan.cases) for(let rep=0;rep<plan.reps;rep++) {
   const result=await classifyEvidence(c.state);
   writeFileSync(join(options.work,`${c.id}.rep${rep}.json`),JSON.stringify(result,null,2)+'\n');
   console.log(`${c.id} rep ${rep}: ${result.actual??result.error}`);
   if([400,401,402,404].includes(result.status))throw new Error('Fatal provider response; abandoning live run');
 }
}
function score(plan) {
 const rows=[];
 for(const c of plan.cases)for(let rep=0;rep<plan.reps;rep++) {
   let result;try{result=JSON.parse(readFileSync(join(options.work,`${c.id}.rep${rep}.json`),'utf8'));}catch{result={error:'Missing/unreadable record',usage:null};}
   rows.push({id:c.id,split:c.split,expected:c.expected,baseline:deterministicBaseline(c),rep,...result});
 }
 const costs=rows.map(r=>r.usage?.cost),known=costs.filter(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0);
 const report={model:plan.model,labelStatus:plan.labelStatus,questionSha256:plan.questionSha256,reps:plan.reps,caseCount:plan.cases.length,
  shadowOnly:true,bySplit:Object.fromEntries(['development','test'].map(split=>{
   const rs=rows.filter(r=>r.split===split);return [split,{jev:scoreDecisions(rs),pathOnlyBaseline:scoreDecisions(rs.map(r=>({...r,error:undefined,actual:r.baseline,probabilities:undefined})))}];
  })),usage:{reportedCostUsd:known.reduce((a,b)=>a+b,0),missingCostCalls:rows.length-known.length,costUsd:known.length===rows.length?known.reduce((a,b)=>a+b,0):null},rows};
 writeFileSync(join(options.work,'report.json'),JSON.stringify(report,null,2)+'\n');
 const lines=['# Jev required-test evidence shadow evaluation','',`Labels: ${plan.labelStatus}. No gate behavior changed.`,`${plan.cases.length} cases × ${plan.reps} reps. Repetitions do not create independent cases.`,
  'Synthetic families are closely related; this is a diagnostic experiment, not a held-out production benchmark.',''];
 for(const [split,s]of Object.entries(report.bySplit))lines.push(`## ${split}`,'','```json',JSON.stringify(s,null,2),'```','');
 lines.push(`Reported classifier cost: ${report.usage.costUsd===null?'unknown':`$${report.usage.costUsd.toFixed(6)}`}. Missing usage: ${report.usage.missingCostCalls}.`);
 writeFileSync(join(options.work,'report.md'),lines.join('\n')+'\n');console.log(JSON.stringify({bySplit:report.bySplit,usage:report.usage},null,2));
}
if(options.dry){const plan=compose();console.log(`Dry run: ${plan.cases.length} cases, ${plan.cases.length*plan.reps} calls planned; no credits spent.`);}
else if(options.phase==='compose'){compose();}
else if(options.phase==='call'){await call(readPlan());}
else if(options.phase==='score'){score(readPlan());}
else {const plan=compose();await call(plan);score(plan);}
