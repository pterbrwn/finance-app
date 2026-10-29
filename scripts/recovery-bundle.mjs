import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDecipheriv } from 'node:crypto';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

export async function sha256File(path){
  const hash=createHash('sha256');
  await new Promise((resolvePromise,reject)=>{const stream=createReadStream(path);stream.on('data',chunk=>hash.update(chunk));stream.once('error',reject);stream.once('end',resolvePromise);});
  return hash.digest('hex');
}

async function privateFile(path){
  const info=await stat(path);
  if((info.mode&0o077)!==0||info.uid!==process.getuid())throw Object.assign(new Error('Recovery file is not private.'),{code:'EACCES'});
  return{info,bytes:await readFile(path)};
}

export async function verifyRecoveryBundle(bundlePath){
  const root=resolve(bundlePath),directory=await stat(root);
  if(!directory.isDirectory()||(directory.mode&0o077)!==0||directory.uid!==process.getuid())throw Object.assign(new Error('Recovery bundle is not private.'),{code:'EACCES'});
  const [manifestFile,configurationFile]=await Promise.all([privateFile(join(root,'manifest.json')),privateFile(join(root,'config.json'))]);
  const manifest=JSON.parse(manifestFile.bytes.toString('utf8')),configuration=JSON.parse(configurationFile.bytes.toString('utf8'));
  if(manifest?.version!==1||manifest.database?.file!=='ledger.sqlite'||typeof manifest.database.sha256!=='string'||!/^[a-f0-9]{64}$/.test(manifest.database.sha256)||typeof manifest.configuration?.sha256!=='string'||!/^[a-f0-9]{64}$/.test(manifest.configuration.sha256))throw new Error('Recovery manifest is invalid.');
  const databasePath=join(root,'ledger.sqlite');
  const database=await stat(databasePath);
  if((database.mode&0o077)!==0||database.uid!==process.getuid())throw Object.assign(new Error('Recovery database is not private.'),{code:'EACCES'});
  const configurationHash=createHash('sha256').update(configurationFile.bytes).digest('hex');
  if(configurationHash!==manifest.configuration.sha256||await sha256File(databasePath)!==manifest.database.sha256)throw new Error('Recovery bundle checksum validation failed.');
  const keyFingerprint=configuration.tokenEncryptionKey?createHash('sha256').update(String(configuration.tokenEncryptionKey)).digest('hex'):null;
  if((keyFingerprint?.slice(0,16)||null)!==(manifest.encryption?.keyVersion||null))throw new Error('Recovery encryption key does not match its manifest.');
  const db=new Database(databasePath,{readonly:true,fileMustExist:true});let databaseIntegrity='failed',tokenStatus='no_tokens';
  try{
    const integrity=db.pragma('integrity_check',{simple:true});if(integrity!=='ok')throw new Error('Recovery database integrity check failed.');databaseIntegrity='passed';
    const rows=db.prepare("SELECT payload_json FROM items WHERE payload_json LIKE '%\"token\"%'").all();
    const tokens=rows.map(row=>JSON.parse(row.payload_json).token).filter(Boolean);
    if(tokens.length){
      const key=Buffer.from(String(configuration.tokenEncryptionKey||''),'base64');if(key.length!==32)throw new Error('Recovery bundle token key is unavailable or invalid.');
      for(const token of tokens){const iv=Buffer.from(token.iv,'base64'),data=Buffer.from(token.data,'base64');if(iv.length!==12||data.length<16)throw new Error('Stored token could not be decrypted.');const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(data.subarray(data.length-16));decipher.update(data.subarray(0,data.length-16));decipher.final();}
      tokenStatus='decrypted';
    }
  }finally{db.close();}
  return{manifest,configuration,databasePath,checks:{bundleChecksums:'verified',databaseIntegrity,tokens:tokenStatus,restoreRehearsal:'not-performed'}};
}
