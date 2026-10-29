import { chmod, link, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { verifyRecoveryBundle } from './recovery-bundle.mjs';

function childExit(child,label){return new Promise((resolvePromise,reject)=>{child.once('error',error=>reject(new Error(`${label} could not start: ${error.code||'spawn error'}`)));child.once('close',code=>code===0?resolvePromise():reject(new Error(`${label} failed (${code})`)));});}

export async function exportEncryptedRecovery({bundlePath=process.env.LEDGER_RECOVERY_BUNDLE,destinationDirectory=process.env.LEDGER_ENCRYPTED_BACKUP_DIR,recipient=process.env.LEDGER_AGE_RECIPIENT}={}){
  if(!bundlePath||!destinationDirectory||!recipient)throw new Error('Set LEDGER_RECOVERY_BUNDLE, LEDGER_ENCRYPTED_BACKUP_DIR, and LEDGER_AGE_RECIPIENT in the trusted operator environment.');
  const source=resolve(bundlePath),destination=resolve(destinationDirectory);if(destination===source||destination.startsWith(source+ '/'))throw new Error('Encrypted destination must be outside the source recovery bundle.');
  await verifyRecoveryBundle(source);await mkdir(destination,{recursive:true,mode:0o700});const destinationInfo=await stat(destination);if(!destinationInfo.isDirectory()||(destinationInfo.mode&0o077)!==0||destinationInfo.uid!==process.getuid())throw new Error('Encrypted backup destination must be a private directory owned by the current user.');
  const now=new Date().toISOString().replaceAll(':','-'),name=`ledger-recovery-${now}.tar.age`,target=join(destination,name),temporary=join(destination,`.${randomUUID()}.age.tmp`);
  const tar=spawn('tar',['-C',source,'-cf','-','.'],{stdio:['ignore','pipe','pipe']});const age=spawn('age',['-r',recipient],{stdio:['pipe','pipe','pipe']});let diagnostic='';for(const child of [tar,age])child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-3000);});
  try{const tarExit=childExit(tar,'tar export'),ageExit=childExit(age,'age encryption');await Promise.all([pipeline(tar.stdout,age.stdin),pipeline(age.stdout,createWriteStream(temporary,{flags:'wx',mode:0o600})),tarExit,ageExit]);await chmod(temporary,0o600);await link(temporary,target);await rm(temporary,{force:true});const verification=await verifyRecoveryBundle(source);return{destination:target,bytes:(await stat(target)).size,checks:{...verification.checks,encryption:'age recipient encryption'}};}catch(error){tar.kill();age.kill();await rm(temporary,{force:true});if(error.code==='EEXIST')throw new Error('Encrypted backup destination already exists; no file was overwritten.');throw new Error(`${error.message}${diagnostic?`: ${diagnostic.trim()}`:''}`);}
}

export async function restoreRehearsal({encryptedPath=process.env.LEDGER_ENCRYPTED_RECOVERY_FILE,identity=process.env.LEDGER_AGE_IDENTITY,destination=process.env.LEDGER_RESTORE_REHEARSAL_DIR}={}){
  if(!encryptedPath||!identity||!destination)throw new Error('Set LEDGER_ENCRYPTED_RECOVERY_FILE, LEDGER_AGE_IDENTITY, and LEDGER_RESTORE_REHEARSAL_DIR in the trusted operator environment.');
  const encrypted=resolve(encryptedPath),target=resolve(destination),identityPath=resolve(identity),identityInfo=await stat(identityPath);if((identityInfo.mode&0o077)!==0||identityInfo.uid!==process.getuid())throw new Error('Age identity file must be private.');try{await stat(target);throw new Error('Restore rehearsal destination already exists; use a fresh directory.');}catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(dirname(target),{recursive:true,mode:0o700});const temporary=await mkdtemp(join(dirname(target),'.ledger-restore-'));await chmod(temporary,0o700);
  let diagnostic='';try{const age=spawn('age',['-d','-i',resolve(identity),encrypted],{stdio:['ignore','pipe','pipe']}),tar=spawn('tar',['-C',temporary,'-xf','-'],{stdio:['pipe','ignore','pipe']});for(const child of [age,tar])child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-3000);});const ageExit=childExit(age,'age decryption'),tarExit=childExit(tar,'archive extraction');await Promise.all([pipeline(age.stdout,tar.stdin),ageExit,tarExit]);const verification=await verifyRecoveryBundle(temporary);const fs=await import('node:fs/promises');await fs.rename(temporary,target);return{destination:target,rehearsal:'passed',checks:{...verification.checks,restoreRehearsal:'passed'}};}catch(error){await rm(temporary,{recursive:true,force:true});throw new Error(`${error.message}${diagnostic?`: ${diagnostic.trim()}`:''}${error.code==='ENOSPC'?' (destination is out of space)':''}`);}
}

if(process.argv[1]&&resolve(process.argv[1])===import.meta.filename){try{const result=process.argv[2]==='restore-rehearsal'?await restoreRehearsal():await exportEncryptedRecovery();console.log(JSON.stringify(result));}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}}
