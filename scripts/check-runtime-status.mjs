import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory=await mkdtemp(join(tmpdir(),'ledger-runtime-status-'));
await chmod(directory,0o700);
const configPath=join(directory,'config.json'),dataDirectory=join(directory,'state'),bin=join(directory,'bin');
await mkdir(bin,{mode:0o700});
await writeFile(configPath,JSON.stringify({storageMode:'sqlite',enablePlaid:false}),{mode:0o600});
const systemctl=join(bin,'systemctl');
await writeFile(systemctl,`#!/bin/sh
case "$3" in
  ledger-sync.timer) printf 'ActiveState=inactive\\nNextElapseUSecRealtime=n/a\\nUnitFileState=disabled\\n' ;;
  ledger-backup.timer) printf 'ActiveState=active\\nNextElapseUSecRealtime=Mon 2026-10-26 03:00:00 CDT\\nUnitFileState=enabled\\n' ;;
  *) exit 1 ;;
esac
`,{mode:0o700});await chmod(systemctl,0o700);
const previous={PATH:process.env.PATH,LEDGER_CONFIG_FILE:process.env.LEDGER_CONFIG_FILE,LEDGER_LOCAL_DATA_DIR:process.env.LEDGER_LOCAL_DATA_DIR};
process.env.PATH=`${bin}:${previous.PATH||''}`;process.env.LEDGER_CONFIG_FILE=configPath;process.env.LEDGER_LOCAL_DATA_DIR=dataDirectory;
let repository;
try{
 const {localRuntime}=await import('../scripts/runtime.mjs?runtime-status-test');
 const env=await localRuntime();repository=env.REPOSITORY;
 const sync=await env.getSyncTimerStatus(),backup=await env.getBackupStatus(),syncCached=await env.getSyncTimerStatus();
 assert.equal(syncCached.checkedAt,sync.checkedAt,'timer state is briefly cached and keeps its original checked-at time');
 assert.equal(backup.recoveryStale,true,'missing complete recovery evidence is reported as stale');assert.equal(backup.recoveryState,'database_only');
 assert.equal(sync.state,'available');assert.equal(sync.enabled,false);assert.equal(sync.active,false);assert.equal(sync.nextRun,null);
 assert.equal(backup.state,'not_run');assert.equal(backup.timer.state,'available');assert.equal(backup.timer.enabled,true);assert.equal(backup.timer.active,true);assert.equal(backup.timer.nextRun,'Mon 2026-10-26 03:00:00 CDT');
 console.log('Systemd timer status parsing passed for reordered property output.');
}finally{
 await repository?.close();
 for(const [name,value] of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
 await rm(directory,{recursive:true,force:true});
}
