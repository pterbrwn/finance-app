import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createSqliteRepositoryAt } from '../server/sqlite-repository.mjs';
import { runScheduledBackup } from './backup-runner.mjs';
import { retainedBackupNames } from './backup-retention.mjs';

const directory = await mkdtemp(join(tmpdir(), 'ledger-backup-check-'));
try {
  const dataDir = join(directory, 'state');
  const configPath = join(directory, 'config.json');
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({ storageMode: 'sqlite' }), { mode: 0o600 });
  const repository = await createSqliteRepositoryAt(join(dataDir, 'ledger.sqlite'));
  await repository.mutate(state => { state.transactions.push({ id: 'synthetic-transaction', date: '2026-10-01', amount: 123 }); });
  await repository.close();

  const initial = await runScheduledBackup({ dataDir, configurationPath: configPath, now: () => new Date('2026-10-25T12:00:00.000Z') });
  assert.equal(initial.state, 'success');
  const backupDir = join(dataDir, 'backups');
  const initialBackup = (await readdir(backupDir)).find(name => name.startsWith('daily-') && name.endsWith('.sqlite'));
  assert.ok(initialBackup);
  const sourceBackup = join(backupDir, initialBackup);
  for (let offset = 1; offset <= 40; offset++) {
    const date = new Date(Date.UTC(2026, 10, 1 - offset, 12));
    const stamp = date.toISOString().replaceAll(':', '-');
    await copyFile(sourceBackup, join(backupDir, `daily-${stamp}.sqlite`));
    await chmod(join(backupDir, `daily-${stamp}.sqlite`), 0o600);
  }
  const protectedPath = join(backupDir, 'pre-migration-1-to-2-2026-10-01T00-00-00.000Z.sqlite');
  await copyFile(sourceBackup, protectedPath);
  await chmod(protectedPath, 0o600);

  const next = await runScheduledBackup({ dataDir, configurationPath: configPath, now: () => new Date('2026-11-01T12:00:00.000Z') });
  assert.equal(next.state, 'success');
  assert.equal(next.retainedCount, 11, 'retains seven daily, four weekly with overlap, and one protected migration backup');
  const retainedFiles = (await readdir(backupDir)).filter(name => name.endsWith('.sqlite'));
  assert.equal(retainedFiles.length, 11);
  assert.ok(retainedFiles.includes('pre-migration-1-to-2-2026-10-01T00-00-00.000Z.sqlite'));
  for (const name of retainedFiles) assert.equal((await stat(join(backupDir, name))).mode & 0o777, 0o600);
  assert.equal((await stat(backupDir)).mode & 0o777, 0o700);
  const retention = retainedBackupNames([
    { name: 'daily-2026-01-01T00-00-00.000Z.sqlite' },
    { name: 'daily-2026-01-02T00-00-00.000Z.sqlite' },
    { name: 'archive.sqlite' },
    { name: 'pre-migration-1-to-2-2026-01-01T00-00-00.000Z.sqlite' }
  ]);
  assert.ok(retention.has('archive.sqlite') === false, 'unknown filenames do not enter the retention set');
  assert.ok(retention.has('pre-migration-1-to-2-2026-01-01T00-00-00.000Z.sqlite'));

  const beforeFailure = [...retainedFiles].sort();
  await writeFile(join(dataDir, 'ledger.sqlite'), 'synthetic invalid sqlite', { mode: 0o600 });
  await chmod(join(dataDir, 'ledger.sqlite'), 0o600);
  await assert.rejects(runScheduledBackup({ dataDir, configurationPath: configPath, now: () => new Date('2026-11-02T12:00:00.000Z') }), /Scheduled backup failed/);
  const failedStatus = JSON.parse(await readFile(join(backupDir, 'backup-status.json'), 'utf8'));
  assert.equal(failedStatus.state, 'failed');
  assert.equal(failedStatus.failureCategory, 'backup_failed');
  assert.equal(failedStatus.lastSuccess, '2026-11-01T12:00:00.000Z', 'failed backup does not replace the last verified success');
  assert.deepEqual((await readdir(backupDir)).filter(name => name.endsWith('.sqlite')).sort(), beforeFailure, 'failed verification preserves the last good set');
  assert.equal((await stat(join(backupDir, 'backup-status.json'))).mode & 0o777, 0o600);

  const restoreProbe = spawnSync(process.execPath, ['scripts/sqlite-restore.mjs', sourceBackup, join(directory, 'restored.sqlite')], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(restoreProbe.status, 0, restoreProbe.stderr);
  const lockPath = join(backupDir, 'backup.lock');
  const lockHolder = spawn('flock', ['-F', lockPath, process.execPath, '-e', 'setTimeout(()=>{},1500)'], { stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 100));
  const competingBackup = spawnSync('bash', ['scripts/start-backup.sh'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, LEDGER_NODE_BIN: process.execPath, LEDGER_LOCAL_DATA_DIR: dataDir, LEDGER_CONFIG_FILE: configPath } });
  assert.notEqual(competingBackup.status, 0, 'overlapping scheduled backup is rejected by the lock');
  const competingRestore = spawnSync(process.execPath, ['scripts/sqlite-restore.mjs', sourceBackup, join(directory, 'blocked-restore.sqlite')], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.notEqual(competingRestore.status, 0, 'restore cannot race with backup pruning');
  await assert.rejects(stat(join(directory, 'blocked-restore.sqlite')), { code: 'ENOENT' }, 'blocked restore does not create a destination');
  await new Promise((resolve, reject) => { lockHolder.once('exit', code => code === 0 ? resolve() : reject(new Error('synthetic backup lock holder failed'))); lockHolder.once('error', reject); });
  console.log('Synthetic scheduled backup, private status, seven-daily/four-weekly retention, protected migration copies, failure preservation, and overlap/recovery locking passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
