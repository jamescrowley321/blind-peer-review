export const LABELS = ['visible_missing', 'visible_present', 'unverifiable'];
export function buildState(fixture) {
  return { acceptanceCriteria: fixture.prBody, visibleDiff: fixture.diff };
}
export function parseDecision(answer) {
  if (answer?.type !== 'choice' || !LABELS.includes(answer.choice)) throw new Error('invalid decision');
  const probabilities = answer.probabilities;
  if (!probabilities || Object.keys(probabilities).length !== 3 || !LABELS.every(k =>
    typeof probabilities[k] === 'number' && Number.isFinite(probabilities[k]) && probabilities[k] >= 0 && probabilities[k] <= 1)) {
    throw new Error('invalid decision probabilities');
  }
  if (Math.abs(Object.values(probabilities).reduce((a,b)=>a+b,0) - 1) > 0.001) throw new Error('invalid probability sum');
  return { choice: answer.choice, probability: probabilities[answer.choice], probabilities };
}
const ratio = (n,d) => d ? n/d : null;
export function scoreDecisions(rows) {
  const valid = rows.filter(r => !r.error);
  const confusion = Object.fromEntries(LABELS.map(e => [e, Object.fromEntries(LABELS.map(a => [a,0]))]));
  for (const r of valid) {
    if (!LABELS.includes(r.expected) || !LABELS.includes(r.actual)) throw new Error('invalid labelled row');
    confusion[r.expected][r.actual]++;
  }
  const missing = valid.filter(r=>r.expected === 'visible_missing');
  const predictedMissing = valid.filter(r=>r.actual === 'visible_missing');
  const unsafe = predictedMissing.filter(r=>r.expected !== 'visible_missing');
  const unknown = valid.filter(r=>r.expected === 'unverifiable');
  const calibrated = valid.filter(r=>r.probabilities);
  const groups = new Map();
  for(const r of valid) {
    if(!r.id) continue;
    if(!groups.has(r.id)) groups.set(r.id,[]);
    groups.get(r.id).push(r);
  }
  const correct = valid.filter(r=>r.expected === r.actual).length;
  return {count:rows.length,validCalls:valid.length,failedCalls:rows.length-valid.length,correct,
    accuracy:ratio(correct,valid.length),confusion,
    missingPrecision:ratio(predictedMissing.length-unsafe.length,predictedMissing.length),
    missingRecall:ratio(missing.filter(r=>r.actual==='visible_missing').length,missing.length),
    falseMissingRate:ratio(unsafe.length,valid.length-missing.length),
    unverifiableRecall:ratio(unknown.filter(r=>r.actual==='unverifiable').length,unknown.length),
    brierScore:ratio(calibrated.reduce((sum,r)=>sum+LABELS.reduce((s,k)=>s+(r.probabilities[k]-(k===r.expected?1:0))**2,0),0),calibrated.length),
    stableCaseRate:ratio([...groups.values()].filter(rs=>rs.every(r=>r.actual===rs[0].actual)).length,groups.size),
    calibrationBins:[0,1,2,3,4].map(i=>{
      const low=i/5,high=(i+1)/5;
      const bin=calibrated.filter(r=>Math.min(4,Math.floor(r.probabilities[r.actual]*5))===i);
      return {low,high,count:bin.length,meanProbability:ratio(bin.reduce((s,r)=>s+r.probabilities[r.actual],0),bin.length),accuracy:ratio(bin.filter(r=>r.actual===r.expected).length,bin.length)};
    })};
}
export function validateManifest(cases) {
  if(!Array.isArray(cases) || !cases.length) throw new Error('empty manifest');
  const ids=new Set();
  for(const c of cases) {
    if(typeof c.id !== 'string' || !/^[a-z0-9_-]+$/.test(c.id) || ids.has(c.id)) throw new Error('invalid or duplicate case id');
    ids.add(c.id);
    if(!LABELS.includes(c.expected)) throw new Error('invalid label');
    if(!c.rationale?.trim()) throw new Error('missing source rationale');
    if(!['development','test'].includes(c.split)) throw new Error('invalid split');
    if(typeof c.state?.acceptanceCriteria!=='string'||typeof c.state?.visibleDiff!=='string'||!c.testPath) throw new Error('invalid evidence state');
  }
  return cases;
}
export function deterministicBaseline(c) {
  return c.state.visibleDiff.split('\n').includes(`+++ b/${c.testPath}`) ? 'visible_present' : 'unverifiable';
}
