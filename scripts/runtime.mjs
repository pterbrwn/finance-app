import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalBucket } from './local-storage.mjs';
import { createStateRepository } from '../dist/server/repository.mjs';
import { createSqliteRepositoryAt } from '../dist/server/sqlite-repository.mjs';

export const configPath = resolve(process.env.LEDGER_CONFIG_FILE || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ledger/config.json'));
export const dataDirectory = resolve(process.env.LEDGER_LOCAL_DATA_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'ledger'));
const execFileAsync=promisify(execFile);
const timerStatusCache=new Map(),timerStatusCacheMs=3000;
async function readTimerStatus(unit){
  const cached=timerStatusCache.get(unit);if(cached&&cached.expiresAt>Date.now())return{...cached.status};
  const remember=status=>{timerStatusCache.set(unit,{status,expiresAt:Date.now()+timerStatusCacheMs});return{...status};};
  try{
    const {stdout}=await execFileAsync('systemctl',['--user','show',unit,'--property=UnitFileState,ActiveState,NextElapseUSecRealtime'],{timeout:2000,encoding:'utf8'});
    const properties=Object.fromEntries(stdout.trim().split(/\r?\n/).map(line=>{const index=line.indexOf('=');return index<0?[]:[line.slice(0,index),line.slice(index+1)];}).filter(pair=>pair.length));
    if(!properties.UnitFileState||!properties.ActiveState)throw new Error('timer status incomplete');
    const enabledState=properties.UnitFileState,activeState=properties.ActiveState,nextRun=properties.NextElapseUSecRealtime;
    return remember({state:'available',enabled:['enabled','enabled-runtime','linked'].includes(enabledState),active:activeState==='active',enabledState,activeState,nextRun:nextRun&&nextRun!=='n/a'?nextRun:null,checkedAt:new Date().toISOString()});
  }catch(error){return remember({state:'unavailable',enabled:null,active:null,reason:error.code==='ENOENT'?'systemd user manager is unavailable':'timer status could not be read',checkedAt:new Date().toISOString()});}
}
async function getBackupStatus(storageMode){
  const {state,enabled,active,reason,nextRun}=await readTimerStatus('ledger-backup.timer');
  const timer={state,enabled,active,...(reason?{reason}:{}),nextRun};
  if(storageMode!=='sqlite')return{state:'not_configured',recoveryState:'not_configured',lastAttempt:null,lastSuccess:null,lastCompleteRecovery:null,failureCategory:null,timer,checkedAt:new Date().toISOString()};
  let result={state:'not_run',recoveryState:'database_only',lastAttempt:null,lastSuccess:null,lastCompleteRecovery:null,failureCategory:null,verification:null};
  try{
    const statusPath=join(dataDirectory,'backups/backup-status.json');
    const info=await stat(statusPath);
    if((info.mode&0o077)!==0||info.uid!==process.getuid())throw new Error('private status unavailable');
    const status=JSON.parse(await readFile(statusPath,'utf8'));
    const categories=new Set(['source_unavailable','permission_denied','storage_unavailable','backup_failed','retention_failed']);
    const checks=status.verification||{};const verification={bundleChecksums:checks.bundleChecksums==='verified'?'verified':'unknown',databaseIntegrity:checks.databaseIntegrity==='passed'?'passed':'unknown',tokens:['decrypted','no_tokens'].includes(checks.tokens)?checks.tokens:'unknown',restoreRehearsal:checks.restoreRehearsal==='passed'?'passed':'not_performed'};
    result={state:['success','failed','not_configured'].includes(status.state)?status.state:'unavailable',recoveryState:['complete','database_only','not_configured'].includes(status.recoveryState)?status.recoveryState:'database_only',lastAttempt:typeof status.lastAttempt==='string'?status.lastAttempt:null,lastSuccess:typeof status.lastSuccess==='string'?status.lastSuccess:null,lastCompleteRecovery:typeof status.lastCompleteRecovery==='string'?status.lastCompleteRecovery:null,failureCategory:categories.has(status.failureCategory)?status.failureCategory:null,verification};
  }catch(error){if(error.code!=='ENOENT')result={state:'unavailable',recoveryState:'database_only',lastAttempt:null,lastSuccess:null,lastCompleteRecovery:null,failureCategory:null};}
  const completeAt=typeof result.lastCompleteRecovery==='string'?Date.parse(result.lastCompleteRecovery):NaN,recoveryAgeHours=Number.isFinite(completeAt)?Math.max(0,(Date.now()-completeAt)/3_600_000):null;
  return {...result,recoveryAgeHours,recoveryStale:result.recoveryState!=='complete'||recoveryAgeHours===null||recoveryAgeHours>36,timer,checkedAt:new Date().toISOString()};
}

export async function localRuntime() {
  let config = {};
  try {
    const info = await stat(configPath);
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('Ledger config must belong to this user and have permissions 600.');
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const enabled = config.enablePlaid === true;
  const tailscaleMembers={};
  if(config.tailscaleMembers!==undefined){
    if(!Array.isArray(config.tailscaleMembers)||config.tailscaleMembers.length>20)throw new Error('Tailscale members must be a list of at most 20 configured identities.');
    for(const member of config.tailscaleMembers){
      if(!member||typeof member.login!=='string'||!/^[^\s@]+@[^\s@]+$/.test(member.login)||typeof member.actorId!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(member.actorId))throw new Error('Each Tailscale member needs a login and a stable actor ID.');
      const login=member.login.toLocaleLowerCase('en-US');if(Object.hasOwn(tailscaleMembers,login)||Object.values(tailscaleMembers).includes(member.actorId))throw new Error('Tailscale member logins and actor IDs must be unique.');tailscaleMembers[login]=member.actorId;
    }
  }
  if(config.tailscaleLogin&&!Object.hasOwn(tailscaleMembers,String(config.tailscaleLogin).toLocaleLowerCase('en-US')))tailscaleMembers[String(config.tailscaleLogin).toLocaleLowerCase('en-US')]='local-owner';
  if (config.publicOrigin) {
    const url = new URL(config.publicOrigin);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.origin !== config.publicOrigin || !Object.keys(tailscaleMembers).length) throw new Error('Tailscale access needs an exact HTTPS ts.net origin and at least one configured member.');
  }
  const repository = config.storageMode === 'sqlite'
    ? await createSqliteRepositoryAt(join(dataDirectory, 'ledger.sqlite'))
    : createStateRepository(await createLocalBucket(dataDirectory));
  return {
    publicOrigin: config.publicOrigin,
    tailscaleLogin: config.tailscaleLogin,
    tailscaleMembers,
    HOUSEHOLD_ACTOR_IDS:Object.values(tailscaleMembers),
    REPOSITORY: repository,
    LOCAL_ONLY: !enabled,
    PLAID_ENV: enabled ? config.plaidEnv : undefined,
    PLAID_CLIENT_ID: enabled ? config.plaidClientId : undefined,
    PLAID_SECRET: enabled ? config.plaidSecret : undefined,
    TOKEN_ENCRYPTION_KEY: enabled ? config.tokenEncryptionKey : undefined,
    PLAID_REDIRECT_URI: enabled ? config.plaidRedirectUri : undefined,
    getSyncTimerStatus: () => readTimerStatus('ledger-sync.timer'),
    getBackupStatus: () => getBackupStatus(config.storageMode)
  };
}
