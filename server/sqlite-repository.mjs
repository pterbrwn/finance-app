import Database from 'better-sqlite3';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { budgetRecordProjections, budgetRecordProjectionsForProfile, budgetRecordsFromProjections, normalizeBudgetRecord } from '../shared/budget-records.mjs';
import { applyTransactionSplitsToRows } from '../shared/transaction-splits.mjs';
import { addSafeCents } from '../shared/reporting.mjs';

const MIGRATION_VERSION = 9;
const TABLES = ['items', 'accounts', 'transactions', 'holdings'];
const MIGRATIONS = [
  { version: 1, file: '001-initial.sql' },
  { version: 2, file: '002-monthly-budgets.sql' },
  { version: 3, file: '003-transaction-query-indexes.sql' },
  { version: 4, file: '004-budget-analytics-index.sql' },
  { version: 5, file: '005-operation-results.sql' },
  { version: 6, file: '006-budget-records.sql' },
  { version: 7, file: '007-budget-history.sql' },
  { version: 8, file: '008-household-profiles.sql' },
  { version: 9, file: '009-profile-custom-categories.sql' }
];
const CORE_TABLES = ['schema_migrations','state_meta','items','accounts','transactions','holdings','custom_categories','budgets','import_batches','household_profiles','household_plan_state'];
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('State must be an object.');
  for (const name of TABLES) {
    if (!Array.isArray(state[name] ?? [])) throw new TypeError(`State ${name} must be a list.`);
    const ids = new Set();
    for (const [index, row] of (state[name] ?? []).entries()) {
      const id = row?.id ?? (name === 'holdings' ? `legacy-holding-${index}` : null);
      if (typeof id !== 'string' || !id || ids.has(id)) throw new Error(`Invalid or duplicate ${name} identity.`);
      ids.add(id);
    }
  }
  if (!state.budgets || Array.isArray(state.budgets) || typeof state.budgets !== 'object') throw new TypeError('State budgets must be an object.');
  for (const amount of Object.values(state.budgets)) if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid budget amount.');
  if (!Array.isArray(state.customCategories ?? [])) throw new TypeError('State customCategories must be a list.');
  const templates=state.budgetTemplates??[];
  if(!Array.isArray(templates))throw new TypeError('State budgetTemplates must be a list.');
  const templateKeys=new Set();
  for(const row of templates){
    if(!row||typeof row.categoryId!=='string'||!row.categoryId||!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.effectiveFrom)||row.amount!==null&&(!Number.isSafeInteger(row.amount)||row.amount<0))throw new Error('Invalid budget template.');
    const key=`${row.categoryId}:${row.effectiveFrom}`;if(templateKeys.has(key))throw new Error('Duplicate budget template.');templateKeys.add(key);
  }
  const monthly=state.monthlyBudgets??{};
  if(!monthly||Array.isArray(monthly)||typeof monthly!=='object')throw new TypeError('State monthlyBudgets must be an object.');
  for(const [key,amount] of Object.entries(monthly)){const month=key.slice(0,7),categoryId=key.slice(8);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!categoryId||amount!==null&&(!Number.isSafeInteger(amount)||amount<0))throw new Error('Invalid monthly budget override.');}
  if(state.budgetHistoryUnavailableBefore!==undefined&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(state.budgetHistoryUnavailableBefore))throw new Error('Invalid budget history boundary.');
}

