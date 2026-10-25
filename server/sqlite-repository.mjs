import Database from 'better-sqlite3';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const MIGRATION_VERSION = 2;
const TABLES = ['items', 'accounts', 'transactions', 'holdings'];
const MIGRATIONS = [
  { version: 1, file: '001-initial.sql' },
  { version: 2, file: '002-monthly-budgets.sql' }
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
    putAccount: db.prepare('INSERT INTO accounts(id,item_id,payload_json) VALUES(?,?,?)'),
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
  return Object.freeze({
    schemaVersion: MIGRATION_VERSION,
    async read() { return { state: load() }; },
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
