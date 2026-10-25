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
async function getSyncTimerStatus(){
  try{
    const {stdout}=await execFileAsync('systemctl',['--user','show','ledger-sync.timer','--property=UnitFileState,ActiveState,NextElapseUSecRealtime','--value'],{timeout:2000,encoding:'utf8'});
    const [enabledState,activeState,nextRun]=stdout.trim().split('\n');
    return{state:'available',enabled:['enabled','enabled-runtime','linked'].includes(enabledState),active:activeState==='active',enabledState:enabledState||'unknown',activeState:activeState||'unknown',nextRun:nextRun&&nextRun!=='n/a'?nextRun:null,checkedAt:new Date().toISOString()};
  }catch(error){return{state:'unavailable',enabled:null,active:null,reason:error.code==='ENOENT'?'systemd user manager is unavailable':'systemd timer status could not be read',checkedAt:new Date().toISOString()};}
}
async function getBackupStatus(storageMode){
  let timer;
  try{
    const {stdout}=await execFileAsync('systemctl',['--user','show','ledger-backup.timer','--property=UnitFileState,ActiveState,NextElapseUSecRealtime','--value'],{timeout:2000,encoding:'utf8'});
    const [enabledState,activeState,nextRun]=stdout.trim().split('\n');
    timer={state:'available',enabled:['enabled','enabled-runtime','linked'].includes(enabledState),active:activeState==='active',nextRun:nextRun&&nextRun!=='n/a'?nextRun:null};
  }catch(error){timer={state:'unavailable',enabled:null,active:null,reason:error.code==='ENOENT'?'systemd user manager is unavailable':'backup timer status could not be read'};}
  if(storageMode!=='sqlite')return{state:'not_configured',lastAttempt:null,lastSuccess:null,failureCategory:null,timer,checkedAt:new Date().toISOString()};
  let result={state:'not_run',lastAttempt:null,lastSuccess:null,failureCategory:null};
  try{
    const statusPath=join(dataDirectory,'backups/backup-status.json');
    const info=await stat(statusPath);
    if((info.mode&0o077)!==0||info.uid!==process.getuid())throw new Error('private status unavailable');
    const status=JSON.parse(await readFile(statusPath,'utf8'));
    const categories=new Set(['source_unavailable','permission_denied','storage_unavailable','backup_failed','retention_failed']);
    result={state:['success','failed','not_configured'].includes(status.state)?status.state:'unavailable',lastAttempt:typeof status.lastAttempt==='string'?status.lastAttempt:null,lastSuccess:typeof status.lastSuccess==='string'?status.lastSuccess:null,failureCategory:categories.has(status.failureCategory)?status.failureCategory:null};
  }catch(error){if(error.code!=='ENOENT')result={state:'unavailable',lastAttempt:null,lastSuccess:null,failureCategory:null};}
  return {...result,timer,checkedAt:new Date().toISOString()};
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
  if (config.publicOrigin) {
    const url = new URL(config.publicOrigin);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.origin !== config.publicOrigin || !config.tailscaleLogin) throw new Error('Tailscale access needs an exact HTTPS ts.net origin and an owner login.');
  }
  const repository = config.storageMode === 'sqlite'
    ? await createSqliteRepositoryAt(join(dataDirectory, 'ledger.sqlite'))
    : createStateRepository(await createLocalBucket(dataDirectory));
  return {
    publicOrigin: config.publicOrigin,
    tailscaleLogin: config.tailscaleLogin,
    REPOSITORY: repository,
    LOCAL_ONLY: !enabled,
    PLAID_ENV: enabled ? config.plaidEnv : undefined,
    PLAID_CLIENT_ID: enabled ? config.plaidClientId : undefined,
    PLAID_SECRET: enabled ? config.plaidSecret : undefined,
    TOKEN_ENCRYPTION_KEY: enabled ? config.tokenEncryptionKey : undefined,
    PLAID_REDIRECT_URI: enabled ? config.plaidRedirectUri : undefined,
    getSyncTimerStatus,
    getBackupStatus: () => getBackupStatus(config.storageMode)
  };
}