export async function openLedgerDatabase(path) {
  process.umask(0o077);
  const filename = resolve(path);
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  await chmod(dirname(filename), 0o700);
  let existed=false;
  try { existed=(await stat(filename)).size>0; } catch(error) { if(error.code!=='ENOENT')throw error; }
  const db = new Database(filename, { timeout: 5000 });
  try {
    const hasMigrations=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    const tableNames=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>row.name));
    let currentVersion=0;
    if(hasMigrations){
      const versions=db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row=>row.version);
      if(versions.some(version=>Number.isSafeInteger(version)&&version>MIGRATION_VERSION))throw new Error('Database schema is newer than this application supports; no changes were made.');
      if(!versions.length||versions.some((version,index)=>!Number.isSafeInteger(version)||version!==index+1))throw new Error('Database migration history is inconsistent; no changes were made.');
      currentVersion=versions.at(-1);
    }else if(tableNames.size){
      throw new Error('Database contains tables without migration history; no changes were made.');
    }
    if(currentVersion>0){
      const expectedTables=new Set([...CORE_TABLES.filter(name=>!['household_profiles','household_plan_state'].includes(name)||currentVersion>=8),...(currentVersion>=2?['budget_templates','monthly_budgets']:[]),...(currentVersion>=5?['operation_results']:[]),...(currentVersion>=6?['budget_records']:[]),...(currentVersion>=7?['budget_change_history']:[])]);
      if([...expectedTables].some(name=>!tableNames.has(name))||[...tableNames].some(name=>!expectedTables.has(name)))throw new Error('Database tables do not match the recorded migration history; no changes were made.');
    }
    await chmod(filename, 0o600);
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.function('ledger_casefold',{deterministic:true},value=>String(value??'').toLocaleLowerCase('en-US'));
    if(existed&&currentVersion<MIGRATION_VERSION){
      const backupDirectory=join(dirname(filename),'backups');
      await mkdir(backupDirectory,{recursive:true,mode:0o700});await chmod(backupDirectory,0o700);
      const stamp=new Date().toISOString().replaceAll(':','-'),backupPath=join(backupDirectory,`pre-migration-${currentVersion}-to-${MIGRATION_VERSION}-${stamp}.sqlite`),temporary=`${backupPath}.tmp-${randomUUID()}`;
      let check;
      try{
        await db.backup(temporary);
        check=new Database(temporary,{readonly:true,fileMustExist:true});
        if(check.pragma('integrity_check',{simple:true})!=='ok'||check.pragma('foreign_key_check').length)throw new Error('Pre-migration backup failed integrity verification.');
        check.close();check=null;await chmod(temporary,0o600);await rename(temporary,backupPath);
      }catch(error){check?.close();await rm(temporary,{force:true});throw new Error('Could not create a verified pre-migration backup; migration stopped.');}
    }
    const migrateLegacyProfiles=()=>{
      for(const table of TABLES){
        const rows=db.prepare(`SELECT rowid,payload_json FROM ${table}`).all(),update=db.prepare(`UPDATE ${table} SET payload_json=? WHERE rowid=?`);
        for(const row of rows){const value=JSON.parse(row.payload_json);if(table==='accounts'&&value.profileId===undefined)value.profileId='peter';update.run(JSON.stringify(value),row.rowid);}
      }
      const row=db.prepare('SELECT payload_json FROM state_meta WHERE singleton=1').get();
      if(row){
        const state=JSON.parse(row.payload_json);
        for(const key of ['goals','properties','mortgages','scenarios','commitments','categoryRecords','mortgageSnapshots'])if(Array.isArray(state[key]))for(const value of state[key])if(value&&typeof value==='object'&&value.profileId===undefined)value.profileId='peter';
        state.householdProfiles=[{id:'peter',label:'Peter'},{id:'maddie',label:'Maddie'},{id:'joint',label:'Joint'}];state.ownershipReviewRequired=true;state.legacyPlanProfileId='peter';state.householdProfileMigrationComplete=true;
        db.prepare("UPDATE household_plan_state SET income_templates_json=?,monthly_income_json=?,outlooks_json=?,updated_at=? WHERE profile_id='peter'").run(json(state.incomePlanTemplates||[]),json(state.monthlyIncomePlans||{}),json(state.monthlyBudgetOutlooks||{}),new Date().toISOString());
        db.prepare('UPDATE state_meta SET payload_json=? WHERE singleton=1').run(JSON.stringify(state));
      }
    };
    for (const entry of MIGRATIONS.filter(migration=>migration.version>currentVersion)) {
      const migration = await readFile(new URL(`./migrations/${entry.file}`, import.meta.url), 'utf8');
      const apply=db.transaction(()=>{
        db.exec(migration);
        if(entry.version===8)migrateLegacyProfiles();
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(entry.version, new Date().toISOString());
      });
      apply();
    }
    if(currentVersion>=8){
      const row=db.prepare('SELECT payload_json FROM state_meta WHERE singleton=1').get(),state=row?JSON.parse(row.payload_json):{};
      if(!state.householdProfileMigrationComplete){
        if(state.legacyPlanProfileId==='peter'||Array.isArray(state.householdProfiles)&&state.householdProfiles.some(profile=>profile?.id==='peter')&&state.householdProfiles.some(profile=>profile?.id==='maddie')&&state.householdProfiles.some(profile=>profile?.id==='joint')){
          state.householdProfileMigrationComplete=true;db.prepare('UPDATE state_meta SET payload_json=? WHERE singleton=1').run(JSON.stringify(state));
        }else if(currentVersion>=9&&!['incomePlanTemplates','monthlyIncomePlans','monthlyBudgetOutlooks'].some(key=>Object.hasOwn(state,key))){
          state.householdProfileMigrationComplete=true;db.prepare('UPDATE state_meta SET payload_json=? WHERE singleton=1').run(JSON.stringify(state));
        }else if(currentVersion>=9){
          throw new Error('Household profile data migration is ambiguous; no records were changed. Preserve this database and compare it with the verified pre-migration backup before continuing.');
        }else{
          const repair=db.transaction(()=>{migrateLegacyProfiles();});repair();
        }
      }
    }
    if(MIGRATION_VERSION>=5){
      const migrateLegacyOperations=db.transaction(()=>{
        const row=db.prepare('SELECT payload_json FROM state_meta WHERE singleton=1').get();
        if(!row)return;
        const state=JSON.parse(row.payload_json),legacy=state.operationResults;
        if(!Array.isArray(legacy)||!legacy.length){if(legacy!==undefined){delete state.operationResults;db.prepare('UPDATE state_meta SET payload_json=? WHERE singleton=1').run(JSON.stringify(state));}return;}
        const insert=db.prepare('INSERT OR IGNORE INTO operation_results(operation_id,scope,payload_digest,response_json,revision,created_at) VALUES(?,?,?,?,?,?)');
        const lookup=db.prepare('SELECT scope,payload_digest,response_json,revision,created_at FROM operation_results WHERE operation_id=?');
        for(const entry of legacy){
          if(!entry||typeof entry.id!=='string'||typeof entry.fingerprint!=='string'||typeof entry.createdAt!=='string')throw new Error('Legacy operation replay data is invalid; migration stopped.');
          const separator=entry.fingerprint.indexOf('\n');
          if(separator<1)throw new Error('Legacy operation replay fingerprint is invalid; migration stopped.');
          const scope=entry.fingerprint.slice(0,separator),payloadDigest=createHash('sha256').update(entry.fingerprint).digest('hex'),responseJson=JSON.stringify(entry.response),revision=Number.isSafeInteger(entry.response?.revision)?entry.response.revision:0;
          insert.run(entry.id,scope,payloadDigest,responseJson,revision,entry.createdAt);
          const saved=lookup.get(entry.id);
          if(!saved||saved.scope!==scope||saved.payload_digest!==payloadDigest||saved.response_json!==responseJson||saved.created_at!==entry.createdAt)throw new Error('Legacy operation replay conflicts with indexed storage; migration stopped.');
        }
        delete state.operationResults;
        db.prepare('UPDATE state_meta SET payload_json=? WHERE singleton=1').run(JSON.stringify(state));
      });
      migrateLegacyOperations();
    }
    if(MIGRATION_VERSION>=6){
      const migrateBudgetRecords=db.transaction(()=>{
        const count=db.prepare('SELECT COUNT(*) AS count FROM budget_records').get().count;
        const stateRow=db.prepare('SELECT payload_json FROM state_meta WHERE singleton=1').get(),state=stateRow?JSON.parse(stateRow.payload_json):{},templateSchedules=state.budgetTemplateSchedules||{},monthSchedules=state.monthlyBudgetSchedules||{};
        const templates=db.prepare('SELECT category_id AS categoryId,effective_from AS effectiveFrom,amount FROM budget_templates ORDER BY effective_from,category_id').all();
        const overrides=db.prepare('SELECT month,category_id AS categoryId,amount FROM monthly_budgets ORDER BY month,category_id').all();
        if(count===0&&(templates.length||overrides.length)){
          const insert=db.prepare('INSERT INTO budget_records(category_id,effective_month,scope,monthly_cents,source_cents,frequency,due_month) VALUES(?,?,?,?,?,?,?)');
          const add=(categoryId,effectiveMonth,scope,monthlyCents,schedule={})=>{
            const frequency=schedule.frequency||'monthly',dueMonth=schedule.dueMonth??null,sourceCents=schedule.sourceAmount??monthlyCents;
            const clean=normalizeBudgetRecord({categoryId,effectiveMonth,scope,monthlyCents,sourceCents,frequency,dueMonth});
            insert.run(clean.categoryId,clean.effectiveMonth,clean.scope,clean.monthlyCents,clean.sourceCents,clean.frequency,clean.dueMonth);
          };
          for(const row of templates)add(row.categoryId,row.effectiveFrom,'recurring',row.amount,templateSchedules[`${row.categoryId}:${row.effectiveFrom}`]);
          for(const row of overrides)add(row.categoryId,row.month,'month',row.amount,monthSchedules[`${row.month}:${row.categoryId}`]);
        }
        if(stateRow&&(state.budgetTemplateSchedules!==undefined||state.monthlyBudgetSchedules!==undefined)){
          delete state.budgetTemplateSchedules;delete state.monthlyBudgetSchedules;
          db.prepare('UPDATE state_meta SET payload_json=? WHERE singleton=1').run(JSON.stringify(state));
        }
      });
      migrateBudgetRecords();
    }
    return db;
  }catch(error){
    db.close();throw error;
  }
}

