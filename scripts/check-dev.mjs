import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { get } from 'node:http';
import { createLocalBucket } from './local-storage.mjs';
import worker from '../dist/server/index.js';

const directory = await mkdtemp(join(tmpdir(), 'ledger-dev-'));
const configFile = join(directory, 'config.json');
await writeFile(configFile, JSON.stringify({ enablePlaid: false, publicOrigin: 'https://ledger.example.ts.net', tailscaleLogin: 'owner@example.test', tailscaleMembers:[{login:'owner@example.test',actorId:'local-owner'},{login:'maddie@example.test',actorId:'maddie'}] }), { mode: 0o600 });
let child,childOutput='';const logCanary='SYNTHETIC_LOG_CANARY_93C1';
async function start() {
  childOutput='';child = spawn('bash', ['scripts/start-ledger.sh'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0', LEDGER_LOCAL_DATA_DIR: directory, LEDGER_CONFIG_FILE: configFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Local server did not start: ' + output)), 5000);
    child.stdout.on('data', chunk => {
      output += chunk;childOutput=output;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    child.stderr.on('data', chunk => { output += chunk;childOutput=output; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); reject(new Error('Local server exited: ' + code + ' ' + output)); });
  });
}
async function assertSecondWriterBlocked(directory, configFile) {
  const second = spawn('bash', ['scripts/start-ledger.sh'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0', LEDGER_LOCAL_DATA_DIR: directory, LEDGER_CONFIG_FILE: configFile },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const [code] = await once(second, 'exit');
  assert.notEqual(code, 0, 'a second server for the same data directory must fail');
}
async function stop() {
  if (child && child.exitCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
    assert.ok(childOutput.includes('"event":"shutdown_complete"'), 'SIGTERM drains requests and closes the local repository');
    assert.ok(!childOutput.includes(logCanary), 'request diagnostics never log query values');
    const requestEvent=childOutput.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(event=>event?.event==='request'&&event.route==='/api/state');
    assert.ok(requestEvent?.requestId&&requestEvent.method==='GET'&&requestEvent.status===200&&Number.isFinite(requestEvent.durationMs), 'request diagnostics include a bounded id, route, status, and duration');
  }
}
try {
  let bucket = await createLocalBucket(directory);
  const local = (path, input) => worker.fetch(new Request('http://127.0.0.1:3000/api/' + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-id': 'local-owner' },
    body: input === undefined ? undefined : JSON.stringify(input)
  }), { BUCKET: bucket });
  const sample = { account: 'Persisted CSV', csv: 'Date,Merchant,Amount,Category\n2026-10-01,Meijer,42.50,Groceries' };
  const firstPreview=await(await local('import-preview',sample)).json();
  assert.equal((await (await local('import',{...sample,revision:firstPreview.revision})).json()).imported, 1);
  const repeatPreview=await(await local('import-preview',sample)).json();
  assert.equal((await (await local('import',{...sample,revision:repeatPreview.revision})).json()).skipped, 1);
  let currentRevision=(await(await local('state')).json()).revision;
  const saved=[];
  for(const [category,amount] of [['Groceries',50000],['Dining',20000]]){
    const response=await local('budget',{category,amount,revision:currentRevision});assert.equal(response.status,200);saved.push(response);currentRevision=(await(await local('state')).json()).revision;
  }
  bucket = await createLocalBucket(directory);
  const persisted = await (await local('state')).json();
  assert.equal(persisted.transactionCount, 1);
  assert.equal(persisted.transactions, undefined, 'routine state response omits transaction history');
  const persistedPage=await(await local('transactions?limit=10&page=1')).json();
  assert.equal(persistedPage.transactions.length,1);
  assert.equal(persistedPage.transactions[0].amount,4250);
  assert.deepEqual(persisted.budgets, { Groceries: 50000, Dining: 20000 });
  assert.equal(persisted.setup.configured, false);
  console.log('Local storage checks passed: CSV imports, duplicate detection, concurrent updates, and persistence across storage instances.');
  await rm(join(directory, 'state.json'));
  if (process.argv.includes('--http')) {
    let origin = await start();
    await assertSecondWriterBlocked(directory, configFile);
    const call = (path, input, headers = {}) => fetch(origin + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: input === undefined ? undefined : JSON.stringify(input)
    });
    // Node fetch replaces Host and Sec-Fetch-Mode. Use raw HTTP when testing
    // browser-controlled headers so assertions exercise the intended request.
    const rawGetStatus = (path, headers) => new Promise((resolve, reject) => {
      get(origin + path, { headers }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    const page = await (await call('/')).text();
    const canaryResponse=await call('/api/state?query='+encodeURIComponent(logCanary));assert.equal(canaryResponse.status,200);await canaryResponse.text();
    assert.match(page, /Ledger · Personal finance/);
    assert.ok(page.includes('<script type="module" src="/assets/app.js"></script>'));
    assert.ok(!page.includes('<script>'));
    assert.equal((await call('/assets/app.js')).headers.get('Content-Type'), 'text/javascript; charset=utf-8');
    assert.equal((await call('/assets/styles.css')).headers.get('Content-Type'), 'text/css; charset=utf-8');
    assert.equal((await call('/assets/../worker/index.js')).status, 404);
    assert.equal((await call('/api/health')).status, 200);
    const state = await (await call('/api/state')).json();
    assert.equal(state.setup.configured, false);
    assert.equal(state.setup.localOnly, true);
    assert.equal(state.transactionCount, 0);
    assert.equal(state.transactions, undefined);
    assert.equal(await rawGetStatus('/api/state', { Host: 'untrusted.test' }), 403);
    assert.equal((await call('/api/budget', { category: 'Groceries', amount: 50000 }, { Origin: 'https://other.test' })).status, 403);
    assert.equal((await call('/api/state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal(await rawGetStatus('/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }), 200);
    assert.equal(await rawGetStatus('/api/state', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }), 403);
    assert.equal((await call('/api/state', undefined, { 'X-Forwarded-For': '100.100.100.1' })).status, 403);
    assert.equal((await call('/api/state', undefined, { 'Tailscale-User-Login': 'other@example.test' })).status, 403);
    assert.equal((await call('/api/state', undefined, { 'Tailscale-User-Login': 'owner@example.test' })).status, 200);
    assert.equal((await call('/api/state', undefined, { 'Tailscale-User-Login': 'maddie@example.test' })).status, 200,'a second explicitly configured household member can access the same household');
    assert.equal((await call('/api/state', undefined, { 'Tailscale-User-Login': 'third@example.test' })).status, 403,'an unlisted Tailscale identity is denied');
    assert.equal((await call('/api/budget', { category: 'Groceries', amount: 50000, revision: state.revision }, { 'Tailscale-User-Login': 'owner@example.test', Origin: 'https://ledger.example.ts.net' })).status, 200);
    assert.equal((await call('/api/budget', { category: 'Groceries', amount: 50000 }, { 'Tailscale-User-Login': 'owner@example.test', Origin: 'https://other.test' })).status, 403);
    assert.equal((await call('/api/link-token', {})).status, 503);
    assert.ok(!(await call('/')).headers.get('Content-Security-Policy').includes('plaid.com'));
    const csv = { account: 'Local CSV', csv: 'Date,Merchant,Amount,Category\n2026-10-01,Meijer,42.50,Groceries' };
    const preview=await(await call('/api/import-preview',csv)).json();
    assert.equal((await(await call('/api/import',{...csv,revision:preview.revision})).json()).imported, 1);
    const repeated=await(await call('/api/import-preview',csv)).json();
    assert.equal((await(await call('/api/import',{...csv,revision:repeated.revision})).json()).skipped, 1);
    let concurrentRevision=(await(await call('/api/state')).json()).revision;
    for(const [category,amount] of [['Groceries',50000],['Dining',20000]]){
      const response=await call('/api/budget',{category,amount,revision:concurrentRevision});assert.equal(response.status,200);concurrentRevision=(await(await call('/api/state')).json()).revision;
    }
    await stop();
    origin = await start();
    const restored = await (await call('/api/state')).json();
    assert.equal(restored.transactionCount, 1);
    assert.equal(restored.transactions, undefined);
    const restoredPage=await(await call('/api/transactions?limit=10&page=1')).json();
    assert.equal(restoredPage.transactions.length,1);
    assert.equal(restoredPage.transactions[0].amount,4250);
    assert.equal(restored.budgets.Groceries, 50000);
    assert.equal(restored.budgets.Dining, 20000);
    assert.equal(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).owner, 'local-owner');
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
    console.log('Local server checks passed: single-writer lock, static asset allowlist, health status, Host/Origin guards, CSV import, duplicate detection, concurrent writes, and restart persistence.');
  } else {
    console.log('HTTP preview checks not run. Run npm run check:local-http on a host that permits local servers.');
  }
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
