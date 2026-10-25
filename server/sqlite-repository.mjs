import Database from 'better-sqlite3';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const MIGRATION_VERSION = 3;
const TABLES = ['items', 'accounts', 'transactions', 'holdings'];
const MIGRATIONS = [
  { version: 1, file: '001-initial.sql' },
  { version: 2, file: '002-monthly-budgets.sql' },
  { version: 3, file: '003-transaction-query-indexes.sql' }
];
const CORE_TABLES = ['schema_migrations','state_meta','items','accounts','transactions','holdings','custom_categories','budgets','import_batches'];
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
      const expectedTables=new Set([...CORE_TABLES,...(currentVersion>=2?['budget_templates','monthly_budgets']:[])]);
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
    for (const entry of MIGRATIONS.filter(migration=>migration.version>currentVersion)) {
      const migration = await readFile(new URL(`./migrations/${entry.file}`, import.meta.url), 'utf8');
      const apply=db.transaction(()=>{
        db.exec(migration);
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(entry.version, new Date().toISOString());
      });
      apply();
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
    clear: Object.fromEntries(['transactions', 'holdings', 'accounts', 'items', 'custom_categories', 'budgets', 'budget_templates', 'monthly_budgets'].map(name => [name, db.prepare(`DELETE FROM ${name}`)])),
    putMeta: db.prepare('INSERT INTO state_meta(singleton,payload_json) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET payload_json=excluded.payload_json'),
    putItem: db.prepare('INSERT INTO items(id,payload_json) VALUES(?,?)'),
    upsertItem: db.prepare(`INSERT INTO items(id,payload_json) VALUES(?,?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`),
    putAccount: db.prepare('INSERT INTO accounts(id,item_id,payload_json) VALUES(?,?,?)'),
    upsertAccount: db.prepare(`INSERT INTO accounts(id,item_id,payload_json) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET item_id=excluded.item_id,payload_json=excluded.payload_json`),
    putTransaction: db.prepare('INSERT INTO transactions(id,account_id,item_id,payload_json) VALUES(?,?,?,?)'),
    putHolding: db.prepare('INSERT INTO holdings(id,item_id,payload_json) VALUES(?,?,?)'),
    putCategory: db.prepare('INSERT INTO custom_categories(id,name,normalized_name) VALUES(?,?,?)'),
    putBudget: db.prepare('INSERT INTO budgets(category,amount) VALUES(?,?)'),
    putTemplate: db.prepare('INSERT INTO budget_templates(category_id,effective_from,amount) VALUES(?,?,?)'),
    putMonthlyBudget: db.prepare('INSERT INTO monthly_budgets(month,category_id,amount) VALUES(?,?,?)'),
    findImport: db.prepare('SELECT source_checksum FROM import_batches WHERE source_checksum=?'),
    addImport: db.prepare('INSERT INTO import_batches(source_checksum,schema_version,imported_at,record_counts_json) VALUES(?,?,?,?)')
  };
  function load() {
    const meta = statements.meta.get();
    const state = meta ? parse(meta.payload_json) : { version: 1, owner: null, lastSync: null, lease: null };
    for (const name of TABLES) state[name] = statements.rows[name].all().map(row => parse(row.payload_json));
    state.customCategories = db.prepare('SELECT name FROM custom_categories ORDER BY rowid').all().map(row => row.name);
    state.budgets = Object.fromEntries(db.prepare('SELECT category,amount FROM budgets ORDER BY category').all().map(row => [row.category, row.amount]));
    state.budgetTemplates = db.prepare('SELECT category_id AS categoryId,effective_from AS effectiveFrom,amount FROM budget_templates ORDER BY effective_from,category_id').all();
    state.monthlyBudgets = Object.fromEntries(db.prepare('SELECT month,category_id AS categoryId,amount FROM monthly_budgets ORDER BY month,category_id').all().map(row => [`${row.month}:${row.categoryId}`,row.amount]));
    return state;
  }
  function dashboardState() {
    const metaRow=statements.meta.get();
    const source=metaRow?parse(metaRow.payload_json):{version:1,owner:null,lastSync:null,lease:null};
    const {scenarios,goalAllocationLedger,categoryEditBatches,importBatches,mortgageSnapshots,...meta}=source;
    const state={...meta,lastGoalAllocationUndo:[...(goalAllocationLedger||[])].reverse().find(entry=>!entry.undoneAt)||null,accounts:statements.rows.accounts.all().map(row=>parse(row.payload_json)),items:statements.rows.items.all().map(row=>{const {token,cursor,...item}=parse(row.payload_json);return item;}),holdings:statements.rows.holdings.all().map(row=>parse(row.payload_json))};
    state.goalAllocations=(state.goalAllocations||[]).filter(allocation=>allocation.active!==false);
    state.balanceSheetSnapshots=(state.balanceSheetSnapshots||[]).slice(-12);
    state.customCategories=db.prepare('SELECT name FROM custom_categories ORDER BY rowid').all().map(row=>row.name);
    state.budgets=Object.fromEntries(db.prepare('SELECT category,amount FROM budgets ORDER BY category').all().map(row=>[row.category,row.amount]));
    state.budgetTemplates=db.prepare('SELECT category_id AS categoryId,effective_from AS effectiveFrom,amount FROM budget_templates ORDER BY effective_from,category_id').all();
    state.monthlyBudgets=Object.fromEntries(db.prepare('SELECT month,category_id AS categoryId,amount FROM monthly_budgets ORDER BY month,category_id').all().map(row=>[`${row.month}:${row.categoryId}`,row.amount]));
    state.transactionCount=db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count;
    state.transactionMonths=db.prepare("SELECT DISTINCT substr(json_extract(payload_json,'$.date'),1,7) AS month FROM transactions WHERE json_extract(payload_json,'$.date') IS NOT NULL ORDER BY month DESC").all().map(row=>row.month);
    return state;
  }
  function queryTransactionPage({page=1,limit=50,search='',category='',accountId='',from='',to='',review=false}={}) {
    const clauses=[],values=[];
    if(search){clauses.push("instr(ledger_casefold(json_extract(payload_json,'$.merchant')) ,?)>0");values.push(search.toLocaleLowerCase('en-US'));}
    if(category){clauses.push("(json_extract(payload_json,'$.overrideCategoryId')=? OR json_extract(payload_json,'$.override')=? OR json_extract(payload_json,'$.category')=?)");values.push(category,category,category);}
    if(accountId){clauses.push('account_id=?');values.push(accountId);}
    if(from){clauses.push("json_extract(payload_json,'$.date')>=?");values.push(from);}
    if(to){clauses.push("json_extract(payload_json,'$.date')<=?");values.push(to);}
    if(review)clauses.push("(json_extract(payload_json,'$.review')=1 OR (json_type(payload_json,'$.confidence') IS NOT NULL AND CAST(json_extract(payload_json,'$.confidence') AS REAL)<0.5) OR coalesce(json_extract(payload_json,'$.override'),json_extract(payload_json,'$.category'))='Other')");
    const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
    const total=db.prepare(`SELECT COUNT(*) AS count FROM transactions ${where}`).get(...values).count;
    const transactions=db.prepare(`SELECT payload_json FROM transactions ${where} ORDER BY json_extract(payload_json,'$.date') DESC,id ASC LIMIT ? OFFSET ?`).all(...values,limit,(page-1)*limit).map(row=>parse(row.payload_json));
    const revision=db.prepare("SELECT coalesce(json_extract(payload_json,'$.revision'),0) AS revision FROM state_meta WHERE singleton=1").get()?.revision||0;
    return {page,limit,total,transactions,revision};
  }
  function monthSummary(month) {
    const start=`${month}-01`,monthDate=new Date(`${start}T12:00:00Z`),previousDate=new Date(Date.UTC(monthDate.getUTCFullYear(),monthDate.getUTCMonth()-1,1));
    const previous=`${previousDate.getUTCFullYear()}-${String(previousDate.getUTCMonth()+1).padStart(2,'0')}`;
    const nextDate=new Date(Date.UTC(monthDate.getUTCFullYear(),monthDate.getUTCMonth()+1,1));
    const end=new Date(nextDate.getTime()-86400000).toISOString().slice(0,10);
    const previousEnd=new Date(monthDate.getTime()-86400000).toISOString().slice(0,10);
    const from=`${previous}-01`;
    const category="coalesce(json_extract(payload_json,'$.override'),json_extract(payload_json,'$.category'))";
    const eligible="json_extract(payload_json,'$.pending') IS NOT 1 AND json_extract(payload_json,'$.currency')='USD'";
    const rows=db.prepare(`SELECT ${category} AS category,
      SUM(CASE WHEN ${eligible} AND ${category} NOT IN ('Income','Transfers') THEN json_extract(payload_json,'$.amount') ELSE 0 END) AS spend,
      SUM(CASE WHEN ${eligible} AND ${category}='Income' THEN -json_extract(payload_json,'$.amount') ELSE 0 END) AS income,
      SUM(CASE WHEN ${eligible} AND ${category} NOT IN ('Income','Transfers') AND json_extract(payload_json,'$.amount')>0 THEN 1 ELSE 0 END) AS purchases,
      substr(json_extract(payload_json,'$.date'),1,7) AS month
      FROM transactions WHERE json_extract(payload_json,'$.date') BETWEEN ? AND ? GROUP BY month,category`).all(from,end);
    const summarize=key=>{
      const categories={};let spend=0,income=0,purchases=0;
      for(const row of rows){if(row.month!==key)continue;if(row.category==='Income')income+=row.income||0;else if(row.category!=='Transfers'){const amount=row.spend||0;spend+=amount;purchases+=row.purchases||0;if(amount)categories[row.category||'Other']=(categories[row.category||'Other']||0)+amount;}}
      const weekly=db.prepare(`SELECT min(4,CAST((CAST(substr(json_extract(payload_json,'$.date'),9,2) AS INTEGER)-1)/7 AS INTEGER)) AS week,
        SUM(CASE WHEN ${eligible} AND ${category} NOT IN ('Income','Transfers') THEN json_extract(payload_json,'$.amount') ELSE 0 END) AS amount
        FROM transactions WHERE json_extract(payload_json,'$.date') BETWEEN ? AND ? GROUP BY week`).all(`${key}-01`,key===month?end:previousEnd);
      const weeklySpend=[0,0,0,0,0];for(const row of weekly)weeklySpend[row.week]=row.amount||0;
      return{spend,income,purchases,categories,weeklySpend};
    };
    const recent=db.prepare("SELECT payload_json FROM transactions WHERE json_extract(payload_json,'$.date') BETWEEN ? AND ? ORDER BY json_extract(payload_json,'$.date') DESC,json_extract(payload_json,'$.merchant') ASC,id ASC LIMIT 6").all(start,end).map(row=>parse(row.payload_json));
    const transactionCount=db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE json_extract(payload_json,'$.date') BETWEEN ? AND ?").get(start,end).count;
    return{month,previousMonth:previous,current:summarize(month),previous:summarize(previous),recent,transactionCount};
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
    for (const name of [...TABLES, 'custom_categories', 'budgets', 'budget_templates', 'monthly_budgets']) statements.clear[name].run();
    const { items = [], accounts = [], transactions = [], holdings = [], customCategories = [], budgets = {}, budgetTemplates = [], monthlyBudgets = {}, ...meta } = state;
    statements.putMeta.run(json(meta));
    for (const row of items) statements.putItem.run(row.id, json(row));
    for (const row of accounts) statements.putAccount.run(row.id, row.itemId ?? null, json(row));
    for (const row of transactions) statements.putTransaction.run(row.id, row.accountId ?? null, row.itemId ?? null, json(row));
    for (const [index, row] of holdings.entries()) statements.putHolding.run(row.id || `legacy-holding-${index}`, row.itemId ?? null, json(row));
    for (const [index, category] of customCategories.entries()) {
      if (typeof category !== 'string' || !category.trim()) throw new Error('Invalid custom category.');
      const name = category.trim();
      const id = `legacy-category-${createHash('sha256').update(name.toLocaleLowerCase('en-US')).digest('hex').slice(0, 32)}`;
      statements.putCategory.run(id, name, name.toLocaleLowerCase('en-US'));
    }
    for (const [category, amount] of Object.entries(budgets)) statements.putBudget.run(category, amount);
    for (const template of budgetTemplates) statements.putTemplate.run(template.categoryId, template.effectiveFrom, template.amount);
    for (const [key, amount] of Object.entries(monthlyBudgets)) { const month=key.slice(0,7), categoryId=key.slice(8); statements.putMonthlyBudget.run(month, categoryId, amount); }
  });
  const importLegacy = db.transaction((state, checksum) => {
    if (statements.findImport.get(checksum)) return { imported: false };
    const count = db.prepare('SELECT (SELECT COUNT(*) FROM state_meta)+(SELECT COUNT(*) FROM items)+(SELECT COUNT(*) FROM accounts)+(SELECT COUNT(*) FROM transactions)+(SELECT COUNT(*) FROM holdings)+(SELECT COUNT(*) FROM budgets)+(SELECT COUNT(*) FROM custom_categories)+(SELECT COUNT(*) FROM budget_templates)+(SELECT COUNT(*) FROM monthly_budgets)+(SELECT COUNT(*) FROM import_batches) AS count').get().count;
    if (count) throw new Error('Destination already contains records; refusing to merge an unreviewed import.');
    persist(state);
    const recordCounts = Object.fromEntries([...TABLES, 'customCategories'].map(name => [name, state[name]?.length ?? 0]));
    recordCounts.budgets = Object.keys(state.budgets ?? {}).length;
    statements.addImport.run(checksum, MIGRATION_VERSION, new Date().toISOString(), json(recordCounts));
    return { imported: true, recordCounts };
  });
  const writeTransactionSubset = db.transaction((state, ids) => {
    validateState({ ...state, items: [], accounts: [], holdings: [], transactions: state.transactions || [], budgets: {} });
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
    const { transactions, items, accounts, holdings, _deleteAccountIds, customCategories, budgets, budgetTemplates, monthlyBudgets, ...meta } = state;
    statements.putMeta.run(json(meta));
  });
  return Object.freeze({
    schemaVersion: MIGRATION_VERSION,
    async read() { return { state: load() }; },
    async readDashboard() { return {state:dashboardState()}; },
    async readIdentity() { return ownerIdentity(); },
    async readSyncJob() { return syncJobState(); },
    async queryTransactions(query) { return queryTransactionPage(query); },
    async queryMonthSummary(month) { return monthSummary(month); },
    async readScenarios() { return scenarioDetails(); },
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
        state.customCategories = db.prepare('SELECT name FROM custom_categories ORDER BY rowid').all().map(row => row.name);
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
