import { chmod, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDailyBackupName, retainedBackupNames } from './backup-retention.mjs';
import { sha256File, verifyRecoveryBundle } from './recovery-bundle.mjs';
import { BUILD_ID } from '../dist/server/generated.mjs';

const execFileAsync = promisify(execFile);
const dataDirectory = resolve(process.env.LEDGER_LOCAL_DATA_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'ledger'));
const configPath = resolve(process.env.LEDGER_CONFIG_FILE || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ledger/config.json'));
const backupDirectory = join(dataDirectory, 'backups');
const statusPath = join(backupDirectory, 'backup-status.json');

async function readPrivateBytes(path) {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw Object.assign(new Error('private_file'), { code: 'EACCES' });
  return readFile(path);
}
async function readPrivateJson(path) { return JSON.parse((await readPrivateBytes(path)).toString('utf8')); }

function failureCategory(error, phase) {
  if (phase === 'retention') return 'retention_failed';
  if (error?.code === 'ENOENT') return 'source_unavailable';
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return 'permission_denied';
  if (error?.code === 'ENOSPC') return 'storage_unavailable';
  return 'backup_failed';
}

export async function runScheduledBackup({ dataDir = dataDirectory, configurationPath = configPath, now = () => new Date(), faultInjection } = {}) {
  const directory = resolve(dataDir);
  const backupDir = join(directory, 'backups');
  const statusFile = join(backupDir, 'backup-status.json');
  const attemptedAt = now().toISOString();
  let previous = {};
  let verifiedSuccessAt = null;
  try { previous = await readPrivateJson(statusFile); } catch (error) { if (error.code !== 'ENOENT') previous = {}; }
  const previousCompleteAt=typeof previous.lastCompleteRecovery==='string'?previous.lastCompleteRecovery:null;
  let targetPath=null,recoveryPath=null,backupCreated=false,bundlePublished=false,bundleComplete=false,verification=null;
  let phase = 'configuration';
  try {
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    await chmod(backupDir, 0o700);
    let configuration,configurationBytes;
    try { configurationBytes=await readPrivateBytes(resolve(configurationPath));configuration=JSON.parse(configurationBytes.toString('utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const status = { state: 'not_configured', lastAttempt: attemptedAt, lastSuccess: previous.lastSuccess || null, failureCategory: null };
      await saveStatusAt(statusFile, backupDir, status);
      return status;
    }
    if (configuration.storageMode !== 'sqlite') {
      const status = { state: 'not_configured', lastAttempt: attemptedAt, lastSuccess: previous.lastSuccess || null, failureCategory: null };
      await saveStatusAt(statusFile, backupDir, status);
      return status;
    }
    const source = join(directory, 'ledger.sqlite');
    const sourceInfo = await stat(source);
    if ((sourceInfo.mode & 0o077) !== 0 || sourceInfo.uid !== process.getuid()) throw Object.assign(new Error('private_source'), { code: 'EACCES' });
    phase = 'backup';
    const stamp = attemptedAt.replaceAll(':', '-');
    const target = join(backupDir, `daily-${stamp}.sqlite`);targetPath=target;
    const runner = join(import.meta.dirname, 'sqlite-backup.mjs');
    const backupResult=JSON.parse((await execFileAsync(process.execPath,[runner,source,target],{timeout:120_000,maxBuffer:2048,encoding:'utf8'})).stdout);
    backupCreated=true;
    if(typeof faultInjection==='function')await faultInjection('after_database_snapshot');
    const configAfter=await readPrivateBytes(resolve(configurationPath));
    if(createHash('sha256').update(configurationBytes).digest('hex')!==createHash('sha256').update(configAfter).digest('hex'))throw Object.assign(new Error('configuration_changed_during_backup'),{code:'ESTALE'});
    phase='recovery_bundle';
    const bundlePath=target.replace(/\.sqlite$/,'')+'.recovery',staging=join(backupDir,'.'+randomUUID()+'.recovery.tmp');recoveryPath=bundlePath;
    await mkdir(staging,{mode:0o700});await chmod(staging,0o700);
    try{
      await link(target,join(staging,'ledger.sqlite'));await chmod(join(staging,'ledger.sqlite'),0o600);
      await writeFile(join(staging,'config.json'),configurationBytes,{mode:0o600,flag:'wx'});await chmod(join(staging,'config.json'),0o600);
      const keyFingerprint=configuration.tokenEncryptionKey?createHash('sha256').update(String(configuration.tokenEncryptionKey)).digest('hex'):null;
      const manifest={version:1,createdAt:attemptedAt,buildId:typeof BUILD_ID==='string'?BUILD_ID:'unversioned',database:{file:'ledger.sqlite',sha256:await sha256File(target),schemaVersion:Number.isInteger(backupResult.schemaVersion)?backupResult.schemaVersion:null},configuration:{file:'config.json',sha256:createHash('sha256').update(configurationBytes).digest('hex')},encryption:{keyVersion:keyFingerprint?.slice(0,16)||null}};
      await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest)+'\n',{mode:0o600,flag:'wx'});await chmod(join(staging,'manifest.json'),0o600);
      if(typeof faultInjection==='function')await faultInjection('before_bundle_publish');
      await rename(staging,bundlePath);bundlePublished=true;verification=await verifyRecoveryBundle(bundlePath);bundleComplete=true;
    }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
    verifiedSuccessAt = attemptedAt;
    phase = 'retention';
    const entries = await readdir(backupDir, { withFileTypes: true });
    const backupFiles = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.sqlite')) continue;
      const details = await stat(join(backupDir, entry.name));
      if ((details.mode & 0o077) !== 0 || details.uid !== process.getuid()) continue;
      backupFiles.push({ name: entry.name, modifiedAt: details.mtime.toISOString() });
    }
    const retained = retainedBackupNames(backupFiles);
    for (const entry of backupFiles) {
      if (parseDailyBackupName(entry.name) && !retained.has(entry.name)) { await rm(join(backupDir, entry.name)); await rm(join(backupDir,entry.name.replace(/\.sqlite$/,'.recovery')),{recursive:true,force:true}); }
    }
    const status = { state: 'success', recoveryState:'complete', verification:verification?.checks||null, lastAttempt: attemptedAt, lastSuccess: attemptedAt, lastCompleteRecovery:attemptedAt, failureCategory: null, retainedCount: retained.size };
    await saveStatusAt(statusFile, backupDir, status);
    return status;
  } catch (error) {
    if(!bundleComplete){if(backupCreated&&targetPath)await rm(targetPath,{force:true}).catch(()=>{});if(bundlePublished&&recoveryPath)await rm(recoveryPath,{recursive:true,force:true}).catch(()=>{});}
    const status = { state: 'failed', recoveryState:verifiedSuccessAt?'complete':previous.recoveryState||'database_only', verification:verifiedSuccessAt?verification?.checks||null:previous.verification||null, lastAttempt: attemptedAt, lastSuccess: verifiedSuccessAt || previous.lastSuccess || null, lastCompleteRecovery:verifiedSuccessAt||previousCompleteAt, failureCategory: failureCategory(error, phase) };
    try { await saveStatusAt(statusFile, backupDir, status); } catch {}
    throw Object.assign(new Error(`Scheduled backup failed (${status.failureCategory}).`), { cause: error, failureCategory: status.failureCategory });
  }
}

async function saveStatusAt(path, directory, status) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(status), { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const status = await runScheduledBackup();
    console.log(JSON.stringify({ ok: status.state === 'success', state: status.state, lastSuccess: status.lastSuccess, failureCategory: status.failureCategory }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, failureCategory: error.failureCategory || 'unknown' }));
    process.exitCode = 1;
  }
}
