import { readFile, mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const [client, css] = await Promise.all(['ui/browser.js','ui/styles.css'].map(p => readFile(resolve(root,p),'utf8')));
let buildId = process.env.LEDGER_BUILD_ID;
if (!buildId) {
  try { buildId = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { buildId = 'unversioned'; }
}
if (!/^[A-Za-z0-9._-]{1,80}$/.test(buildId)) throw new Error('LEDGER_BUILD_ID must be a short safe identifier.');
await rm(resolve(root,'dist'),{recursive:true,force:true});
await mkdir(resolve(root,'dist/server'),{recursive:true});
await mkdir(resolve(root,'dist/server/migrations'),{recursive:true});
await mkdir(resolve(root,'dist/shared'),{recursive:true});
await copyFile(resolve(root,'worker/index.js'),resolve(root,'dist/server/index.js'));
await copyFile(resolve(root,'server/repository.mjs'),resolve(root,'dist/server/repository.mjs'));
for (const file of ['sqlite-repository.mjs','migrations/001-initial.sql','migrations/002-monthly-budgets.sql']) {
  await copyFile(resolve(root,'server',file),resolve(root,'dist/server',file));
}
for (const file of ['categories.mjs','money.mjs','investments.mjs','reporting.mjs','reconciliation.mjs','budgets.mjs','goals.mjs','mortgages.mjs','scenarios.mjs']) {
  await copyFile(resolve(root,'shared',file),resolve(root,'dist/shared',file));
}
const budgetModule=await readFile(resolve(root,'shared/budgets.mjs'),'utf8');
const goalsModule=await readFile(resolve(root,'shared/goals.mjs'),'utf8');
const mortgagesModule=await readFile(resolve(root,'shared/mortgages.mjs'),'utf8');
const scenariosModule=await readFile(resolve(root,'shared/scenarios.mjs'),'utf8');
await writeFile(resolve(root,'dist/server/generated.mjs'),
  'export const BUILD_ID = '+JSON.stringify(buildId)+';\n'+
  'export const UI_ASSETS = Object.freeze('+JSON.stringify({'/assets/app.js':client,'/assets/styles.css':css,'/assets/budgets.mjs':budgetModule,'/assets/goals.mjs':goalsModule,'/assets/mortgages.mjs':mortgagesModule,'/assets/scenarios.mjs':scenariosModule})+');\n');
await writeFile(resolve(root,'dist/package.json'),'{"type":"module"}\n');
console.log('Built standalone Ledger application.');
