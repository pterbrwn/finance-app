import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, symlink, readlink } from 'node:fs/promises';
import { createServer } from 'node:net';

const releaseRoot=resolve(process.argv[2]||'');
const runtime=process.env.LEDGER_NODE_BIN||process.execPath;
if(!process.argv[2])throw new Error('Usage: node scripts/check-release.mjs IMMUTABLE_RELEASE_DIRECTORY');
assert.equal(spawnSync(runtime,['--version'],{encoding:'utf8'}).stdout.trim(),'v24.22.1','release checks require pinned Node.js 24.22.1');
const release=JSON.parse(await readFile(join(releaseRoot,'release.json'),'utf8'));
assert.equal(release.nodeVersion,'24.22.1');
const manifest=(await readFile(join(releaseRoot,'manifest.sha256'),'utf8')).trim().split('\n');
for(const line of manifest){
  const match=line.match(/^([a-f0-9]{64})  (.+)$/);assert.ok(match,`invalid release manifest line: ${line}`);
  const bytes=await readFile(join(releaseRoot,match[2]));assert.equal(createHash('sha256').update(bytes).digest('hex'),match[1],`release checksum mismatch: ${match[2]}`);
}
const directory=await mkdtemp(join(tmpdir(),'ledger-release-check-'));
await (await import('node:fs/promises')).chmod(directory,0o700);
let server;
try{
  const configPath=join(directory,'private-config.json'),dataDirectory=join(directory,'data');
  await writeFile(configPath,JSON.stringify({storageMode:'sqlite',enablePlaid:false}),{mode:0o600});
  await (await import('node:fs/promises')).mkdir(dataDirectory,{mode:0o700});
  const sourcePath=join(directory,'legacy.json'),databasePath=join(dataDirectory,'ledger.sqlite');
  await writeFile(sourcePath,JSON.stringify({version:1,owner:'local-owner',items:[],accounts:[],transactions:[{id:'release-fixture',date:'2026-10-01',merchant:'Synthetic release fixture',amount:125,currency:'USD'}],holdings:[],customCategories:[],budgets:{}}),{mode:0o600});
  const run=(script,args)=>{
    const result=spawnSync(runtime,[join(releaseRoot,'scripts',script),...args],{cwd:directory,encoding:'utf8',env:{...process.env,LEDGER_NODE_BIN:runtime,LEDGER_CONFIG_FILE:configPath,LEDGER_LOCAL_DATA_DIR:dataDirectory}});
    assert.equal(result.status,0,`${script} failed: ${result.stderr||result.stdout}`);return result.stdout.trim();
  };
  const imported=JSON.parse(run('import-legacy-json.mjs',[sourcePath,databasePath,configPath]));assert.equal(imported.imported,true);assert.equal(imported.schemaVersion,release.schemaVersion);
  const currentLike=join(directory,'service-current');await symlink(releaseRoot,currentLike,'dir');
  const backupViaService=spawnSync(join(currentLike,'scripts/start-backup.sh'),[],{cwd:directory,encoding:'utf8',env:{...process.env,LEDGER_NODE_BIN:runtime,LEDGER_CONFIG_FILE:configPath,LEDGER_LOCAL_DATA_DIR:dataDirectory}});
  assert.equal(backupViaService.status,0,`packaged backup service wrapper failed: ${backupViaService.stderr||backupViaService.stdout}`);
  const backupStatus=JSON.parse(await readFile(join(dataDirectory,'backups/backup-status.json'),'utf8'));
  assert.equal(backupStatus.state,'success','packaged backup service wrapper publishes a verified status when invoked through the current symlink');
  const scheduledBackups=(await readdir(join(dataDirectory,'backups'))).filter(name=>/^daily-.*\.sqlite$/.test(name));
  assert.equal(scheduledBackups.length,1,'packaged backup service wrapper creates its daily SQLite backup');
  const scheduledBackupInfo=await stat(join(dataDirectory,'backups',scheduledBackups[0]));assert.equal(scheduledBackupInfo.mode&0o077,0);assert.ok(scheduledBackupInfo.size>0);
  const backupPath=join(directory,'backup.sqlite'),restoredPath=join(directory,'restored.sqlite');
  const backup=JSON.parse(run('sqlite-backup.mjs',[databasePath,backupPath]));assert.equal(backup.schemaVersion,release.schemaVersion);
  run('sqlite-restore.mjs',[backupPath,restoredPath]);
  const serverFile=join(releaseRoot,'scripts/start-ledger.sh');
  const portProbe=createServer();await new Promise((resolve,reject)=>portProbe.once('error',reject).listen(0,'127.0.0.1',resolve));const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
  server=spawn(serverFile,{cwd:directory,env:{...process.env,LEDGER_NODE_BIN:runtime,LEDGER_CONFIG_FILE:configPath,LEDGER_LOCAL_DATA_DIR:dataDirectory,PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let logs='';server.stdout.on('data',chunk=>logs+=chunk);server.stderr.on('data',chunk=>logs+=chunk);
  let health;
  for(let attempt=0;attempt<80;attempt++){
    if(server.exitCode!==null)throw new Error(`packaged server exited early: ${logs}`);
    try{const response=await fetch(`http://127.0.0.1:${port}/api/health`);if(response.ok)health=await response.json();}catch{}
    if(health)break;await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(health,`packaged server did not become healthy: ${logs}`);
  assert.equal(health.codeVersion,release.buildId);assert.equal(health.schemaVersion,release.schemaVersion);
  const stateResponse=await fetch(`http://127.0.0.1:${port}/api/state`);assert.equal(stateResponse.status,200);assert.equal((await stateResponse.json()).transactionCount,1,'packaged server opens the migrated synthetic data');
  const asset=await fetch(`http://127.0.0.1:${port}/assets/app.js`);assert.equal(asset.status,200);assert.ok(Number(asset.headers.get('content-length')||'0')>0|| (await asset.text()).length>1000);
  const releaseHub=join(directory,'releases'),oldRelease=join(releaseHub,'prior-compatible'),currentLink=join(directory,'current'),mockSystemctl=join(directory,'systemctl-stub');
  await mkdir(releaseHub,{mode:0o700});await mkdir(oldRelease,{mode:0o700});
  await writeFile(join(oldRelease,'release.json'),JSON.stringify({...release,buildId:'prior-compatible'}),{mode:0o600});
  await symlink(join(releaseRoot,'node_modules'),join(oldRelease,'node_modules'),'dir');
  await symlink(releaseRoot,join(releaseHub,release.buildId),'dir');await symlink(oldRelease,currentLink,'dir');
  await writeFile(mockSystemctl,'#!/bin/sh\nexit 0\n',{mode:0o700});await chmod(mockSystemctl,0o700);
  const activation=spawnSync(join(import.meta.dirname,'activate-release.sh'),[release.buildId],{cwd:directory,encoding:'utf8',env:{...process.env,LEDGER_NODE_BIN:runtime,LEDGER_RELEASE_ROOT:releaseHub,LEDGER_CURRENT_LINK:currentLink,LEDGER_LOCAL_DATA_DIR:dataDirectory,LEDGER_HEALTH_URL:'http://127.0.0.1:1',LEDGER_HEALTH_ATTEMPTS:'1',LEDGER_HEALTH_INTERVAL_SECONDS:'0',LEDGER_SYSTEMCTL_BIN:mockSystemctl}});
  assert.equal(activation.status,1,activation.stdout);assert.equal(await readlink(currentLink),oldRelease,'failed health validation restores compatible prior code');
  const incompatibleRelease=join(releaseHub,'prior-incompatible');await mkdir(incompatibleRelease,{mode:0o700});
  await writeFile(join(incompatibleRelease,'release.json'),JSON.stringify({...release,buildId:'prior-incompatible',maximumSchemaVersion:Math.max(0,release.schemaVersion-1)}),{mode:0o600});
  await symlink(join(releaseRoot,'node_modules'),join(incompatibleRelease,'node_modules'),'dir');
  await (await import('node:fs/promises')).unlink(currentLink);await symlink(incompatibleRelease,currentLink,'dir');
  const refusedDowngrade=spawnSync(join(import.meta.dirname,'activate-release.sh'),[release.buildId],{cwd:directory,encoding:'utf8',env:{...process.env,LEDGER_NODE_BIN:runtime,LEDGER_RELEASE_ROOT:releaseHub,LEDGER_CURRENT_LINK:currentLink,LEDGER_LOCAL_DATA_DIR:dataDirectory,LEDGER_HEALTH_URL:'http://127.0.0.1:1',LEDGER_HEALTH_ATTEMPTS:'1',LEDGER_HEALTH_INTERVAL_SECONDS:'0',LEDGER_SYSTEMCTL_BIN:mockSystemctl}});
  assert.equal(refusedDowngrade.status,1);assert.match(refusedDowngrade.stderr,/current schema/);assert.equal(await readlink(currentLink),join(releaseHub,release.buildId),'an incompatible downgrade is not selected');await stat(databasePath);
  server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));server=null;
  console.log(`Immutable package ${release.buildId}: checksums, importer, backup, restore, server health, schema identity, static asset, compatible rollback, and incompatible-downgrade refusal passed.`);
}finally{
  if(server){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve)).catch(()=>{});}
  await rm(directory,{recursive:true,force:true});
}
