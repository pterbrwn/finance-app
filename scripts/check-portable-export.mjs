import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildPortableSnapshot, validatePortableSnapshot, writePortableExport } from './portable-export.mjs';
const root=await mkdtemp(join(tmpdir(),'ledger-portable-')),dbPath=join(root,'ledger.sqlite'),destination=join(root,'out','finance.json');
try{
 const db=new Database(dbPath);for(const [version,file] of ['001-initial.sql','002-monthly-budgets.sql','003-transaction-query-indexes.sql','004-budget-analytics-index.sql','005-operation-results.sql','006-budget-records.sql','007-budget-history.sql'].entries()){db.exec(await readFile(new URL(`../server/migrations/${file}`,import.meta.url),'utf8'));db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(version+1,new Date().toISOString());}
 const meta={revision:12,owner:'private-owner',tokenEncryptionKey:'SENTINEL_KEY',categoryRecords:[{id:'cat:food',name:'Food',kind:'expense'}],goals:[{id:'goal-1',name:'Emergency'}],goalAllocations:[{id:'allocation-1',goalId:'goal-1',accountId:'account-1',amount:500}],properties:[],mortgages:[],scenarios:[],statementReconciliations:[]};
 db.prepare('INSERT INTO state_meta(singleton,payload_json) VALUES(1,?)').run(JSON.stringify(meta));
 db.prepare('INSERT INTO items(id,payload_json) VALUES(?,?)').run('item-1',JSON.stringify({id:'item-1',name:'Synthetic bank',token:{iv:'SENTINEL_SECRET',data:'SENTINEL_SECRET'},cursor:'SENTINEL_SECRET'}));
 db.prepare('INSERT INTO accounts(id,item_id,payload_json) VALUES(?,?,?)').run('account-1','item-1',JSON.stringify({id:'account-1',itemId:'item-1',type:'depository',balance:120000,currency:'USD'}));
 db.prepare('INSERT INTO transactions(id,account_id,item_id,payload_json) VALUES(?,?,?,?)').run('transaction-1','account-1','item-1',JSON.stringify({id:'transaction-1',accountId:'account-1',itemId:'item-1',date:'2026-10-01',amount:1234,currency:'USD'}));
 db.prepare('INSERT INTO budget_records(category_id,effective_month,scope,monthly_cents,source_cents,frequency,due_month) VALUES(?,?,?,?,?,?,?)').run('cat:food','2026-10','recurring',12345,12345,'monthly',null);db.close();
 const serialized=await buildPortableSnapshot(dbPath),snapshot=JSON.parse(serialized);assert.equal(snapshot.revision,12);assert.equal(snapshot.data.transactions[0].amount,1234);assert.equal(snapshot.data.budgetRecords[0].monthlyCents,12345);assert.equal(snapshot.data.items[0].token,undefined);assert.equal(serialized.includes('SENTINEL'),false);assert.deepEqual(validatePortableSnapshot(snapshot),{valid:true,accounts:1,items:1,transactions:1,revision:12});
 assert.throws(()=>validatePortableSnapshot({...snapshot,version:99}),/Unsupported portable/);assert.throws(()=>validatePortableSnapshot({...snapshot,data:{...snapshot.data,transactions:[{...snapshot.data.transactions[0],accountId:'missing'}]}}),/unavailable account/);
 const written=await writePortableExport({databasePath:dbPath,destination});assert.equal(written.transactions,1);assert.equal((await stat(destination)).mode&0o777,0o600);await assert.rejects(writePortableExport({databasePath:dbPath,destination}),/already exists/);
 console.log('Portable export consistency, IDs, cents, references, secret exclusion, bounds validation, and no-overwrite checks passed.');
}finally{await rm(root,{recursive:true,force:true});}
