import { readFile, mkdir, writeFile, rm, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, extname, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const [client, css] = await Promise.all(['ui/browser.js','ui/styles.css'].map(p => readFile(resolve(root,p),'utf8')));
const requestsModule=await readFile(resolve(root,'ui/requests.mjs'),'utf8');
const dialogsModule=await readFile(resolve(root,'ui/dialogs.mjs'),'utf8');
const viewStateModule=await readFile(resolve(root,'ui/view-state.mjs'),'utf8');
const decimalBrowserModule=await readFile(resolve(root,'node_modules/decimal.js/decimal.mjs'),'utf8');
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
await copyFile(resolve(root,'worker/budget-routes.mjs'),resolve(root,'dist/server/budget-routes.mjs'));
await copyFile(resolve(root,'server/repository.mjs'),resolve(root,'dist/server/repository.mjs'));
for (const file of ['sqlite-repository.mjs','migrations/001-initial.sql','migrations/002-monthly-budgets.sql','migrations/003-transaction-query-indexes.sql','migrations/004-budget-analytics-index.sql','migrations/005-operation-results.sql','migrations/006-budget-records.sql','migrations/007-budget-history.sql','migrations/008-household-profiles.sql','migrations/009-profile-custom-categories.sql']) {
  await copyFile(resolve(root,'server',file),resolve(root,'dist/server',file));
}
for (const file of ['categories.mjs','dates.mjs','money.mjs','investments.mjs','reporting.mjs','reconciliation.mjs','rules.mjs','statement-reconciliation.mjs','transaction-splits.mjs','commitments.mjs','budgets.mjs','budget-frequency.mjs','budget-records.mjs','operation-identity.mjs','goals.mjs','mortgages.mjs','scenarios.mjs','net-worth.mjs','profiles.mjs']) {
  await copyFile(resolve(root,'shared',file),resolve(root,'dist/shared',file));
}
const budgetModule=await readFile(resolve(root,'shared/budgets.mjs'),'utf8');
const budgetFrequencyModule=await readFile(resolve(root,'shared/budget-frequency.mjs'),'utf8');
const goalsModule=await readFile(resolve(root,'shared/goals.mjs'),'utf8');
const datesModule=await readFile(resolve(root,'shared/dates.mjs'),'utf8');
const mortgagesModule=await readFile(resolve(root,'shared/mortgages.mjs'),'utf8');
const scenariosModule=await readFile(resolve(root,'shared/scenarios.mjs'),'utf8');
const netWorthModule=await readFile(resolve(root,'shared/net-worth.mjs'),'utf8');
const commitmentsModule=await readFile(resolve(root,'shared/commitments.mjs'),'utf8');
const browserModule=module=>module.replaceAll("from 'decimal.js'","from '/assets/decimal.mjs'").replaceAll('from "decimal.js"','from "/assets/decimal.mjs"');

const reactMode = ['1','true','react'].includes(String(process.env.LEDGER_UI_MODE ?? '').toLowerCase());
const reactCutover = process.env.LEDGER_UI_CUTOVER === '1';
let reactHtml = '';
const reactTextAssets = {};
const reactBinaryAssets = {};
if (reactMode || reactCutover) {
  const uiRoot = resolve(root, 'ledger-ui');
  const viteBin = resolve(uiRoot, 'node_modules/vite/bin/vite.js');
  if (!existsSync(viteBin)) throw new Error('LEDGER_UI_MODE=react requires ledger-ui dependencies. Run npm ci in ledger-ui first.');
  execFileSync(process.execPath, [viteBin, 'build'], { cwd: uiRoot, stdio: 'inherit' });
  const uiDist = resolve(uiRoot, 'dist');
  reactHtml = await readFile(join(uiDist, 'index.html'), 'utf8');
  const binaryExtensions = new Set(['.woff', '.woff2', '.ttf', '.eot', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);
  async function collectUiAssets(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectUiAssets(filename);
        continue;
      }
      if (entry.name === 'index.html') continue;
      const assetPath = '/' + relative(uiDist, filename).split(sep).join('/');
      if (binaryExtensions.has(extname(filename).toLowerCase())) {
        reactBinaryAssets[assetPath] = (await readFile(filename)).toString('base64');
      } else {
        reactTextAssets[assetPath] = await readFile(filename, 'utf8');
      }
    }
  }
  await collectUiAssets(uiDist);
}
await writeFile(resolve(root,'dist/server/generated.mjs'),
  'export const BUILD_ID = '+JSON.stringify(buildId)+';\n'+
  'export const UI_ASSETS = Object.freeze('+JSON.stringify({'/assets/app.js':client,'/assets/styles.css':css,'/assets/budgets.mjs':browserModule(budgetModule),'/assets/budget-frequency.mjs':browserModule(budgetFrequencyModule),'/assets/commitments.mjs':commitmentsModule,'/assets/dates.mjs':datesModule,'/assets/goals.mjs':browserModule(goalsModule),'/assets/mortgages.mjs':browserModule(mortgagesModule),'/assets/scenarios.mjs':browserModule(scenariosModule),'/assets/net-worth.mjs':browserModule(netWorthModule),'/assets/requests.mjs':requestsModule,'/assets/dialogs.mjs':dialogsModule,'/assets/view-state.mjs':viewStateModule,'/assets/decimal.mjs':decimalBrowserModule,...reactTextAssets})+');\n'+
  'export const REACT_BINARY_ASSETS = Object.freeze('+JSON.stringify(reactBinaryAssets)+');\n'+
  'export const REACT_UI_HTML = '+JSON.stringify(reactHtml)+';\n'+
  'export const REACT_UI_CUTOVER = '+(reactCutover?'true':'false')+';\n');
if (reactMode || reactCutover) {
  const serverFile = resolve(root, 'dist/server/index.js');
  let server = await readFile(serverFile, 'utf8');
  server = server.replace("import { BUILD_ID, UI_ASSETS } from './generated.mjs';", "import { BUILD_ID, UI_ASSETS, REACT_BINARY_ASSETS, REACT_UI_HTML, REACT_UI_CUTOVER } from './generated.mjs';");
  server = server.replace("      if (request.method === 'GET' && Object.hasOwn(UI_ASSETS, path)) {\n        const contentType = path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';\n        return new Response(UI_ASSETS[path], { headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });\n      }", "      if (request.method === 'GET' && (Object.hasOwn(UI_ASSETS, path) || Object.hasOwn(REACT_BINARY_ASSETS, path))) {\n        const contentType = path.endsWith('.css') ? 'text/css; charset=utf-8' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.woff2') ? 'font/woff2' : path.endsWith('.woff') ? 'font/woff' : path.endsWith('.ttf') ? 'font/ttf' : 'text/javascript; charset=utf-8';\n        if (Object.hasOwn(REACT_BINARY_ASSETS, path)) {\n          const bytes = Uint8Array.from(atob(REACT_BINARY_ASSETS[path]), char => char.charCodeAt(0));\n          return new Response(bytes, { headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });\n        }\n        return new Response(UI_ASSETS[path], { headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });\n      }");
  server = server.replace("if (path === '/' && request.method === 'GET')", "if ((path === '/' || path === '/react') && request.method === 'GET')");
  server = server.replace("function page() {\n  return '", "function page(path) {\n  if (typeof REACT_UI_HTML === 'string' && (path === '/react' || REACT_UI_CUTOVER)) return REACT_UI_HTML;\n  return '");
  server = server.replace('new Response(page(),', 'new Response(page(path),');
  await writeFile(serverFile, server);
}
await writeFile(resolve(root,'dist/package.json'),'{"type":"module"}\n');
console.log('Built standalone Ledger application.');
