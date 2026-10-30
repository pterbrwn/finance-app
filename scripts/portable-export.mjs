import { chmod, link, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { CATEGORIES } from '../shared/categories.mjs';

const defaultData=join(process.env.XDG_STATE_HOME||join(homedir(),'.local/state'),'ledger');
const source=resolve(process.env.LEDGER_LOCAL_DATA_DIR||defaultData,'ledger.sqlite');
const output=process.env.LEDGER_PORTABLE_EXPORT_FILE;
const MAX_ROWS=500_000,MAX_BYTES=512*1024*1024;
const parse=value=>JSON.parse(value);
function safeItem(json){const {token,cursor,...item}=parse(json);return item;}
export function validatePortableSnapshot(snapshot){
  if(snapshot?.format!=='ledger-portable-finance'||snapshot.version!==1||!Number.isSafeInteger(snapshot.revision)||!snapshot.data)throw new Error('Unsupported portable finance snapshot version or format.');
  if(!Number.isSafeInteger(snapshot.sourceSchemaVersion)||snapshot.sourceSchemaVersion<0)throw new Error('Portable source schema version is invalid.');
  const data=snapshot.data,ids=(rows,label)=>{if(!Array.isArray(rows))throw new Error(`Snapshot ${label} is invalid.`);const set=new Set();for(const row of rows){if(typeof row.id!=='string'||set.has(row.id))throw new Error(`Snapshot ${label} has missing or duplicate IDs.`);set.add(row.id);}return set;};
  const accountIds=ids(data.accounts,'accounts'),itemIds=ids(data.items,'items'),transactionIds=ids(data.transactions,'transactions'),categoryIds=ids(data.categories,'categories'),goalIds=ids(data.goals,'goals');ids(data.holdings,'holdings');
  for(const row of data.transactions){if(row.accountId&&!accountIds.has(row.accountId))throw new Error('Portable transaction references an unavailable account.');if(!Number.isSafeInteger(row.amount))throw new Error('Portable transaction cents are invalid.');}
  for(const row of data.accounts)if(row.itemId&&!itemIds.has(row.itemId))throw new Error('Portable account references an unavailable connection.');
  for(const row of data.holdings)if(row.accountId&&!accountIds.has(row.accountId))throw new Error('Portable holding references an unavailable account.');
  for(const row of data.budgetRecords)if(!categoryIds.has(row.categoryId))throw new Error('Portable budget record references an unavailable category.');
  for(const row of data.goalAllocations)if(!goalIds.has(row.goalId)||!accountIds.has(row.accountId))throw new Error('Portable goal allocation references unavailable records.');
  for(const row of data.statementReconciliations)if(!accountIds.has(row.accountId))throw new Error('Portable statement review references an unavailable account.');
  const splitIds=ids(data.transactionSplits,'transactionSplits'),commitmentIds=ids(data.commitments,'commitments');
  for(const row of data.transactionSplits){if(!transactionIds.has(row.transactionId))throw new Error('Portable split references an unavailable transaction.');const parent=data.transactions.find(item=>item.id===row.transactionId);const sum=row.allocations.reduce((total,item)=>total+item.amount,0);if(parent.amount===row.parentAmount&&sum!==parent.amount)throw new Error('Portable split cents do not match their parent transaction.');}
  for(const row of data.transactionSplitHistory)if(row.transactionId&&!transactionIds.has(row.transactionId))throw new Error('Portable split history references an unavailable transaction.');
  for(const row of data.transactionReimbursements)if(!transactionIds.has(row.transactionId)||!transactionIds.has(row.reimbursesTransactionId))throw new Error('Portable reimbursement references an unavailable transaction.');
  for(const row of data.commitmentMatches)if(!commitmentIds.has(row.commitmentId)||!transactionIds.has(row.transactionId))throw new Error('Portable commitment match references unavailable records.');
  void splitIds;
  for(const collection of ['profiles','categories','budgetRecords','budgetHistory','goals','goalAllocations','properties','mortgages','scenarios','statementReconciliations','transactionSplits','transactionSplitHistory','transactionReimbursements','commitments','commitmentMatches','accountOwnershipBatches'])if(!Array.isArray(data[collection]))throw new Error(`Snapshot ${collection} is invalid.`);
  if(!data.profilePlanState||typeof data.profilePlanState!=='object'||Array.isArray(data.profilePlanState))throw new Error('Snapshot profile planning state is invalid.');
  for(const row of [...data.budgetRecords,...data.budgetHistory])if(row.profileId&&!['peter','maddie','joint'].includes(row.profileId))throw new Error('Portable plan record has an invalid profile.');
  for(const profile of data.profiles)if(!['peter','maddie','joint'].includes(profile.id)||typeof profile.label!=='string')throw new Error('Portable household profile is invalid.');
  for(const collection of ['accounts','transactions','holdings','categories','goals','goalAllocations','properties','mortgages','scenarios','commitments'])for(const row of data[collection])if(row.profileId!==undefined&&row.profileId!==null&&!['peter','maddie','joint'].includes(row.profileId))throw new Error(`Portable ${collection} row has an invalid profile.`);
  for(const id of Object.keys(data.profilePlanState))if(!data.profiles.some(profile=>profile.id===id))throw new Error('Portable plan state references an unavailable profile.');
  for(const row of data.accountOwnershipBatches)for(const key of ['before','after'])if(row[key]!==undefined&&row[key]!==null&&!['peter','maddie','joint'].includes(row[key]))throw new Error('Portable ownership history has an invalid profile.');
  for(const row of data.accountOwnershipBatches)if(row.accountId&&!accountIds.has(row.accountId))throw new Error('Portable ownership history references an unavailable account.');
  if(data.items.some(row=>Object.hasOwn(row,'token')||Object.hasOwn(row,'cursor')))throw new Error('Portable snapshot contains provider secrets.');
  return{valid:true,accounts:accountIds.size,items:itemIds.size,transactions:transactionIds.size,revision:snapshot.revision};
}
export async function buildPortableSnapshot(databasePath=source){
  const db=new Database(databasePath,{readonly:true,fileMustExist:true});db.pragma('query_only = ON');db.exec('BEGIN');
  try{
    const metaRow=db.prepare('SELECT payload_json FROM state_meta WHERE singleton=1').get();const meta=metaRow?parse(metaRow.payload_json):{};
    const bound=db.prepare("SELECT (SELECT COUNT(*) FROM accounts)+(SELECT COUNT(*) FROM items)+(SELECT COUNT(*) FROM transactions)+(SELECT COUNT(*) FROM holdings) AS rows,(SELECT coalesce(SUM(length(payload_json)),0) FROM accounts)+(SELECT coalesce(SUM(length(payload_json)),0) FROM items)+(SELECT coalesce(SUM(length(payload_json)),0) FROM transactions)+(SELECT coalesce(SUM(length(payload_json)),0) FROM holdings) AS bytes").get();
    if(bound.rows>MAX_ROWS||bound.bytes+Buffer.byteLength(metaRow?.payload_json||'')>MAX_BYTES)throw new Error('Portable export exceeds the supported record or byte bound.');
    const rows={items:db.prepare('SELECT payload_json FROM items ORDER BY id').all().map(row=>safeItem(row.payload_json)),accounts:db.prepare('SELECT payload_json FROM accounts ORDER BY id').all().map(row=>parse(row.payload_json)),transactions:db.prepare('SELECT payload_json FROM transactions ORDER BY id').all().map(row=>parse(row.payload_json)),holdings:db.prepare('SELECT payload_json FROM holdings ORDER BY id').all().map(row=>parse(row.payload_json))};
    const count=Object.values(rows).reduce((sum,list)=>sum+list.length,0);if(count>MAX_ROWS)throw new Error('Portable export exceeds the supported record bound.');
    const systemCategories=CATEGORIES.map((name,index)=>({id:'system:'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-'),name,normalizedName:name.toLocaleLowerCase('en-US'),kind:name==='Income'?'income':name==='Transfers'?'transfer':'expense',system:true,order:index,archivedAt:null}));
    const profiles=db.prepare('SELECT id,label,created_at AS createdAt FROM household_profiles ORDER BY id').all(),profilePlanState=Object.fromEntries(db.prepare('SELECT profile_id AS profileId,income_templates_json AS incomeTemplatesJson,monthly_income_json AS monthlyIncomeJson,outlooks_json AS outlooksJson FROM household_plan_state ORDER BY profile_id').all().map(row=>[row.profileId,{incomePlanTemplates:parse(row.incomeTemplatesJson),monthlyIncomePlans:parse(row.monthlyIncomeJson),monthlyBudgetOutlooks:parse(row.outlooksJson)}]));
    const data={...rows,profiles,profilePlanState,categories:[...systemCategories,...(meta.categoryRecords||[])],budgetRecords:db.prepare('SELECT category_id AS categoryId,effective_month AS effectiveMonth,scope,profile_id AS profileId,monthly_cents AS monthlyCents,source_cents AS sourceCents,frequency,due_month AS dueMonth FROM budget_records ORDER BY profile_id,category_id,effective_month,scope').all(),budgetHistory:db.prepare('SELECT history_id AS id,record_type AS recordType,category_id AS categoryId,month,scope,profile_id AS profileId,action,before_json AS beforeJson,after_json AS afterJson,revision,created_at AS createdAt FROM budget_change_history ORDER BY created_at,history_id').all().map(row=>({...row,before:parse(row.beforeJson),after:parse(row.afterJson)})),goals:meta.goals||[],goalAllocations:meta.goalAllocations||[],properties:meta.properties||[],mortgages:meta.mortgages||[],scenarios:meta.scenarios||[],statementReconciliations:meta.statementReconciliations||[],transactionSplits:meta.transactionSplits||[],transactionSplitHistory:meta.transactionSplitHistory||[],transactionReimbursements:meta.transactionReimbursements||[],commitments:meta.commitments||[],commitmentMatches:meta.commitmentMatches||[],goalAllocationLedger:meta.goalAllocationLedger||[],accountOwnershipBatches:meta.accountOwnershipBatches||[],budgetItemSettings:meta.budgetItemSettings||{},balanceSheetSnapshots:meta.balanceSheetSnapshots||[]};
    const snapshot={format:'ledger-portable-finance',version:1,exportedAt:new Date().toISOString(),revision:Number.isSafeInteger(meta.revision)?meta.revision:0,sourceSchemaVersion:db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version||0,data};
    validatePortableSnapshot(snapshot);const serialized=JSON.stringify(snapshot);if(Buffer.byteLength(serialized)>MAX_BYTES)throw new Error('Portable export exceeds the supported size bound.');return serialized;
  }finally{db.exec('ROLLBACK');db.close();}
}
export async function writePortableExport({databasePath=source,destination=output}={}){
  if(!destination)throw new Error('Set LEDGER_PORTABLE_EXPORT_FILE to a new private export path.');const target=resolve(destination),body=await buildPortableSnapshot(databasePath);await mkdir(dirname(target),{recursive:true,mode:0o700});const temporary=join(dirname(target),`.${randomUUID()}.export.tmp`);
  try{await writeFile(temporary,body,{mode:0o600,flag:'wx'});await chmod(temporary,0o600);await link(temporary,target);await rm(temporary,{force:true});return{destination:target,bytes:Buffer.byteLength(body),...validatePortableSnapshot(JSON.parse(body))};}catch(error){await rm(temporary,{force:true});if(error.code==='EEXIST')throw new Error('Portable export already exists; no file was overwritten.');throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===import.meta.filename){try{console.log(JSON.stringify(await writePortableExport()));}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}}
