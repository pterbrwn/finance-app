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
await writeFile(configFile, JSON.stringify({ enablePlaid: false, publicOrigin: 'https://ledger.example.ts.net', tailscaleLogin: 'owner@example.test' }), { mode: 0o600 });
let child;
async function start() {
  child = spawn('bash', ['scripts/start-ledger.sh'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0', LEDGER_LOCAL_DATA_DIR: directory, LEDGER_CONFIG_FILE: configFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Local server did not start: ' + output)), 5000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
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
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
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
  assert.equal((await (await local('import', sample)).json()).imported, 1);
  assert.equal((await (await local('import', sample)).json()).skipped, 1);
  const saved = await Promise.all([
    local('budget', { category: 'Groceries', amount: 50000 }),
    local('budget', { category: 'Dining', amount: 20000 })
  ]);
  saved.forEach(response => assert.equal(response.status, 200));
  bucket = await createLocalBucket(directory);
  const persisted = await (await local('state')).json();
  assert.equal(persisted.transactions.length, 1);
  assert.equal(persisted.transactions[0].amount, 4250);
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
    assert.deepEqual(state.transactions, []);
    assert.equal(await rawGetStatus('/api/state', { Host: 'untrusted.test' }), 403);
    assert.equal((await call('/api/budget', { category: 'Groceries', amount: 50000 }, { Origin: 'https://other.test' })).status, 403);
    assert.equal((await call('/api/state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal(await rawGetStatus('/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }), 200);
    assert.equal(await rawGetStatus('/api/state', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }), 403);
    assert.equal((await call('/api/state', undefined, { 'X-Forwarded-For': '100.100.100.1' })).status, 403);
    assert.equal((await call('/api/state', undefined, { 'Tailscale-User-Login': 'other@example.test' })).status, 403);
    assert.equal((await call('/api/state', undefined, { 'Tailscale-User-Login': 'owner@example.test' })).status, 200);
    assert.equal((await call('/api/budget', { category: 'Groceries', amount: 50000 }, { 'Tailscale-User-Login': 'owner@example.test', Origin: 'https://ledger.example.ts.net' })).status, 200);
    assert.equal((await call('/api/budget', { category: 'Groceries', amount: 50000 }, { 'Tailscale-User-Login': 'owner@example.test', Origin: 'https://other.test' })).status, 403);
    assert.equal((await call('/api/link-token', {})).status, 503);
    assert.ok(!(await call('/')).headers.get('Content-Security-Policy').includes('plaid.com'));
    const csv = { account: 'Local CSV', csv: 'Date,Merchant,Amount,Category\n2026-10-01,Meijer,42.50,Groceries' };
    assert.equal((await (await call('/api/import', csv)).json()).imported, 1);
    assert.equal((await (await call('/api/import', csv)).json()).skipped, 1);
    await Promise.all([
      call('/api/budget', { category: 'Groceries', amount: 50000 }),
      call('/api/budget', { category: 'Dining', amount: 20000 })
    ]);
    await stop();
    origin = await start();
    const restored = await (await call('/api/state')).json();
    assert.equal(restored.transactions.length, 1);
    assert.equal(restored.transactions[0].amount, 4250);
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
