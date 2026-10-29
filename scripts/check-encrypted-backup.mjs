import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSqliteRepositoryAt } from '../server/sqlite-repository.mjs';
import { exportEncryptedRecovery, restoreRehearsal } from './encrypted-backup.mjs';
import { runScheduledBackup } from './backup-runner.mjs';

const age = spawnSync('age', ['--version'], { encoding: 'utf8' });
if (age.error?.code === 'ENOENT') { console.error('BLOCKED: age is required for encrypted recovery round-trip.'); process.exitCode = 2; }
else {
  assert.equal(age.status, 0, `age version check failed: ${age.stderr}`);
  const root = await mkdtemp(join(tmpdir(), 'ledger-encrypted-recovery-')); await chmod(root, 0o700);
  try {
    const dataDir = join(root, 'data'), configPath = join(root, 'config.json'), identity = join(root, 'identity.txt');
    await mkdir(dataDir, { mode: 0o700 });
    const key = Buffer.alloc(32, 19).toString('base64');
    await writeFile(configPath, JSON.stringify({ storageMode: 'sqlite', enablePlaid: false, tokenEncryptionKey: key }), { mode: 0o600 });
    const repository = await createSqliteRepositoryAt(join(dataDir, 'ledger.sqlite'));
    await repository.mutate(state => { state.owner = 'synthetic-owner'; state.transactions.push({ id: 'recovery-canary', date: '2026-10-01', amount: 9876, currency: 'USD', accountId: 'synthetic-account' }); state.accounts.push({ id: 'synthetic-account', type: 'depository', balance: 9876, currency: 'USD' }); });
    await repository.close();
    const generated = spawnSync('age-keygen', ['-o', identity], { encoding: 'utf8' });
    assert.equal(generated.status, 0, `age-keygen failed: ${generated.stderr}`); await chmod(identity, 0o600);
    const recipientResult = spawnSync('age-keygen', ['-y', identity], { encoding: 'utf8' });
    assert.equal(recipientResult.status, 0, `age public-key derivation failed: ${recipientResult.stderr}`);
    const recipient = recipientResult.stdout.trim(); assert.match(recipient, /^age1[0-9a-z]+$/);
    const backup = await runScheduledBackup({ dataDir, configurationPath: configPath, now: () => new Date('2026-10-29T12:00:00.000Z') });
    assert.equal(backup.state, 'success');
    const bundle = (await readdir(join(dataDir, 'backups'))).find(name => name.endsWith('.recovery'));
    assert.ok(bundle); const bundlePath = join(dataDir, 'backups', bundle);
    const encryptedDirectory = join(root, 'encrypted');
    const encrypted = await exportEncryptedRecovery({ bundlePath, destinationDirectory: encryptedDirectory, recipient });
    assert.equal(encrypted.checks.encryption, 'age recipient encryption');
    assert.equal((await stat(encrypted.destination)).mode & 0o777, 0o600);
    const restoredDirectory = join(root, 'restored', 'bundle');
    const rehearsal = await restoreRehearsal({ encryptedPath: encrypted.destination, identity, destination: restoredDirectory });
    assert.equal(rehearsal.rehearsal, 'passed');
    const restoredDb = new Database(join(restoredDirectory, 'ledger.sqlite'), { readonly: true, fileMustExist: true });
    assert.equal(restoredDb.pragma('integrity_check', { simple: true }), 'ok');
    const state = JSON.parse(restoredDb.prepare('SELECT payload_json FROM transactions WHERE id=?').get('recovery-canary').payload_json);
    assert.equal(state.amount, 9876); assert.equal(state.id, 'recovery-canary'); restoredDb.close();
    const wrongDirectory = join(root, 'wrong-identity');
    await assert.rejects(restoreRehearsal({ encryptedPath: encrypted.destination, identity: (() => { const path = join(root, 'wrong.txt'); const result = spawnSync('age-keygen', ['-o', path]); assert.equal(result.status, 0); return path; })(), destination: wrongDirectory }));
    await assert.rejects(stat(wrongDirectory), { code: 'ENOENT' }, 'failed decryption publishes no restore destination');
    const corrupt = join(root, 'corrupt.age'); const ciphertext = await readFile(encrypted.destination); ciphertext[ciphertext.length - 1] ^= 0xff; await writeFile(corrupt, ciphertext, { mode: 0o600 });
    await assert.rejects(restoreRehearsal({ encryptedPath: corrupt, identity, destination: join(root, 'corrupt-restore') }));
    assert.deepEqual((await readdir(join(root, 'restored'))), ['bundle']);
    console.log('Encrypted recovery round-trip passed: ephemeral age keys, real tar/age pipeline, synthetic SQLite canary, permissions, wrong identity, and ciphertext corruption.');
  } finally { await rm(root, { recursive: true, force: true }); }
}
