import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import Database from 'better-sqlite3';
import worker from '../worker/index.js';
import { createSqliteRepositoryAt } from '../server/sqlite-repository.mjs';

globalThis.crypto ||= webcrypto;
assert.match(process.version,/^v24\.22\.1$/);
const directory=await mkdtemp(join(tmpdir(),'ledger-operation-benchmark-'));
try{
  const path=join(directory,'bench.sqlite'),repository=await createSqliteRepositoryAt(path);
  await repository.mutate(state=>{state.owner='synthetic-benchmark-owner';state.revision=0;});
  const db=new Database(path),insert=db.prepare('INSERT INTO operation_results(operation_id,scope,payload_digest,response_json,revision,created_at) VALUES(?,?,?,?,?,?)'),lookup=db.prepare('SELECT response_json FROM operation_results WHERE operation_id=?'),digest='a'.repeat(64),insertMany=db.transaction((start,count)=>{for(let index=start;index<start+count;index++){const number=index+1;insert.run(`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`,'manual-account',digest,JSON.stringify({ok:true,revision:number}),number,'2026-10-29T12:00:00.000Z');}});
  const metadataBytes=()=>db.prepare('SELECT length(payload_json) AS bytes FROM state_meta WHERE singleton=1').get().bytes;
  const initialMetadataBytes=metadataBytes(),measure=[];
  for(const target of [10_000,100_000]){
    const before=performance.now(),existing=db.prepare('SELECT COUNT(*) AS count FROM operation_results').get().count;insertMany(existing,target-existing);const insertedAt=performance.now();
    const lookups=1000,queryStart=performance.now();for(let index=0;index<lookups;index++){const number=1+((index*7919)%target),row=lookup.get(`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`);assert.ok(row);}
    measure.push({records:target,insertMs:Number((insertedAt-before).toFixed(1)),lookupCount:lookups,lookupMs:Number((performance.now()-queryStart).toFixed(1)),metadataBytes:metadataBytes()});
  }
  assert.equal(metadataBytes(),initialMetadataBytes,'replay history size does not grow inside state metadata');
  assert.match(db.prepare('EXPLAIN QUERY PLAN SELECT response_json FROM operation_results WHERE operation_id=?').get('synthetic').detail,/PRIMARY KEY|sqlite_autoindex_operation_results/,'lookup uses the indexed operation ID');
  db.close();
  const revision=0,started=performance.now();let imported=0;
  for(let index=0;index<50;index++){
    const day=new Date(Date.UTC(2025,0,1+index)).toISOString().slice(0,10),merchant=`Synthetic replay benchmark ${index}`,csv=`Date,Merchant,Amount,Category\n${day},${merchant},1.00,Groceries`,state=(await repository.read()).state,input={csv,account:'Synthetic benchmark account',columnMapping:{date:'Date',merchant:'Merchant',amount:'Amount',category:'Category'},dateFormat:'YYYY-MM-DD',amountMode:'positive-spending',confirmOverlaps:true,revision:state.revision,clientOperationId:crypto.randomUUID()};
    const response=await worker.fetch(new Request('https://ledger.benchmark.test/api/import',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-benchmark-owner'},body:JSON.stringify(input)}),{REPOSITORY:repository,LOCAL_ONLY:true});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));imported+=result.imported;
  }
  const importMs=Number((performance.now()-started).toFixed(1)),saved=await repository.read(),operationCount=dbCount(path);
  assert.equal(imported,50);assert.equal(saved.state.transactions.filter(row=>row.merchant.startsWith('Synthetic replay benchmark ')).length,50);
  assert.equal(JSON.stringify(saved.state).includes('Synthetic replay benchmark 1'),true,'import rows remain in the ledger itself');
  const storage=new Database(path),meta=storage.prepare('SELECT payload_json FROM state_meta WHERE singleton=1').get().payload_json,storedOperations=storage.prepare('SELECT COUNT(*) AS count FROM operation_results').get().count;
  assert.equal(meta.includes('Synthetic replay benchmark'),false,'raw CSV rows are not copied into state metadata');
  assert.equal(storage.prepare("SELECT COUNT(*) AS count FROM operation_results WHERE response_json LIKE '%Synthetic replay benchmark%' ").get().count,0,'operation results contain no imported merchant or raw CSV');
  assert.equal(storedOperations,100_050);
  console.log(JSON.stringify({operationStorage:measure,repeatedImports:{count:50,importedRows:imported,totalMs:importMs,metadataBytes:Buffer.byteLength(meta),operationCount:storedOperations}},null,2));
  storage.close();await repository.close();
}finally{await rm(directory,{recursive:true,force:true});}

function dbCount(path){const database=new Database(path,{readonly:true,fileMustExist:true});const count=database.prepare('SELECT COUNT(*) AS count FROM operation_results').get().count;database.close();return count;}