export function createSqliteRepository(db) {
  let writes = Promise.resolve();
  const statements = {
    meta: db.prepare('SELECT payload_json FROM state_meta WHERE singleton=1'),
    rows: Object.fromEntries(TABLES.map(name => [name, db.prepare(`SELECT payload_json FROM ${name} ORDER BY rowid`)])),
    clear: Object.fromEntries(['transactions', 'holdings', 'accounts', 'items', 'custom_categories', 'budgets', 'budget_templates', 'monthly_budgets','budget_records'].map(name => [name, db.prepare(`DELETE FROM ${name}`)])),
    putMeta: db.prepare('INSERT INTO state_meta(singleton,payload_json) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET payload_json=excluded.payload_json'),
    putItem: db.prepare('INSERT INTO items(id,payload_json) VALUES(?,?)'),
    upsertItem: db.prepare(`INSERT INTO items(id,payload_json) VALUES(?,?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`),
    putAccount: db.prepare('INSERT INTO accounts(id,item_id,payload_json) VALUES(?,?,?)'),
    upsertAccount: db.prepare(`INSERT INTO accounts(id,item_id,payload_json) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET item_id=excluded.item_id,payload_json=excluded.payload_json`),
    putTransaction: db.prepare('INSERT INTO transactions(id,account_id,item_id,payload_json) VALUES(?,?,?,?)'),
    putHolding: db.prepare('INSERT INTO holdings(id,item_id,payload_json) VALUES(?,?,?)'),
    putCategory: db.prepare('INSERT INTO custom_categories(id,name,normalized_name,profile_id) VALUES(?,?,?,?)'),
    putBudget: db.prepare('INSERT INTO budgets(category,amount) VALUES(?,?)'),
    putTemplate: db.prepare('INSERT INTO budget_templates(category_id,effective_from,amount) VALUES(?,?,?)'),
    putMonthlyBudget: db.prepare('INSERT INTO monthly_budgets(month,category_id,amount) VALUES(?,?,?)'),
    putBudgetRecord: db.prepare('INSERT INTO budget_records(category_id,effective_month,scope,profile_id,monthly_cents,source_cents,frequency,due_month) VALUES(?,?,?,?,?,?,?,?)'),
    putBudgetHistory: db.prepare('INSERT INTO budget_change_history(history_id,record_type,category_id,month,scope,action,before_json,after_json,revision,operation_id,created_at,profile_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'),
    putProfilePlanState: db.prepare(`INSERT INTO household_plan_state(profile_id,income_templates_json,monthly_income_json,outlooks_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET income_templates_json=excluded.income_templates_json,monthly_income_json=excluded.monthly_income_json,outlooks_json=excluded.outlooks_json,updated_at=excluded.updated_at`),
    findImport: db.prepare('SELECT source_checksum FROM import_batches WHERE source_checksum=?'),
    addImport: db.prepare('INSERT INTO import_batches(source_checksum,schema_version,imported_at,record_counts_json) VALUES(?,?,?,?)')
    ,operationById: db.prepare('SELECT operation_id AS id,scope,payload_digest AS payloadDigest,response_json AS responseJson,revision,created_at AS createdAt FROM operation_results WHERE operation_id=?')
    ,putOperation: db.prepare('INSERT INTO operation_results(operation_id,scope,payload_digest,response_json,revision,created_at) VALUES(?,?,?,?,?,?)')
  };
  const customCategoryNames=state=>[...new Set([...(state.customCategories||[]),...(state.categoryRecords||[]).filter(category=>!category.system).map(category=>category.name)])];
  function recordsFromLegacyState(state){
    return budgetRecordsFromProjections(state);
  }
  function persistCanonicalBudgetRecords(state){
    const editedProfile=state._budgetProfileId||'peter';
    const records=state._budgetProfileId
      ?[...db.prepare("SELECT category_id AS categoryId,effective_month AS effectiveMonth,scope,profile_id AS profileId,monthly_cents AS monthlyCents,source_cents AS sourceCents,frequency,due_month AS dueMonth FROM budget_records WHERE profile_id<>?").all(editedProfile),...recordsFromLegacyState(state).map(record=>({...record,profileId:editedProfile}))]
      :Array.isArray(state.budgetRecords)&&state.budgetRecords.length>0
        ?state.budgetRecords.map(normalizeBudgetRecord)
        :recordsFromLegacyState(state).map(record=>({...record,profileId:editedProfile}));
    statements.clear.budget_records.run();
    for(const row of records)statements.putBudgetRecord.run(row.categoryId,row.effectiveMonth,row.scope,row.profileId,row.monthlyCents,row.sourceCents,row.frequency,row.dueMonth);
  }
  function persistBudgetHistory(state){for(const row of state._pendingBudgetHistory||[]){if(!row||typeof row.id!=='string'||!['budget','income','outlook'].includes(row.recordType)||!Number.isSafeInteger(row.revision)||typeof row.createdAt!=='string')throw new Error('Invalid budget audit entry.');statements.putBudgetHistory.run(row.id,row.recordType,row.categoryId,row.month,row.scope,row.action,json(row.before),json(row.after),row.revision,row.operationId,row.createdAt,row.profileId||'peter');}}
  function budgetHistoryQuery({id,month,categoryId,profileId,limit=100}={}){const clauses=[],values=[];if(id){clauses.push('history_id=?');values.push(id);}if(month){clauses.push('month=?');values.push(month);}if(categoryId){clauses.push('category_id=?');values.push(categoryId);}if(profileId){clauses.push('profile_id=?');values.push(profileId);}const where=clauses.length?'WHERE '+clauses.join(' AND '):'';return db.prepare(`SELECT history_id AS id,record_type AS recordType,category_id AS categoryId,month,scope,profile_id AS profileId,action,before_json AS beforeJson,after_json AS afterJson,revision,operation_id AS operationId,created_at AS createdAt FROM budget_change_history ${where} ORDER BY created_at DESC,history_id DESC LIMIT ?`).all(...values,Math.min(500,Math.max(1,Number.isSafeInteger(limit)?limit:100))).map(row=>({...row,before:parse(row.beforeJson),after:parse(row.afterJson)}));}
  function attachCanonicalBudgetRecords(state){
    const records=db.prepare('SELECT category_id AS categoryId,effective_month AS effectiveMonth,scope,profile_id AS profileId,monthly_cents AS monthlyCents,source_cents AS sourceCents,frequency,due_month AS dueMonth FROM budget_records ORDER BY profile_id,effective_month,category_id,scope').all().map(normalizeBudgetRecord);
    Object.assign(state,budgetRecordProjections(records));
  }
  function readProfilePlanState(profileId){
    const row=db.prepare('SELECT income_templates_json AS incomeTemplatesJson,monthly_income_json AS monthlyIncomeJson,outlooks_json AS outlooksJson FROM household_plan_state WHERE profile_id=?').get(profileId);
    return row?{incomePlanTemplates:parse(row.incomeTemplatesJson),monthlyIncomePlans:parse(row.monthlyIncomeJson),monthlyBudgetOutlooks:parse(row.outlooksJson)}:{incomePlanTemplates:[],monthlyIncomePlans:{},monthlyBudgetOutlooks:{}};
  }
  function persistProfilePlanState(state){
    const updatedAt=new Date().toISOString(),peterProjection={incomePlanTemplates:state.incomePlanTemplates,monthlyIncomePlans:state.monthlyIncomePlans,monthlyBudgetOutlooks:state.monthlyBudgetOutlooks},hasPeterProjection=(peterProjection.incomePlanTemplates||[]).length>0||Object.keys(peterProjection.monthlyIncomePlans||{}).length>0||Object.keys(peterProjection.monthlyBudgetOutlooks||{}).length>0,plans=state.profilePlanState&&typeof state.profilePlanState==='object'&&Object.keys(state.profilePlanState).length>0
      ?Object.entries({...state.profilePlanState,peter:hasPeterProjection?peterProjection:(state.profilePlanState.peter||peterProjection)})
      :[[state._budgetProfileId||'peter',peterProjection]];
    for(const[profileId,plan]of plans)if(['peter','maddie','joint'].includes(profileId))statements.putProfilePlanState.run(profileId,json(plan?.incomePlanTemplates||[]),json(plan?.monthlyIncomePlans||{}),json(plan?.monthlyBudgetOutlooks||{}),updatedAt);
  }
  function attachProfilePlanStates(state){
    const records=db.prepare('SELECT profile_id AS profileId,income_templates_json AS incomeTemplatesJson,monthly_income_json AS monthlyIncomeJson,outlooks_json AS outlooksJson FROM household_plan_state ORDER BY profile_id').all();
    state.profilePlanState=Object.fromEntries(records.map(row=>[row.profileId,{incomePlanTemplates:parse(row.incomeTemplatesJson),monthlyIncomePlans:parse(row.monthlyIncomeJson),monthlyBudgetOutlooks:parse(row.outlooksJson)}]));
    Object.assign(state,state.profilePlanState.peter||readProfilePlanState('peter'));
  }
  function markHouseholdProfileMigrationComplete(state){state.householdProfileMigrationComplete=true;}
  function persistCustomCategories(state){
    statements.clear.custom_categories.run();
    const records=(state.categoryRecords||[]).filter(category=>category&&!category.system),knownNames=new Set(records.map(category=>String(category.name).normalize('NFKC').trim().toLocaleLowerCase('en-US')));
    for(const category of records){
      if(typeof category.name!=='string'||!category.name.trim())throw new Error('Invalid custom category.');
      const name=category.name.trim(),normalized=category.normalizedName||name.normalize('NFKC').replace(/\s+/g,' ').toLocaleLowerCase('en-US');
      statements.putCategory.run(category.id,name,normalized,category.profileId||'peter');
    }
    for(const rawName of state.customCategories||[]){
      if(typeof rawName!=='string'||!rawName.trim())throw new Error('Invalid custom category.');
      const name=rawName.trim(),normalized=name.normalize('NFKC').replace(/\s+/g,' ').toLocaleLowerCase('en-US');if(knownNames.has(normalized))continue;
      const id=`legacy-category-${createHash('sha256').update(normalized).digest('hex').slice(0,32)}`;statements.putCategory.run(id,name,normalized,'peter');
    }
  }
  function load() {
    const meta = statements.meta.get();
    const state = meta ? parse(meta.payload_json) : { version: 1, owner: null, lastSync: null, lease: null, householdProfiles:[{id:'peter',label:'Peter'},{id:'maddie',label:'Maddie'},{id:'joint',label:'Joint'}] };
    for (const name of TABLES) state[name] = statements.rows[name].all().map(row => parse(row.payload_json));
    state.customCategories = db.prepare('SELECT DISTINCT name FROM custom_categories ORDER BY name').all().map(row => row.name);
    state.budgets = Object.fromEntries(db.prepare('SELECT category,amount FROM budgets ORDER BY category').all().map(row => [row.category, row.amount]));
    attachCanonicalBudgetRecords(state);
    attachProfilePlanStates(state);
    return state;
  }
  function loadBudgetState(profileId='peter') {
    const meta = statements.meta.get();
    const state = meta ? parse(meta.payload_json) : { version: 1, owner: null, lastSync: null, lease: null };
    Object.assign(state,readProfilePlanState(profileId));
    state.customCategories = db.prepare('SELECT DISTINCT name FROM custom_categories ORDER BY name').all().map(row => row.name);
    state.budgets = Object.fromEntries(db.prepare('SELECT category,amount FROM budgets ORDER BY category').all().map(row => [row.category, row.amount]));
    attachCanonicalBudgetRecords(state);
    Object.assign(state,budgetRecordProjectionsForProfile(state.budgetRecords||[],profileId));state._budgetProfileId=profileId;
    return state;
  }
  function loadOwnerState() {
    const state=loadBudgetState();
    state.items=statements.rows.items.all().map(row=>parse(row.payload_json));
    state.accounts=statements.rows.accounts.all().map(row=>parse(row.payload_json));
    state.transactions=statements.rows.transactions.all().map(row=>parse(row.payload_json));
    state.holdings=statements.rows.holdings.all().map(row=>parse(row.payload_json));
    return state;
  }
  function dashboardState() {
    const metaRow=statements.meta.get();
    const source=metaRow?parse(metaRow.payload_json):{version:1,owner:null,lastSync:null,lease:null};
    const {scenarios,goalAllocationLedger,categoryEditBatches,importBatches,mortgageSnapshots,operationResults,...meta}=source;
    const state={...meta,lastGoalAllocationUndo:[...(goalAllocationLedger||[])].reverse().find(entry=>!entry.undoneAt)||null,accounts:statements.rows.accounts.all().map(row=>parse(row.payload_json)),items:statements.rows.items.all().map(row=>{const {token,cursor,...item}=parse(row.payload_json);return item;}),holdings:statements.rows.holdings.all().map(row=>parse(row.payload_json))};
    state.goalAllocations=(state.goalAllocations||[]).filter(allocation=>allocation.active!==false);
    state.balanceSheetSnapshots=(state.balanceSheetSnapshots||[]).slice(-12);
    state.customCategories=db.prepare('SELECT DISTINCT name FROM custom_categories ORDER BY name').all().map(row=>row.name);
    state.budgets=Object.fromEntries(db.prepare('SELECT category,amount FROM budgets ORDER BY category').all().map(row=>[row.category,row.amount]));
    attachCanonicalBudgetRecords(state);
    attachProfilePlanStates(state);
    state.transactionCount=db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count;
    state.transactionMonths=db.prepare("SELECT DISTINCT substr(json_extract(payload_json,'$.date'),1,7) AS month FROM transactions WHERE json_extract(payload_json,'$.date') IS NOT NULL ORDER BY month DESC").all().map(row=>row.month);
    return state;
  }
  function profileClause(profileId, values) {
    if(!profileId||profileId==='combined')return '';
    if(!['peter','maddie','joint'].includes(profileId))throw new TypeError('Invalid reporting profile.');
    values.push(profileId);
    return "coalesce(json_extract(transactions.payload_json,'$.profileId'),(SELECT json_extract(accounts.payload_json,'$.profileId') FROM accounts WHERE accounts.id=transactions.account_id))=?";
  }
  function queryTransactionPage({page=1,limit=50,search='',category='',accountId='',from='',to='',review=false,viewProfile='combined'}={}) {
    const clauses=[],values=[];
    if(search){clauses.push("instr(ledger_casefold(json_extract(transactions.payload_json,'$.merchant')) ,?)>0");values.push(search.toLocaleLowerCase('en-US'));}
    if(category){const effectiveName="coalesce(nullif(json_extract(payload_json,'$.override'),''),json_extract(payload_json,'$.category'))",effectiveId="CASE WHEN nullif(json_extract(payload_json,'$.override'),'') IS NOT NULL THEN json_extract(payload_json,'$.overrideCategoryId') ELSE json_extract(payload_json,'$.categoryId') END";clauses.push(`(${effectiveName}=? OR ${effectiveId}=?)`);values.push(category,category);}
    if(accountId){clauses.push('transactions.account_id=?');values.push(accountId);}
    if(from){clauses.push("json_extract(payload_json,'$.date')>=?");values.push(from);}
    if(to){clauses.push("json_extract(payload_json,'$.date')<=?");values.push(to);}
    if(review)clauses.push("(json_extract(payload_json,'$.review')=1 OR (json_type(payload_json,'$.confidence') IS NOT NULL AND CAST(json_extract(payload_json,'$.confidence') AS REAL)<0.5) OR coalesce(json_extract(payload_json,'$.override'),json_extract(payload_json,'$.category'))='Other')");
    const owner=profileClause(viewProfile,values);if(owner)clauses.push(owner);
    const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
    const total=db.prepare(`SELECT COUNT(*) AS count FROM transactions ${where}`).get(...values).count;
    const transactions=db.prepare(`SELECT transactions.payload_json FROM transactions ${where} ORDER BY json_extract(transactions.payload_json,'$.date') DESC,id ASC LIMIT ? OFFSET ?`).all(...values,limit,(page-1)*limit).map(row=>parse(row.payload_json));
    const revision=db.prepare("SELECT coalesce(json_extract(payload_json,'$.revision'),0) AS revision FROM state_meta WHERE singleton=1").get()?.revision||0;
    return {page,limit,total,transactions,revision};
  }
  function queryCategoryTransactionIds(categoryId,categoryName){
    return db.prepare(`SELECT id FROM transactions WHERE json_extract(payload_json,'$.category')=?
      OR json_extract(payload_json,'$.overrideCategoryId')=?
      OR (coalesce(json_extract(payload_json,'$.overrideCategoryId'),'')='' AND json_extract(payload_json,'$.override')=?)`).all(categoryName,categoryId,categoryName).map(row=>row.id);
  }
  function queryBudgetAnalytics(month,viewProfile='combined') {
    const state=loadBudgetState(viewProfile==='combined'?'peter':viewProfile);
    const effectiveName="coalesce(nullif(json_extract(payload_json,'$.override'),''),json_extract(payload_json,'$.category'))";
    const effectiveId="CASE WHEN nullif(json_extract(payload_json,'$.override'),'') IS NOT NULL THEN json_extract(payload_json,'$.overrideCategoryId') ELSE json_extract(payload_json,'$.categoryId') END";
    const eligible="json_extract(payload_json,'$.pending') IS NOT 1 AND json_extract(payload_json,'$.currency')='USD'";
    const valuesFor=(from,to)=>{const values=[from,to],owner=profileClause(viewProfile,values);return{values,owner};};
    const aggregate=(from,to)=>{const {values,owner}=valuesFor(from,to);return db.prepare(`SELECT substr(json_extract(transactions.payload_json,'$.date'),1,7) AS month,${effectiveName} AS category,${effectiveId} AS categoryId,SUM(json_extract(transactions.payload_json,'$.amount')) AS amount,COUNT(*) AS activity
      FROM transactions WHERE ${eligible} AND json_extract(transactions.payload_json,'$.date')>=? AND json_extract(transactions.payload_json,'$.date')<? ${owner?`AND ${owner}`:''} GROUP BY month,category,categoryId`).all(...values);};
    const currentRows=aggregate(`${month}-01`,`${nextMonth(month)}-01`);
    const boundary=state.budgetHistoryUnavailableBefore;
    const start=typeof boundary==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(boundary)&&boundary<=month?boundary:month;
    const historicalRows=start<month?aggregate(`${start}-01`,`${month}-01`):[];
    return{state,currentRows,historicalRows};
  }
  function nextMonth(month){
    const [year,number]=month.split('-').map(Number);
    return number===12?`${String(year+1).padStart(4,'0')}-01`:`${String(year).padStart(4,'0')}-${String(number+1).padStart(2,'0')}`;
  }
  function monthSummary(month,viewProfile='combined') {
    const start=`${month}-01`,monthDate=new Date(`${start}T12:00:00Z`),previousDate=new Date(Date.UTC(monthDate.getUTCFullYear(),monthDate.getUTCMonth()-1,1));
    const previous=`${previousDate.getUTCFullYear()}-${String(previousDate.getUTCMonth()+1).padStart(2,'0')}`;
    const nextDate=new Date(Date.UTC(monthDate.getUTCFullYear(),monthDate.getUTCMonth()+1,1));
    const end=new Date(nextDate.getTime()-86400000).toISOString().slice(0,10);
    const previousEnd=new Date(monthDate.getTime()-86400000).toISOString().slice(0,10);
    const from=`${previous}-01`;
    const metaForSplits=statements.meta.get(),splitState=metaForSplits?parse(metaForSplits.payload_json):{};
    if((splitState.transactionSplits||[]).length){
      const allTransactions=statements.rows.transactions.all().map(row=>parse(row.payload_json)),reportRows=applyTransactionSplitsToRows(splitState,allTransactions);
      const accounts=statements.rows.accounts.all().map(row=>parse(row.payload_json)),effectiveOwner=row=>row.profileId??accounts.find(account=>account.id===row.accountId)?.profileId??null,visibleRows=viewProfile==='combined'?reportRows:reportRows.filter(row=>effectiveOwner(row)===viewProfile);
      const summarizeMonth=key=>{const categories={};let spend=0,income=0,purchases=0;const weeklySpend=[0,0,0,0,0];for(const row of visibleRows){if(!row.date?.startsWith(key)||row.pending||row.currency!=='USD')continue;const category=row.override||row.category;if(category==='Income')income=addSafeCents(income,-row.amount,'Monthly income');else if(category!=='Transfers'&&splitState.budgetItemSettings?.[row.categoryId]?.itemType!=='allocation'&&splitState.categoryRecords?.find(value=>value.id===row.categoryId)?.kind!=='allocation'){spend=addSafeCents(spend,row.amount,'Monthly spending');categories[category]=addSafeCents(categories[category]||0,row.amount,'Monthly category spending');if(row.amount>0)purchases++;const week=Math.min(4,Math.floor((Number(row.date.slice(-2))-1)/7));weeklySpend[week]=addSafeCents(weeklySpend[week],row.amount,'Weekly spending');}}return{spend,income,purchases,categories,weeklySpend};};
      const currentRows=visibleRows.filter(row=>row.date?.startsWith(month)).sort((a,b)=>b.date.localeCompare(a.date)||String(a.merchant||'').localeCompare(String(b.merchant||''))||a.id.localeCompare(b.id));
      return{month,previousMonth:previous,current:summarizeMonth(month),previous:summarizeMonth(previous),recent:currentRows.slice(0,6),transactionCount:currentRows.length};
    }
    const ownerValues=[];const owner=profileClause(viewProfile,ownerValues);
    const category="coalesce(nullif(json_extract(transactions.payload_json,'$.override'),''),json_extract(transactions.payload_json,'$.category'))";
    const eligible="json_extract(payload_json,'$.pending') IS NOT 1 AND json_extract(payload_json,'$.currency')='USD'";
    const effectiveId="CASE WHEN nullif(json_extract(payload_json,'$.override'),'') IS NOT NULL THEN json_extract(payload_json,'$.overrideCategoryId') ELSE json_extract(payload_json,'$.categoryId') END";
    const categoryRecords="coalesce((SELECT json_extract(payload_json,'$.categoryRecords') FROM state_meta WHERE singleton=1),'[]')";
    const budgetSettings="coalesce((SELECT json_extract(payload_json,'$.budgetItemSettings') FROM state_meta WHERE singleton=1),'{}')";
    const isAllocation=`(EXISTS (SELECT 1 FROM json_each(${categoryRecords}) AS category_record
      WHERE (json_extract(category_record.value,'$.id')=${effectiveId} OR json_extract(category_record.value,'$.name')=${category})
      AND (json_extract(category_record.value,'$.kind')='allocation' OR EXISTS (SELECT 1 FROM json_each(${budgetSettings}) AS item_setting WHERE item_setting.key=json_extract(category_record.value,'$.id') AND json_extract(item_setting.value,'$.itemType')='allocation')))
      OR EXISTS (SELECT 1 FROM json_each(${budgetSettings}) AS item_setting WHERE item_setting.key=${effectiveId} AND json_extract(item_setting.value,'$.itemType')='allocation'))`;
    const expenseEligible=`${eligible} AND ${category} NOT IN ('Income','Transfers') AND NOT ${isAllocation}`;
    const rows=db.prepare(`SELECT ${category} AS category,
      SUM(CASE WHEN ${expenseEligible} THEN json_extract(payload_json,'$.amount') ELSE 0 END) AS spend,
      SUM(CASE WHEN ${eligible} AND ${category}='Income' THEN -json_extract(payload_json,'$.amount') ELSE 0 END) AS income,
      SUM(CASE WHEN ${expenseEligible} AND json_extract(payload_json,'$.amount')>0 THEN 1 ELSE 0 END) AS purchases,
      substr(json_extract(payload_json,'$.date'),1,7) AS month
      FROM transactions WHERE json_extract(transactions.payload_json,'$.date') BETWEEN ? AND ? ${owner?`AND ${owner}`:''} GROUP BY month,category`).all(from,end,...ownerValues);
    const summarize=key=>{
      const categories={};let spend=0,income=0,purchases=0;
      for(const row of rows){if(row.month!==key)continue;if(row.category==='Income')income+=row.income||0;else if(row.category!=='Transfers'){const amount=row.spend||0;spend+=amount;purchases+=row.purchases||0;if(amount)categories[row.category||'Other']=(categories[row.category||'Other']||0)+amount;}}
      const weekly=db.prepare(`SELECT min(4,CAST((CAST(substr(json_extract(payload_json,'$.date'),9,2) AS INTEGER)-1)/7 AS INTEGER)) AS week,
        SUM(CASE WHEN ${expenseEligible} THEN json_extract(payload_json,'$.amount') ELSE 0 END) AS amount
        FROM transactions WHERE json_extract(payload_json,'$.date') BETWEEN ? AND ? ${owner?`AND ${owner}`:''} GROUP BY week`).all(`${key}-01`,key===month?end:previousEnd,...ownerValues);
      const weeklySpend=[0,0,0,0,0];for(const row of weekly)weeklySpend[row.week]=row.amount||0;
      return{spend,income,purchases,categories,weeklySpend};
    };
    const profileFilter=owner?`AND ${owner}`:'';
    const recent=db.prepare(`SELECT payload_json FROM transactions WHERE json_extract(payload_json,'$.date') BETWEEN ? AND ? ${profileFilter} ORDER BY json_extract(payload_json,'$.date') DESC,json_extract(payload_json,'$.merchant') ASC,id ASC LIMIT 6`).all(start,end,...ownerValues).map(row=>parse(row.payload_json));
    const transactionCount=db.prepare(`SELECT COUNT(*) AS count FROM transactions WHERE json_extract(payload_json,'$.date') BETWEEN ? AND ? ${profileFilter}`).get(start,end,...ownerValues).count;
    const revision=db.prepare("SELECT coalesce(json_extract(payload_json,'$.revision'),0) AS revision FROM state_meta WHERE singleton=1").get()?.revision||0;
    return{month,previousMonth:previous,revision,current:summarize(month),previous:summarize(previous),recent,transactionCount};
  }
  function scenarioDetails() {
    const row=statements.meta.get();
    return row?(parse(row.payload_json).scenarios||[]):[];
  }
  function ownerIdentity() {
    const row=db.prepare("SELECT json_extract(payload_json,'$.owner') AS owner,json_extract(payload_json,'$.lastSync') AS lastSync FROM state_meta WHERE singleton=1").get();
    return {owner:row?.owner||null,lastSync:row?.lastSync||null};
  }
  function syncJobState() {
    const row=db.prepare("SELECT json_extract(payload_json,'$.syncJob') AS sync_job FROM state_meta WHERE singleton=1").get();
    return row?.sync_job?JSON.parse(row.sync_job):null;
  }
  const persist = db.transaction(state => {
    validateState(state);
    markHouseholdProfileMigrationComplete(state);
    for (const name of [...TABLES, 'custom_categories', 'budgets', 'budget_templates', 'monthly_budgets']) statements.clear[name].run();
    const { items = [], accounts = [], transactions = [], holdings = [], customCategories = [], budgets = {}, budgetTemplates = [], monthlyBudgets = {}, budgetRecords, budgetTemplateSchedules, monthlyBudgetSchedules, incomePlanTemplates, monthlyIncomePlans, monthlyBudgetOutlooks, profilePlanState, _budgetProfileId, _pendingOperation, _pendingBudgetHistory, ...meta } = state;
    statements.putMeta.run(json(meta));
    if(_pendingOperation)statements.putOperation.run(_pendingOperation.id,_pendingOperation.scope,_pendingOperation.payloadDigest,json(_pendingOperation.response),_pendingOperation.revision,_pendingOperation.createdAt);
    persistBudgetHistory(state);
    persistCanonicalBudgetRecords(state);
    persistProfilePlanState(state);
    for (const row of items) statements.putItem.run(row.id, json(row));
    for (const row of accounts) statements.putAccount.run(row.id, row.itemId ?? null, json(row));
    for (const row of transactions) statements.putTransaction.run(row.id, row.accountId ?? null, row.itemId ?? null, json(row));
    for (const [index, row] of holdings.entries()) statements.putHolding.run(row.id || `legacy-holding-${index}`, row.itemId ?? null, json(row));
    persistCustomCategories(state);
    for (const [category, amount] of Object.entries(budgets)) statements.putBudget.run(category, amount);
    for (const template of budgetTemplates) statements.putTemplate.run(template.categoryId, template.effectiveFrom, template.amount);
    for (const [key, amount] of Object.entries(monthlyBudgets)) { const month=key.slice(0,7), categoryId=key.slice(8); statements.putMonthlyBudget.run(month, categoryId, amount); }
  });
  const persistBudgetState = db.transaction(state => {
    validateState({ ...state, items: [], accounts: [], transactions: [], holdings: [] });
    markHouseholdProfileMigrationComplete(state);
    const { items, accounts, transactions, holdings, customCategories, budgets, budgetTemplates, monthlyBudgets, budgetRecords, budgetTemplateSchedules, monthlyBudgetSchedules, incomePlanTemplates, monthlyIncomePlans, monthlyBudgetOutlooks, profilePlanState, _pendingOperation, _pendingBudgetHistory, _budgetProfileId, ...meta } = state;
    statements.putMeta.run(json(meta));
    if(_pendingOperation)statements.putOperation.run(_pendingOperation.id,_pendingOperation.scope,_pendingOperation.payloadDigest,json(_pendingOperation.response),_pendingOperation.revision,_pendingOperation.createdAt);
    persistBudgetHistory(state);
    persistCanonicalBudgetRecords(state);
    persistProfilePlanState(state);
    persistCustomCategories(state);
    statements.clear.budgets.run();
    statements.clear.budget_templates.run();
    statements.clear.monthly_budgets.run();
    for (const [category, amount] of Object.entries(budgets)) statements.putBudget.run(category, amount);
    for (const template of budgetTemplates) statements.putTemplate.run(template.categoryId, template.effectiveFrom, template.amount);
    for (const [key, amount] of Object.entries(monthlyBudgets)) { const month = key.slice(0, 7), categoryId = key.slice(8); statements.putMonthlyBudget.run(month, categoryId, amount); }
  });
  const persistOwnerState = db.transaction(state => {
    validateState({ ...state, transactions: [], holdings: [] });
    markHouseholdProfileMigrationComplete(state);
    const { items, accounts, transactions, holdings, customCategories, budgets, budgetTemplates, monthlyBudgets, budgetRecords, budgetTemplateSchedules, monthlyBudgetSchedules, incomePlanTemplates, monthlyIncomePlans, monthlyBudgetOutlooks, profilePlanState, _pendingOperation, _pendingBudgetHistory, _budgetProfileId, ...meta } = state;
    statements.putMeta.run(json(meta));
    if(_pendingOperation)statements.putOperation.run(_pendingOperation.id,_pendingOperation.scope,_pendingOperation.payloadDigest,json(_pendingOperation.response),_pendingOperation.revision,_pendingOperation.createdAt);
    persistBudgetHistory(state);
    for (const account of accounts) statements.upsertAccount.run(account.id, account.itemId ?? null, json(account));
  });
  const importLegacy = db.transaction((state, checksum) => {
    if (statements.findImport.get(checksum)) return { imported: false };
    const count = db.prepare('SELECT (SELECT COUNT(*) FROM state_meta)+(SELECT COUNT(*) FROM items)+(SELECT COUNT(*) FROM accounts)+(SELECT COUNT(*) FROM transactions)+(SELECT COUNT(*) FROM holdings)+(SELECT COUNT(*) FROM budgets)+(SELECT COUNT(*) FROM custom_categories)+(SELECT COUNT(*) FROM budget_templates)+(SELECT COUNT(*) FROM monthly_budgets)+(SELECT COUNT(*) FROM budget_records)+(SELECT COUNT(*) FROM budget_change_history)+(SELECT COUNT(*) FROM import_batches)+(SELECT COUNT(*) FROM operation_results) AS count').get().count;
    if (count) throw new Error('Destination already contains records; refusing to merge an unreviewed import.');
    persist(state);
    const recordCounts = Object.fromEntries([...TABLES, 'customCategories'].map(name => [name, state[name]?.length ?? 0]));
    recordCounts.budgets = Object.keys(state.budgets ?? {}).length;
    statements.addImport.run(checksum, MIGRATION_VERSION, new Date().toISOString(), json(recordCounts));
    return { imported: true, recordCounts };
  });
  const writeTransactionSubset = db.transaction((state, ids) => {
    validateState({ ...state, items: [], accounts: [], holdings: [], transactions: state.transactions || [], budgets: {} });
    markHouseholdProfileMigrationComplete(state);
    const desired = new Map((state.transactions || []).map(transaction => [transaction.id, transaction]));
    const remove = db.prepare('DELETE FROM transactions WHERE id=?');
    const put = db.prepare(`INSERT INTO transactions(id,account_id,item_id,payload_json) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,item_id=excluded.item_id,payload_json=excluded.payload_json`);
    for (const id of ids) {
      const transaction = desired.get(id);
      if (!transaction) remove.run(id);
      else put.run(transaction.id, transaction.accountId ?? null, transaction.itemId ?? null, json(transaction));
    }
    for (const item of state.items || []) statements.upsertItem.run(item.id, json(item));
    for (const id of state._deleteAccountIds || []) db.prepare('DELETE FROM accounts WHERE id=?').run(id);
    for (const account of state.accounts || []) statements.upsertAccount.run(account.id, account.itemId ?? null, json(account));
    const { transactions, items, accounts, holdings, _deleteAccountIds, customCategories, budgets, budgetTemplates, monthlyBudgets, budgetRecords, budgetTemplateSchedules, monthlyBudgetSchedules, _pendingOperation, _pendingBudgetHistory, ...meta } = state;
    statements.putMeta.run(json(meta));
    if(_pendingOperation)statements.putOperation.run(_pendingOperation.id,_pendingOperation.scope,_pendingOperation.payloadDigest,json(_pendingOperation.response),_pendingOperation.revision,_pendingOperation.createdAt);
    persistCustomCategories(state);
    persistBudgetHistory(state);
  });
  return Object.freeze({
    schemaVersion: MIGRATION_VERSION,
    async read() { return { state: load() }; },
    async readBudgetState(profileId='peter') { return { state: loadBudgetState(profileId) }; },
    async readOwnerState() { return { state: loadOwnerState() }; },
    async readDashboard() { return {state:dashboardState()}; },
    async readIdentity() { return ownerIdentity(); },
    async readSyncJob() { return syncJobState(); },
    async queryTransactions(query) { return queryTransactionPage(query); },
    async queryCategoryTransactionIds(categoryId,categoryName) { return queryCategoryTransactionIds(categoryId,categoryName); },
    async readBudgetAnalytics(month,viewProfile) { return queryBudgetAnalytics(month,viewProfile); },
    async queryMonthSummary(month,viewProfile) { return monthSummary(month,viewProfile); },
    async readScenarios() { return scenarioDetails(); },
    async readOperationResult(id) { const row=statements.operationById.get(id);return row?{...row,response:parse(row.responseJson)}:null; },
    async readBudgetHistory(query) { return budgetHistoryQuery(query); },
    async mutateWithOperation(operationRecord, update, {strategy='default',transactionIds=[]}={}) {
      const operation=writes.then(async()=>{
        const prior=statements.operationById.get(operationRecord.id);
        if(prior){if(prior.scope!==operationRecord.scope||prior.payloadDigest!==operationRecord.payloadDigest)throw Object.assign(new Error('This save identifier was already used for different values. Start a new save.'),{status:409});return{state:null,result:parse(prior.responseJson),replayed:true};}
        const ids=[...new Set(transactionIds)];
        let state;
        if(strategy==='budget')state=loadBudgetState();
        else if(strategy.startsWith('budget:'))state=loadBudgetState(strategy.slice(7));
        else if(strategy==='owner')state=loadOwnerState();
        else if(strategy==='transactions'){
          const meta=statements.meta.get();state=meta?parse(meta.payload_json):{version:1,owner:null,lastSync:null,lease:null};
          state.revision=Number.isSafeInteger(state.revision)?state.revision:0;
          state.transactions=ids.length?db.prepare(`SELECT payload_json FROM transactions WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids).map(row=>parse(row.payload_json)):[];
          state.accounts=statements.rows.accounts.all().map(row=>parse(row.payload_json));state.items=statements.rows.items.all().map(row=>parse(row.payload_json));
          state.customCategories=db.prepare('SELECT DISTINCT name FROM custom_categories ORDER BY name').all().map(row=>row.name);state.budgets=Object.fromEntries(db.prepare('SELECT category,amount FROM budgets ORDER BY category').all().map(row=>[row.category,row.amount]));
          state.budgetTemplates=db.prepare('SELECT category_id AS categoryId,effective_from AS effectiveFrom,amount FROM budget_templates ORDER BY effective_from,category_id').all();state.monthlyBudgets=Object.fromEntries(db.prepare('SELECT month,category_id AS categoryId,amount FROM monthly_budgets ORDER BY month,category_id').all().map(row=>[`${row.month}:${row.categoryId}`,row.amount]));
        }else state=load();
        state._pendingOperation=await update(state);
        const commit=db.transaction(()=>{
          const existing=statements.operationById.get(state._pendingOperation.id);
          if(existing)return{state:null,result:parse(existing.responseJson),operation:{id:existing.id,scope:existing.scope,payloadDigest:existing.payloadDigest}};
          if(strategy==='budget'||strategy.startsWith('budget:'))persistBudgetState(state);
          else if(strategy==='owner')persistOwnerState(state);
          else if(strategy==='transactions')writeTransactionSubset(state,ids);
          else persist(state);
          return{state,result:state._pendingOperation.response,operation:null};
        });
        const outcome=commit();
        if(outcome.operation){
          if(outcome.operation.scope!==state._pendingOperation.scope||outcome.operation.payloadDigest!==state._pendingOperation.payloadDigest)throw Object.assign(new Error('This save identifier was already used for different values. Start a new save.'),{status:409});
          return{state:null,result:outcome.result,replayed:true};
        }
        delete state._pendingOperation;
        return{state,result:outcome.result,replayed:false};
      });
      writes=operation.catch(()=>{});return operation;
    },
    async mutate(update) {
      const operation = writes.then(async () => {
        const state = load();
        await update(state);
        persist(state);
        return state;
      });
      writes = operation.catch(() => {});
      return operation;
    },
    async mutateBudgetState(update,profileId='peter') {
      const operation = writes.then(async () => {
        const state = loadBudgetState(profileId);
        await update(state);
        persistBudgetState(state);
        return state;
      });
      writes = operation.catch(() => {});
      return operation;
    },
    async mutateOwnerState(update) {
      const operation = writes.then(async () => {
        const state = loadOwnerState();
        await update(state);
        persistOwnerState(state);
        return state;
      });
      writes = operation.catch(() => {});
      return operation;
    },
    async mutateTransactionSubset(ids, update) {
      const uniqueIds = [...new Set(ids)];
      const operation = writes.then(async () => {
        const meta = statements.meta.get();
        const state = meta ? parse(meta.payload_json) : { version: 1, owner: null, lastSync: null, lease: null };
        state.revision = Number.isSafeInteger(state.revision) ? state.revision : 0;
        state.transactions = uniqueIds.length
          ? db.prepare(`SELECT payload_json FROM transactions WHERE id IN (${uniqueIds.map(() => '?').join(',')})`).all(...uniqueIds).map(row => parse(row.payload_json))
          : [];
        state.accounts = statements.rows.accounts.all().map(row => parse(row.payload_json));
        state.items = statements.rows.items.all().map(row => parse(row.payload_json));
        state.customCategories = db.prepare('SELECT DISTINCT name FROM custom_categories ORDER BY name').all().map(row => row.name);
        state.budgets = Object.fromEntries(db.prepare('SELECT category,amount FROM budgets ORDER BY category').all().map(row => [row.category, row.amount]));
        state.budgetTemplates = db.prepare('SELECT category_id AS categoryId,effective_from AS effectiveFrom,amount FROM budget_templates ORDER BY effective_from,category_id').all();
        state.monthlyBudgets = Object.fromEntries(db.prepare('SELECT month,category_id AS categoryId,amount FROM monthly_budgets ORDER BY month,category_id').all().map(row => [`${row.month}:${row.categoryId}`, row.amount]));
        await update(state);
        state.revision = (Number.isSafeInteger(state.revision) ? state.revision : 0) + 1;
        writeTransactionSubset(state, uniqueIds);
        return state;
      });
      writes = operation.catch(() => {});
      return operation;
    },
    async importLegacyState(state, checksum) {
      validateState(state);
      return importLegacy(state, checksum);
    },
    async close() { db.close(); }
  });
}

export async function createSqliteRepositoryAt(path) {
  return createSqliteRepository(await openLedgerDatabase(path));
}

export const SQLITE_SCHEMA_VERSION = MIGRATION_VERSION;
