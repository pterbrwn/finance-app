import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import worker from '../worker/index.js';
import { createSqliteRepositoryAt } from '../server/sqlite-repository.mjs';
import { applySyncPages } from '../shared/reconciliation.mjs';
import { totals } from '../shared/reporting.mjs';

globalThis.crypto ||= webcrypto;
const SAMPLE_COUNT = 3;
const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(10_000, 100_000);
if (sizes.some(size => ![10_000, 100_000].includes(size))) throw new Error('Use only 10000 and/or 100000 transaction fixtures.');

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
async function measure(name, operation, samples = SAMPLE_COUNT) {
  const durations = [];
  let responseBytes = null;
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    const result = await operation();
    durations.push(performance.now() - started);
    if (result?.bytes !== undefined) responseBytes = result.bytes;
  }
  return { name, samples, medianMs: Number(quantile(durations, .5).toFixed(2)), p95Ms: Number(quantile(durations, .95).toFixed(2)), ...(responseBytes === null ? {} : { responseBytes }) };
}
function transaction(index) {
  const day = 1 + index % 28;
  const month = 1 + Math.floor(index / 28) % 12;
  const year = 2016 + Math.floor(index / 336) % 11;
  const amount = index % 17 === 0 ? -12.34 : (index % 113) + .25;
  return {
    id: `synthetic-${String(index).padStart(6, '0')}`, accountId: `manual-${index % 8}`, itemId: null,
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    merchant: `Merchant ${index % 500}`, amount: Math.round(amount * 100), currency: 'USD',
    category: ['Groceries', 'Dining', 'Shopping', 'Transport', 'Utilities'][index % 5],
    ...(index % 47 === 0 ? { override: 'Groceries', overrideCategoryId: 'system:groceries' } : {}),
    pending: index % 10 === 0, review: index % 97 === 0, confidence: index % 97 === 0 ? .4 : .95
  };
}
function api(env, path, input) {
  return worker.fetch(new Request(`https://ledger.measure.test/api/${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-id': 'synthetic-owner' },
    body: input === undefined ? undefined : JSON.stringify(input)
  }), env);
}
async function jsonCall(env, path, input) {
  const response = await api(env, path, input);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text.slice(0, 160)}`);
  return { value: JSON.parse(text), bytes: Buffer.byteLength(text) };
}

const results = [];
for (const size of sizes) {
  const directory = await mkdtemp(join(tmpdir(), `ledger-perf-${size}-`));
  const database = join(directory, 'ledger.sqlite');
  const repository = await createSqliteRepositoryAt(database);
  const resultStart = results.length;
  const rows = Array.from({ length: size }, (_, index) => transaction(index));
  await repository.mutate(state => {
    state.owner = 'synthetic-owner'; state.revision = 0;
    state.items = [{id:'synthetic-item',cursor:'before-sync',lifecycle:'connected'}];
    state.accounts = Array.from({ length: 8 }, (_, index) => ({ id: `manual-${index}`, itemId: null, type: 'depository', subtype: 'checking', name: `Synthetic checking ${index + 1}`, balance: 1000000, available: 900000, currency: 'USD', source: 'manual', manual: true, balanceAsOf: '2026-10-25' }));
    state.transactions = rows;
    state.goals = [{ id: 'goal-emergency', name: 'Synthetic emergency fund', target: 500000, targetDate: '2027-12-31' }];
    state.goalAllocations = [{ id: 'goal-allocation-1', goalId: 'goal-emergency', accountId: 'manual-0', amount: 25000, active: true }];
    state.properties = [{ id: 'property-synthetic', name: 'Synthetic home', nickname: 'Synthetic home', ownershipBps: 10000, valuation: 32000000, valuationAsOf: '2026-10-01' }];
    state.mortgages = Array.from({ length: 5 }, (_, index) => ({
      id: `mortgage-synthetic-${index + 1}`, propertyId: 'property-synthetic', lender: `Synthetic lender ${index + 1}`, loanType: 'fixed',
      statementBalance: 24000000 - index * 100000, balanceAsOf: '2026-10-01', originalPrincipal: 28000000 - index * 100000,
      originationDate: '2020-01-01', annualRatePercent: '6.5', termMonths: 360, ownerDebtShareBps: 10000,
      components: { principalInterest: 0, extraPrincipal: 0, propertyTax: null, insurance: null, hoa: null, utilities: null }, taxInsuranceEscrowed: false
    }));
    state.scenarios = [{ id: 'scenario-synthetic', versions: [{ id: 'quote-1', inputs: { purchasePrice: 40000000 } }] }];
    state.balanceSheetSnapshots = [{ date: '2026-10-01', assets: 51000000, liabilities: 24000000 }];
    state.budgets = { Groceries: 60000, Housing: 150000 };
    state.budgetTemplates = [
      { categoryId: 'system:groceries', amount: 60000, effectiveFrom: '2016-01' },
      { categoryId: 'system:housing', amount: 150000, effectiveFrom: '2016-01' }
    ];
    state.budgetCategoryIds = { 'system:groceries': 'Groceries', 'system:housing': 'Housing' };
    state.budgetHistoryUnavailableBefore = '2016-01';
  });
  const env = { REPOSITORY: repository, LOCAL_ONLY: true };
  const heapBefore = process.memoryUsage();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable();
  let peakMemory = { heapUsedBytes: heapBefore.heapUsed, rssBytes: heapBefore.rss };
  const memorySampler = setInterval(() => {
    const memory = process.memoryUsage();
    peakMemory = { heapUsedBytes: Math.max(peakMemory.heapUsedBytes, memory.heapUsed), rssBytes: Math.max(peakMemory.rssBytes, memory.rss) };
  }, 25);
  memorySampler.unref();
  const start = performance.now();
  const cold = await jsonCall(env, 'state');
  const coldMs = performance.now() - start;
  results.push({ size, operation: 'cold_state_bootstrap', samples: 1, medianMs: Number(coldMs.toFixed(2)), p95Ms: Number(coldMs.toFixed(2)), responseBytes: cold.bytes });
  results.push(await measure('warm_state_bootstrap', async () => ({ bytes: (await jsonCall(env, 'state')).bytes })));
  results.push(await measure('state_with_five_360_month_mortgages', async () => ({ bytes: (await jsonCall(env, 'state')).bytes })));
  results.push(await measure('paged_filter_search', async () => ({ bytes: (await jsonCall(env, 'transactions?page=1&limit=50&search=Merchant%2042')).bytes })));
  const monthEnd = new Date('2026-10-01T12:00:00Z'); monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1); monthEnd.setUTCDate(0);
  for (const span of [1, 3, 12]) {
    const from = new Date('2026-10-01T12:00:00Z'); from.setUTCMonth(from.getUTCMonth() - span + 1);
    const fromDate = from.toISOString().slice(0, 10), toDate = monthEnd.toISOString().slice(0, 10);
    results.push(await measure(`bounded_transaction_window_${span}_months`, async () => ({ bytes: (await jsonCall(env, `transactions?from=${fromDate}&to=${toDate}&page=1&limit=100`)).bytes })));
  }
  results.push(await measure('sqlite_month_summary', async () => ({ bytes: (await jsonCall(env, 'month-summary?month=2026-10')).bytes })));
  results.push(await measure('budget_summary_2016_to_2026', async () => ({ bytes: (await jsonCall(env, 'budget-summary?month=2026-10')).bytes })));
  const referenceBudgetEnv={...env,REPOSITORY:{...repository,readBudgetAnalytics:undefined}};
  results.push(await measure('budget_summary_full_state_reference', async () => ({ bytes: (await jsonCall(referenceBudgetEnv, 'budget-summary?month=2026-10')).bytes })));
  results.push(await measure('selected_month_aggregation', async () => {
    const monthRows = rows.filter(row => row.date.startsWith('2026-10'));
    const summary = totals(monthRows);
    return { rows: monthRows.length, spend: summary.spend };
  }));

  const state = (await jsonCall(env, 'state')).value;
  const shopping = state.categoryCatalog.find(category => category.name === 'Shopping' && category.kind === 'expense');
  const groceries = state.categoryCatalog.find(category => category.name === 'Groceries' && category.kind === 'expense');
  assert.ok(shopping && groceries);
  results.push(await measure('single_category_mutation', async () => {
    const current = (await jsonCall(env, 'state')).value;
    const response = await jsonCall(env, 'category', { id: 'synthetic-000001', categoryId: shopping.id, revision: current.revision });
    return response;
  }, 1));
  results.push(await measure('bulk_category_edit_100', async () => {
    const current = (await jsonCall(env, 'state')).value;
    const ids = rows.slice(0, 100).map(row => row.id);
    const response = await jsonCall(env, 'category-bulk', { ids, categoryId: groceries.id, revision: current.revision });
    return response;
  }, 1));
  results.push(await measure('budget_edit', async () => {
    const current = (await jsonCall(env, 'state')).value;
    return jsonCall(env, 'budget', { categoryId: groceries.id, amount: 60000, mode: 'template', month: '2026-10', schedule: { frequency: 'monthly', dueMonth: null, sourceAmount: 60000 }, revision: current.revision });
  }, 1));
  results.push(await measure('goal_edit', async () => {
    const current = (await jsonCall(env, 'state')).value;
    return jsonCall(env, 'goal', { id: 'goal-emergency', name: 'Synthetic emergency fund', target: 500000, targetDate: '2027-12-31', priority: 1, monthlyContribution: 1000, apyBps: 0, revision: current.revision });
  }, 1));
  results.push(await measure('manual_account_edit', async () => {
    const current = (await jsonCall(env, 'state')).value, account = current.accounts.find(row => row.id === 'manual-0');
    return jsonCall(env, 'manual-account', { id: account.id, name: account.name, type: account.type, subtype: account.subtype, balance: account.balance, currency: account.currency, asOf: account.balanceAsOf, includeInReporting: true, revision: current.revision });
  }, 1));
  const syncStarted = performance.now();
  await repository.mutateTransactionSubset(['synthetic-sync-page'],current => {
    applySyncPages(current, 'synthetic-item', [{ added: [{ transaction_id: 'synthetic-sync-page', account_id: 'provider-account', date: '2026-10-25', amount: 4.25, name: 'Synthetic sync page', iso_currency_code: 'USD' }], modified: [], removed: [] }]);
    current.items.find(item=>item.id==='synthetic-item').cursor='after-sync';
  });
  results.push({ name: 'sync_page_commit', samples: 1, medianMs: Number((performance.now() - syncStarted).toFixed(2)) });

  const csvLines = ['Date,Merchant,Amount,Category'];
  for (let index = 0; index < 5000; index++) csvLines.push(`2026-10-${String(index % 28 + 1).padStart(2, '0')},Synthetic import ${index},${(index % 70 + 1).toFixed(2)},Groceries`);
  const csvInput = { account: `Synthetic import ${size}`, csv: csvLines.join('\n') };
  const previewStart = performance.now();
  const previewResponse = await jsonCall(env, 'import-preview', csvInput);
  const previewMs = performance.now() - previewStart;
  assert.equal(previewResponse.value.rows, 5000);
  const commitStart = performance.now();
  const commit = await jsonCall(env, 'import', { ...csvInput, revision: previewResponse.value.revision });
  const commitMs = performance.now() - commitStart;
  assert.equal(commit.value.imported, 5000);
  await repository.close();
  const restartStart = performance.now();
  const restarted = await createSqliteRepositoryAt(database);
  const restartMs = performance.now() - restartStart;
  env.REPOSITORY = restarted;
  const duplicateStart = performance.now();
  const duplicate = await jsonCall(env, 'import-preview', csvInput);
  const duplicateMs = performance.now() - duplicateStart;
  assert.equal(duplicate.value.alreadyImported, true);
  const undoStart = performance.now();
  const undo = await jsonCall(env, 'import-undo', { batchId: commit.value.batchId, revision: duplicate.value.revision });
  const undoMs = performance.now() - undoStart;
  assert.equal(undo.value.undone, 5000);
  results.push({ name: 'csv_5000_preview', samples: 1, medianMs: Number(previewMs.toFixed(2)), responseBytes: previewResponse.bytes, csvBytes: Buffer.byteLength(csvInput.csv) });
  results.push({ name: 'csv_5000_commit', samples: 1, medianMs: Number(commitMs.toFixed(2)), imported: commit.value.imported });
  results.push({ name: 'sqlite_restart', samples: 1, medianMs: Number(restartMs.toFixed(2)) });
  results.push({ name: 'csv_duplicate_detection_after_restart', samples: 1, medianMs: Number(duplicateMs.toFixed(2)), alreadyImported: duplicate.value.alreadyImported });
  results.push({ name: 'csv_5000_undo', samples: 1, medianMs: Number(undoMs.toFixed(2)), undone: undo.value.undone });

  const backupPath = join(directory, 'benchmark-backup.sqlite');
  const backupStart = performance.now();
  const backup = spawnSync(process.execPath, ['scripts/sqlite-backup.mjs', database, backupPath], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(backup.status, 0, backup.stderr);
  const backupMs = performance.now() - backupStart;
  const backupBytes = (await stat(backupPath)).size;
  const restorePath = join(directory, 'benchmark-restore.sqlite');
  const restoreStart = performance.now();
  const restore = spawnSync(process.execPath, ['scripts/sqlite-restore.mjs', backupPath, restorePath], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(restore.status, 0, restore.stderr);
  results.push({ name: 'backup_restore', samples: 1, backupMs: Number(backupMs.toFixed(2)), restoreMs: Number((performance.now() - restoreStart).toFixed(2)), backupBytes });

  await new Promise(resolve => setTimeout(resolve, 25)); clearInterval(memorySampler); eventLoop.disable();
  const heapAfter = process.memoryUsage();
  results.push({ size, operation: 'process_memory_event_loop', samples: 1, heapUsedBeforeBytes: heapBefore.heapUsed, heapUsedAfterBytes: heapAfter.heapUsed, peakHeapUsedBytes: peakMemory.heapUsedBytes, rssAfterBytes: heapAfter.rss, peakRssBytes: peakMemory.rssBytes, eventLoopDelayP95Ms: Number((eventLoop.percentile(95) / 1e6).toFixed(2)), host: { platform: process.platform, arch: process.arch, node: process.version, cpu: cpus()[0]?.model || 'unknown', cpuCount: cpus().length, totalMemoryBytes: totalmem() } });
  await restarted.close();
  for (const result of results.slice(resultStart)) result.size ??= size;
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ syntheticOnly: true, capturedAt: new Date().toISOString(), results }, null, 2));
