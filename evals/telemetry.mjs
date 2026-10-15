#!/usr/bin/env node
// Rebuild usage summaries from saved responses; no model calls or credentials.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeTelemetry } from './lib/telemetry.mjs';
const args=process.argv.slice(2);
if(args.length!==2 || args[0]!=='--work') {
  console.error('Usage: node evals/telemetry.mjs --work <saved-run-directory>');
  process.exit(2);
}
const work=resolve(args[1]);
const plan=JSON.parse(readFileSync(join(work,'plan.json'),'utf8'));
const summary=writeTelemetry(work,plan);
console.log(JSON.stringify(summary,null,2));
