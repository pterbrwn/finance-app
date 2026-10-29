import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { createSqliteRepositoryAt } from '../server/sqlite-repository.mjs';
import { runScheduledBackup } from './backup-runner.mjs';
import { retainedBackupNames } from './backup-retention.mjs';
import { verifyRecoveryBundle } from './recovery-bundle.mjs';

const directory = await mkdtemp(join(tmpdir(), 'ledger-backup-check-'));
try {
  const dataDir = join(directory, 'state');
  const configPath = join(directory, 'config.json');
  await mkdir(dataDir, { mode: 0o700 });
  const testKey=randomBytes(32),providerToken='synthetic-provider-token',iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',testKey,iv),encrypted=Buffer.concat([cipher.update(providerToken,'utf8'),cipher.final(),cipher.getAuthTag()]);
  await writeFile(configPath, JSON.stringify({ storageMode: 'sqlite',tokenEncryptionKey:testKey.toString('base64'),enablePlaid:true }), { mode: 0o600 });
  const repository = await createSqliteRepositoryAt(join(dataDir, 'ledger.sqlite'));
  await repository.mutate(state => { state.transactions.push({ id: 'synthetic-transaction', date: '2026-10-01', amount: 123,currency:'USD',category:'Other',accountId:'synthetic-account' });state.accounts.push({id:'synthetic-account',name:'Synthetic backup account',type:'depository',balance:123,currency:'USD'});state.items.push({id:'synthetic-item',token:{iv:iv.toString('base64'),data:encrypted.toString('base64')}}); });
  await repository.close();

  const initial = await runScheduledBackup({ dataDir, configurationPath: configPath, now: () => new Date('2026-10-25T12:00:00.000Z') });
  assert.equal(initial.state, 'success');assert.equal(initial.recoveryState,'complete');assert.equal(initial.lastCompleteRecovery,'2026-10-25T12:00:00.000Z');
  const backupDir = join(dataDir, 'backups');
  const initialBackup = (await readdir(backupDir)).find(name => name.startsWith('daily-') && name.endsWith('.sqlite'));
  assert.ok(initialBackup);
  const sourceBackup = join(backupDir, initialBackup),bundlePath=join(backupDir,initialBackup.replace(/\.sqlite$/,'.recovery'));
  const verifiedBundle=await verifyRecoveryBundle(bundlePath),manifestText=await readFile(join(bundlePath,'manifest.json'),'utf8'),statusText=await readFile(join(backupDir,'backup-status.json'),'utf8');
  assert.deepEqual(verifiedBundle.checks,{bundleChecksums:'verified',databaseIntegrity:'passed',tokens:'decrypted',restoreRehearsal:'not-performed'},'verification labels checksum, database, token, and rehearsal evidence separately');
  assert.deepEqual(JSON.parse(statusText).verification,verifiedBundle.checks,'backup status records the actual verification steps');
  assert.equal(verifiedBundle.manifest.version,1);assert.ok(Number.isInteger(verifiedBundle.manifest.database.schemaVersion));assert.equal(verifiedBundle.manifest.database.file,'ledger.sqlite');
  assert.equal(verifiedBundle.configuration.tokenEncryptionKey,testKey.toString('base64'),'the recovery bundle pairs the database with its exact private key configuration');
  assert.equal((await stat(bundlePath)).mode&0o777,0o700);for(const name of ['ledger.sqlite','config.json','manifest.json'])assert.equal((await stat(join(bundlePath,name))).mode&0o777,0o600);
  assert.ok(!manifestText.includes(testKey.toString('base64'))&&!statusText.includes(testKey.toString('base64'))&&!statusText.includes('synthetic-transaction'),'manifest and status expose neither keys nor record values');
  let oldestGeneratedBackup;
  for (let offset = 1; offset <= 40; offset++) {
    const date = new Date(Date.UTC(2026, 10, 1 - offset, 12));
    const stamp = date.toISOString().replaceAll(':', '-');
    const path = join(backupDir, `daily-${stamp}.sqlite`);
    await copyFile(sourceBackup, path);
    await chmod(path, 0o600);
    if (offset === 40) { oldestGeneratedBackup = path;const oldBundle=path.replace(/\.sqlite$/,'.recovery');await mkdir(oldBundle,{mode:0o700});await writeFile(join(oldBundle,'manifest.json'),'synthetic retention marker',{mode:0o600}); }
  }
  const protectedPath = join(backupDir, 'pre-migration-1-to-2-2026-10-01T00-00-00.000Z.sqlite');
  await copyFile(sourceBackup, protectedPath);
  await chmod(protectedPath, 0o600);
  const unknownBackups = new Map([
    ['archive.sqlite', Buffer.from('synthetic archive bytes')],
    ['daily-owner-copy.sqlite', Buffer.from('synthetic owner backup bytes')],
    ['daily-2026-02-30T00-00-00.000Z.sqlite', Buffer.from('synthetic impossible-date backup bytes')],
    ['archive.recovery', Buffer.from('synthetic unknown recovery artifact')]
  ]);
  for (const [name, bytes] of unknownBackups) {
    const path = join(backupDir, name);
    await writeFile(path, bytes, { mode: 0o600 });
    await chmod(path, 0o600);
  }

  const next = await runScheduledBackup({ dataDir, configurationPath: configPath, now: () => new Date('2026-11-01T12:00:00.000Z') });
  assert.equal(next.state, 'success');
  assert.equal(next.retainedCount, 11, 'retains seven daily, four weekly with overlap, and one protected migration backup');
  const retainedFiles = (await readdir(backupDir)).filter(name => name.endsWith('.sqlite'));
  assert.equal(retainedFiles.length, 14, 'retains eleven recognized backups plus three unrecognized SQLite files');
  assert.ok(retainedFiles.includes('pre-migration-1-to-2-2026-10-01T00-00-00.000Z.sqlite'));
  await assert.rejects(stat(oldestGeneratedBackup), { code: 'ENOENT' }, 'retention prunes an old recognized daily backup');
  await assert.rejects(stat(oldestGeneratedBackup.replace(/\.sqlite$/,'.recovery')), { code: 'ENOENT' }, 'retention prunes a database and its paired recovery directory as one set');
  for (const [name, bytes] of unknownBackups) assert.deepEqual(await readFile(join(backupDir, name)), bytes, `${name} is preserved byte-for-byte`);
  for (const name of retainedFiles) assert.equal((await stat(join(backupDir, name))).mode & 0o777, 0o600);
  assert.equal((await stat(backupDir)).mode & 0o777, 0o700);
  const retention = retainedBackupNames([
    { name: 'daily-2026-01-01T00-00-00.000Z.sqlite' },
    { name: 'daily-2026-01-02T00-00-00.000Z.sqlite' },
    { name: 'archive.sqlite' },
    { name: 'daily-owner-copy.sqlite' },
    { name: 'daily-2026-02-30T00-00-00.000Z.sqlite' },
    { name: 'pre-migration-1-to-2-2026-01-01T00-00-00.000Z.sqlite' }
  ]);
  assert.ok(retention.has('archive.sqlite') === false, 'unknown filenames do not enter the retention set');
  assert.ok(retention.has('daily-owner-copy.sqlite') === false, 'unrecognized daily names do not enter the retention set');
  assert.ok(retention.has('daily-2026-02-30T00-00-00.000Z.sqlite') === false, 'impossible timestamps do not enter the retention set');
  assert.ok(retention.has('pre-migration-1-to-2-2026-01-01T00-00-00.000Z.sqlite'));

  const completeSetBeforeFault = (await readdir(backupDir)).filter(name => name.endsWith('.sqlite')).sort();
  const bundlesBeforeFault = (await readdir(backupDir, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.recovery')).map(entry => entry.name).sort();
  let storageError;
  try {
    await runScheduledBackup({
      dataDir,
      configurationPath: configPath,
      now: () => new Date('2026-11-02T12:00:00.000Z'),
      faultInjection: async stage => {
        if (stage === 'before_bundle_publish') throw Object.assign(new Error('synthetic full device'), { code: 'ENOSPC' });
      }
    });
  } catch (error) { storageError = error; }
  assert.equal(storageError?.failureCategory, 'storage_unavailable', 'simulated ENOSPC is reported without exposing file contents');
  assert.deepEqual((await readdir(backupDir)).filter(name => name.endsWith('.sqlite')).sort(), completeSetBeforeFault, 'an out-of-space failure removes only its incomplete new snapshot');
  assert.deepEqual((await readdir(backupDir, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.recovery')).map(entry => entry.name).sort(), bundlesBeforeFault, 'an out-of-space failure preserves every previously complete bundle');
  const storageFailureStatus = JSON.parse(await readFile(join(backupDir, 'backup-status.json'), 'utf8'));
  assert.equal(storageFailureStatus.lastCompleteRecovery, '2026-11-01T12:00:00.000Z', 'storage failure does not advance the complete recovery timestamp');

  const markerPath = join(directory, 'backup-interruption.marker');
  const interrupted = spawn(process.execPath, ['scripts/check-backup-interruption-child.mjs', dataDir, configPath, markerPath], { cwd: resolve(import.meta.dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
  let interruptedError = '';
  interrupted.stderr.on('data', chunk => interruptedError += chunk);
  let reachedInterruption = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await stat(markerPath); reachedInterruption = true; break; } catch {}
    if (interrupted.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(reachedInterruption, `backup child reached the synthetic interruption point: ${interruptedError}`);
  interrupted.kill('SIGKILL');
  const interruptedExit = await new Promise(resolve => interrupted.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(interruptedExit.signal, 'SIGKILL', 'the synthetic backup process is forcibly interrupted at a known checkpoint');
  const interruptedSnapshot = join(backupDir, 'daily-2026-11-03T12-00-00.000Z.sqlite');
  await stat(interruptedSnapshot);
  await assert.rejects(stat(interruptedSnapshot.replace(/\.sqlite$/, '.recovery')), { code: 'ENOENT' }, 'an interrupted snapshot is not published as a recovery bundle');
  assert.ok((await readdir(backupDir)).includes(initialBackup), 'the last complete database snapshot survives process interruption');
  await verifyRecoveryBundle(bundlePath);
  const interruptedStatus = JSON.parse(await readFile(join(backupDir, 'backup-status.json'), 'utf8'));
  assert.equal(interruptedStatus.lastCompleteRecovery, '2026-11-01T12:00:00.000Z', 'interruption leaves the last complete recovery timestamp intact');
  await rm(interruptedSnapshot, { force: true });

  const beforeFailure = [...retainedFiles].sort(),beforeBundles=(await readdir(backupDir,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.endsWith('.recovery')).map(entry=>entry.name).sort();
  await writeFile(join(dataDir, 'ledger.sqlite'), 'synthetic invalid sqlite', { mode: 0o600 });
  await chmod(join(dataDir, 'ledger.sqlite'), 0o600);
  await assert.rejects(runScheduledBackup({ dataDir, configurationPath: configPath, now: () => new Date('2026-11-02T12:00:00.000Z') }), /Scheduled backup failed/);
  const failedStatus = JSON.parse(await readFile(join(backupDir, 'backup-status.json'), 'utf8'));
  assert.equal(failedStatus.state, 'failed');
  assert.equal(failedStatus.failureCategory, 'backup_failed');
  assert.equal(failedStatus.lastSuccess, '2026-11-01T12:00:00.000Z', 'failed backup does not replace the last verified success');
  assert.equal(failedStatus.lastCompleteRecovery,'2026-11-01T12:00:00.000Z','failed backup retains the last complete recovery timestamp');
  assert.deepEqual((await readdir(backupDir)).filter(name => name.endsWith('.sqlite')).sort(), beforeFailure, 'failed verification preserves the last good set');
  assert.deepEqual((await readdir(backupDir,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.endsWith('.recovery')).map(entry=>entry.name).sort(),beforeBundles,'failed verification preserves complete recovery bundles');
  assert.equal((await stat(join(backupDir, 'backup-status.json'))).mode & 0o777, 0o600);
  await chmod(configPath,0o644);await assert.rejects(runScheduledBackup({dataDir,configurationPath:configPath,now:()=>new Date('2026-11-03T12:00:00.000Z')}),/Scheduled backup failed/);await chmod(configPath,0o600);
  const permissionStatus=JSON.parse(await readFile(join(backupDir,'backup-status.json'),'utf8'));assert.equal(permissionStatus.failureCategory,'permission_denied');assert.equal(permissionStatus.lastCompleteRecovery,'2026-11-01T12:00:00.000Z');

  const restoreProbe = spawnSync(process.execPath, ['scripts/sqlite-restore.mjs', bundlePath, join(directory, 'restored.sqlite')], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(restoreProbe.status, 0, restoreProbe.stderr);
  const restoredRepository=await createSqliteRepositoryAt(join(directory,'restored.sqlite'));
  const restoredState=(await restoredRepository.read()).state,restoredMonth=await restoredRepository.queryMonthSummary('2026-10');
  assert.deepEqual(restoredState.transactions.map(row=>row.id),['synthetic-transaction']);assert.deepEqual(restoredState.accounts.map(row=>row.id),['synthetic-account']);assert.equal(restoredMonth.current.spend,123,'restored totals match independent synthetic arithmetic');
  const restoredEncrypted=Buffer.from(restoredState.items[0].token.data,'base64'),decipher=createDecipheriv('aes-256-gcm',Buffer.from(verifiedBundle.configuration.tokenEncryptionKey,'base64'),Buffer.from(restoredState.items[0].token.iv,'base64'));decipher.setAuthTag(restoredEncrypted.subarray(-16));const decrypted=Buffer.concat([decipher.update(restoredEncrypted.subarray(0,-16)),decipher.final()]).toString('utf8');
  assert.equal(decrypted,providerToken,'the database token decrypts with the configuration paired in the restored recovery bundle');await restoredRepository.close();
  const badKeyBundle=join(directory,'wrong-key.recovery');await mkdir(badKeyBundle,{mode:0o700});await copyFile(join(bundlePath,'ledger.sqlite'),join(badKeyBundle,'ledger.sqlite'));await copyFile(join(bundlePath,'manifest.json'),join(badKeyBundle,'manifest.json'));const wrongConfig={...verifiedBundle.configuration,tokenEncryptionKey:randomBytes(32).toString('base64')};await writeFile(join(badKeyBundle,'config.json'),JSON.stringify(wrongConfig),{mode:0o600});await chmod(join(badKeyBundle,'config.json'),0o600);const wrongManifest={...verifiedBundle.manifest,configuration:{...verifiedBundle.manifest.configuration,sha256:createHash('sha256').update(await readFile(join(badKeyBundle,'config.json'))).digest('hex')}};await writeFile(join(badKeyBundle,'manifest.json'),JSON.stringify(wrongManifest),{mode:0o600});await chmod(join(badKeyBundle,'manifest.json'),0o600);await assert.rejects(verifyRecoveryBundle(badKeyBundle),/encryption key does not match/i,'a wrong key is rejected before restore');
  const missingConfigBundle=join(directory,'missing-config.recovery');await mkdir(missingConfigBundle,{mode:0o700});await copyFile(join(bundlePath,'ledger.sqlite'),join(missingConfigBundle,'ledger.sqlite'));await copyFile(join(bundlePath,'manifest.json'),join(missingConfigBundle,'manifest.json'));await assert.rejects(verifyRecoveryBundle(missingConfigBundle),{code:'ENOENT'},'a missing paired configuration is rejected');
  const corruptBundle=join(directory,'corrupt-copy.recovery');await mkdir(corruptBundle,{mode:0o700});for(const name of ['ledger.sqlite','config.json','manifest.json'])await copyFile(join(bundlePath,name),join(corruptBundle,name));await chmod(join(corruptBundle,'ledger.sqlite'),0o600);const corrupted=await readFile(join(corruptBundle,'ledger.sqlite'));corrupted[corrupted.length-1]^=0xff;await writeFile(join(corruptBundle,'ledger.sqlite'),corrupted,{mode:0o600});await assert.rejects(verifyRecoveryBundle(corruptBundle),/checksum validation failed/i,'a corrupt copy is rejected');
  const lockPath = join(backupDir, 'backup.lock');
  const lockHolder = spawn('flock', ['-F', lockPath, process.execPath, '-e', 'setTimeout(()=>{},1500)'], { stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 100));
  const competingBackup = spawnSync('bash', ['scripts/start-backup.sh'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, LEDGER_NODE_BIN: process.execPath, LEDGER_LOCAL_DATA_DIR: dataDir, LEDGER_CONFIG_FILE: configPath } });
  assert.notEqual(competingBackup.status, 0, 'overlapping scheduled backup is rejected by the lock');
  const competingRestore = spawnSync(process.execPath, ['scripts/sqlite-restore.mjs', sourceBackup, join(directory, 'blocked-restore.sqlite')], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.notEqual(competingRestore.status, 0, 'restore cannot race with backup pruning');
  await assert.rejects(stat(join(directory, 'blocked-restore.sqlite')), { code: 'ENOENT' }, 'blocked restore does not create a destination');
  await new Promise((resolve, reject) => { lockHolder.once('exit', code => code === 0 ? resolve() : reject(new Error('synthetic backup lock holder failed'))); lockHolder.once('error', reject); });
  console.log('Synthetic scheduled backup and paired recovery bundle passed: checksums, permissions, key decryption, exact IDs/totals, wrong/missing key handling, corruption rejection, ENOSPC and interrupted-run preservation, retention, and locking.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
