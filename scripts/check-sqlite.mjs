import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createSqliteRepositoryAt, SQLITE_SCHEMA_VERSION } from '../server/sqlite-repository.mjs';

assert.match(process.version, /^v24\./);
assert.equal(SQLITE_SCHEMA_VERSION, 1);
const directory = await mkdtemp(join(tmpdir(), 'ledger-sqlite-check-'));
try {
  const databasePath = join(directory, 'ledger.sqlite');
  const repository = await createSqliteRepositoryAt(databasePath);
  await repository.mutate(state => {
    state.owner = 'synthetic-owner';
    state.items.push({ id: 'item-1', token: { data: 'synthetic-ciphertext', iv: 'synthetic-iv' }, cursor: 'cursor-x' });
    state.accounts.push({ id: 'account-1', itemId: 'item-1', source: 'provider', balance: 12345 });
    state.transactions.push({ id: 'txn-1', accountId: 'account-1', itemId: 'item-1', date: '2026-01-03', amount: 2500, currency: 'USD', override: 'Travel' });
    state.holdings.push({ id: 'holding-1', itemId: 'item-1', quantity: '1.250' });
    state.customCategories.push('Travel');
    state.budgets.Travel = 40000;
  });
  const read = (await repository.read()).state;
  assert.equal(read.transactions[0].override, 'Travel');
  assert.equal(read.items[0].token.data, 'synthetic-ciphertext');
  assert.equal(read.accounts[0].balance, 12345);
  assert.equal(read.budgets.Travel, 40000);
  await assert.rejects(repository.mutate(state => {
    state.accounts.push({ id: 'orphan-account', itemId: 'missing-item' });
  }));
  assert.equal((await repository.read()).state.accounts.length, 1, 'failed FK writes roll back as a unit');
  await repository.close();

  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();

  const backupPath = join(directory, 'verified.sqlite');
  const backupResult = spawnSync(process.execPath, ['scripts/sqlite-backup.mjs', databasePath, backupPath], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(backupResult.status, 0, backupResult.stderr);
  assert.equal(JSON.parse(backupResult.stdout).ok, true);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  const restoredPath = join(directory, 'restored.sqlite');
  const restoreResult = spawnSync(process.execPath, ['scripts/sqlite-restore.mjs', backupPath, restoredPath], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(restoreResult.status, 0, restoreResult.stderr);
  const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 1);
  assert.equal(restored.prepare("SELECT json_extract(payload_json, '$.override') AS value FROM transactions").get().value, 'Travel');
  restored.close();

  console.log('SQLite ARM64 runtime, constraints, transaction rollback, backup and restore passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
