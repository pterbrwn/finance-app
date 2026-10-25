import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
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

  const importKey = randomBytes(32);
  const tokenIv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', importKey, tokenIv);
  const ciphertext = Buffer.concat([cipher.update('synthetic-access-token'), cipher.final(), cipher.getAuthTag()]);
  const encoded = value => value.toString('base64');
  const legacyPath = join(directory, 'legacy-state.json');
  const configPath = join(directory, 'private-config.json');
  const importedPath = join(directory, 'imported.sqlite');
  await writeFile(legacyPath, JSON.stringify({ version: 1, owner: null, items: [{ id: 'legacy-item', token: { iv: encoded(tokenIv), data: encoded(ciphertext) }, cursor: 'cursor-legacy' }], accounts: [{ id: 'legacy-account', itemId: 'legacy-item' }], transactions: [{ id: 'legacy-transaction', accountId: 'legacy-account', itemId: 'legacy-item', amount: 1, date: '2026-01-01', override: 'Travel' }], budgets: { Travel: 5 } }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ tokenEncryptionKey: encoded(importKey), plaidEnv: 'production' }), { mode: 0o600 });
  await chmod(legacyPath, 0o600); await chmod(configPath, 0o600);
  const importer = ['scripts/import-legacy-json.mjs', legacyPath, importedPath, configPath];
  const firstImport = spawnSync(process.execPath, importer, { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(firstImport.status, 0, firstImport.stderr);
  const firstSummary = JSON.parse(firstImport.stdout);
  assert.equal(firstSummary.verifiedEncryptedTokens, 1);
  assert.equal(firstSummary.environmentUnspecifiedItems, 1, 'deployment environment is not guessed for legacy items');
  assert.equal((await stat(importedPath)).mode & 0o777, 0o600);
  const secondImport = spawnSync(process.execPath, importer, { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(secondImport.status, 0, secondImport.stderr);
  assert.equal(JSON.parse(secondImport.stdout).imported, false, 'same-source reruns are idempotent');
  const importedDb = new Database(importedPath, { readonly: true, fileMustExist: true });
  const importedItem = JSON.parse(importedDb.prepare('SELECT payload_json FROM items').get().payload_json);
  assert.equal(importedItem.environment, undefined);
  assert.equal(importedItem.token.data, encoded(ciphertext));
  assert.equal(importedItem.cursor, 'cursor-legacy');
  assert.equal(importedDb.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 1);
  assert.equal(importedDb.prepare('SELECT amount FROM budgets WHERE category=?').get('Travel').amount, 5);
  importedDb.close();

  console.log('SQLite ARM64 runtime, constraints, import preservation/idempotency, backup and restore passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
