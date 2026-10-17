// Reported provider usage only: unknown values are never imputed as zero.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const number = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
export function requestTitle(arm = 'baseline') {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(arm)) throw new Error('arm must be a short lowercase identifier');
  return `blind-peer-review-eval/${arm}`;
}
function median(xs) {
  if (!xs.length) return null;
  const ys = [...xs].sort((a,b)=>a-b), i=Math.floor(ys.length/2);
  return ys.length%2 ? ys[i] : (ys[i-1]+ys[i])/2;
}
function aggregate(records, classifier = false) {
  const attempts = classifier ? records : records.flatMap(r => r.attempts?.length ? r.attempts : [{usage:r.usage ?? null}]);
  const costs = attempts.map(r=>number(classifier ? r.usage?.cost?.total : r.usage?.cost));
  const missingCostAttempts = costs.filter(x=>x===null).length;
  const reportedCostUsd = costs.reduce((a,x)=>a+(x??0),0);
  const fields = classifier ? {
    input:u=>u?.input, output:u=>u?.output, total:u=>u?.totalTokens,
    cachedInput:u=>u?.cacheRead, reasoning:()=>null,
  } : {
    input:u=>u?.prompt_tokens, output:u=>u?.completion_tokens, total:u=>u?.total_tokens,
    cachedInput:u=>u?.prompt_tokens_details?.cached_tokens,
    reasoning:u=>u?.completion_tokens_details?.reasoning_tokens,
  };
  const tokens={}, missingTokenAttempts={};
  for(const [key,get] of Object.entries(fields)) {
    const values=attempts.map(r=>number(get(r.usage)));
    missingTokenAttempts[key]=values.filter(x=>x===null).length;
    tokens[key]=values.some(x=>x!==null) ? values.reduce((a,x)=>a+(x??0),0) : null;
  }
  const times=records.map(r=>number(r.ms)).filter(x=>x!==null);
  return {calls:records.length,failedCalls:records.filter(r=>r.error).length,attempts:attempts.length,
    tokens,missingTokenAttempts,reportedCostUsd,missingCostAttempts,
    costComplete:missingCostAttempts===0,costUsd:missingCostAttempts ? null : reportedCostUsd,
    latencyMs:{median:median(times),sum:times.reduce((a,x)=>a+x,0),reportedCalls:times.length}};
}
export function writeTelemetry(work, plan) {
  const records=[], advisors=[];
  for (const run of plan.runs) {
    const slug=`${run.id}__${run.lensKey}`;
    for(let rep=0;rep<plan.meta.reps;rep++) {
      const path=join(work,`${slug}.rep${rep}.json`);
      try { records.push(JSON.parse(readFileSync(path,'utf8'))); }
      catch { records.push({error:'missing or unreadable response',usage:null}); }
    }
    const path=join(work,`${slug}.advisory.json`);
    if(existsSync(path)) {
      try { advisors.push(JSON.parse(readFileSync(path,'utf8'))); }
      catch { advisors.push({error:'unreadable advisor record',usage:null}); }
    } else if(plan.meta.advisor?.mode && plan.meta.advisor.mode !== 'none') {
      advisors.push({error:'missing advisor record',usage:null});
    }
  }
  const summary=summarizeTelemetry(plan.meta,records,advisors);
  summary.costPerLensFixtureUsd=summary.combinedCostUsd===null||!plan.runs.length ? null : summary.combinedCostUsd/plan.runs.length;
  writeFileSync(join(work,'experiment.json'),JSON.stringify(summary,null,2)+'\n');
  return summary;
}
export function summarizeTelemetry(meta, records, advisors = []) {
  const chat=aggregate(records), advisor=aggregate(advisors,true);
  return {schemaVersion:1,model:meta.model??null,provider:meta.provider??null,arm:meta.arm??'baseline',
    ref:meta.ref??null,reps:meta.reps??null,maxTokens:meta.maxTokens??null,
    chat,advisor,combinedCostUsd:chat.costComplete&&advisor.costComplete ? chat.costUsd+advisor.costUsd : null,
    caveats:['Costs cover only usage reported by recorded attempts, not a provider billing reconciliation.',
      'Token sums with missingTokenAttempts > 0 are partial. Cached input and reasoning are subsets, not additional tokens.',
      'Latency sums are not wall-clock duration when calls run concurrently.']};
}
