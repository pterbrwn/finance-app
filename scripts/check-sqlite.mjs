import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { createSqliteRepository, createSqliteRepositoryAt, openLedgerDatabase, SQLITE_SCHEMA_VERSION } from '../server/sqlite-repository.mjs';

assert.match(process.version, /^v24\./);
assert.equal(SQLITE_SCHEMA_VERSION, 3);
const directory = await mkdtemp(join(tmpdir(), 'ledger-sqlite-check-'));
try {
  const databasePath = join(directory, 'ledger.sqlite');
  const repository = await createSqliteRepositoryAt(databasePath);
  await repository.mutate(state => {
    state.owner = 'synthetic-owner';
    state.items.push({ id: 'item-1', token: { data: 'synthetic-ciphertext', iv: 'synthetic-iv' }, cursor: 'cursor-x' });
    state.accounts.push({ id: 'account-1', itemId: 'item-1', source: 'provider', balance: 12345 });
    state.transactions.push({ id: 'txn-1', accountId: 'account-1', itemId: 'item-1', date: '2026-01-03', merchant:'Café Étoile', amount: 2500, currency: 'USD', override: 'Travel' });
    state.holdings.push({ id: 'holding-1', itemId: 'item-1', quantity: '1.250' });
    state.customCategories.push('Travel');
    state.budgets.Travel = 40000;
    state.budgetTemplates.push({categoryId:'category-travel',effectiveFrom:'2026-10',amount:40000});
    state.monthlyBudgets['2026-10:category-travel'] = 0;
    state.goals = [{id:'goal-1',name:'Emergency fund',target:500000,allocationHistory:[{id:'allocation-1',amount:12500}]}];
    state.properties = [{id:'property-1',value:32000000,mortgageSnapshots:[{date:'2026-10-01',balance:24000000}]}];
    state.scenarios = [{id:'scenario-1',versions:[{id:'quote-1',inputs:{purchasePrice:40000000},funding:{goalId:'goal-1'}}]}];
    state.balanceSnapshots = [{date:'2026-10-25',assets:51000000}];
    state.importHistory = [{id:'undo-1',transactionIds:['txn-1']}];
    state.syncJobs = [{id:'job-1',status:'interrupted'}];
  });
  const read = (await repository.read()).state;
  assert.equal(read.transactions[0].override, 'Travel');
  assert.equal(read.items[0].token.data, 'synthetic-ciphertext');
  assert.equal(read.accounts[0].balance, 12345);
  assert.equal(read.budgets.Travel, 40000);
  assert.deepEqual(read.budgetTemplates,[{categoryId:'category-travel',effectiveFrom:'2026-10',amount:40000}]);
  assert.equal(read.monthlyBudgets['2026-10:category-travel'],0);
  assert.deepEqual(read.goals,[{id:'goal-1',name:'Emergency fund',target:500000,allocationHistory:[{id:'allocation-1',amount:12500}]}]);
  assert.deepEqual(read.properties,[{id:'property-1',value:32000000,mortgageSnapshots:[{date:'2026-10-01',balance:24000000}]}]);
  assert.deepEqual(read.scenarios,[{id:'scenario-1',versions:[{id:'quote-1',inputs:{purchasePrice:40000000},funding:{goalId:'goal-1'}}]}]);
  assert.deepEqual(read.balanceSnapshots,[{date:'2026-10-25',assets:51000000}]);
  assert.deepEqual(read.importHistory,[{id:'undo-1',transactionIds:['txn-1']}]);
  assert.deepEqual(read.syncJobs,[{id:'job-1',status:'interrupted'}]);
  const dashboardRead=await repository.readDashboard();
  assert.equal(dashboardRead.state.transactionCount,1);
  assert.equal('transactions' in dashboardRead.state,false,'bounded dashboard state omits transaction history');
  assert.equal('scenarios' in dashboardRead.state,false,'bounded dashboard state omits versioned scenario history');
  assert.equal(dashboardRead.state.items[0].token,undefined);
  assert.equal(dashboardRead.state.items[0].cursor,undefined);
  assert.deepEqual((await repository.queryTransactions({page:1,limit:50,category:'Travel',from:'2026-01-01',to:'2026-01-31'})).transactions.map(row=>row.id),['txn-1']);
  assert.deepEqual((await repository.queryTransactions({page:1,limit:50,search:'CAFÉ',from:'2026-01-01',to:'2026-01-31'})).transactions.map(row=>row.id),['txn-1'],'SQLite merchant filtering retains Unicode case-insensitive search');
  const januarySummary=await repository.queryMonthSummary('2026-01');
  assert.equal(januarySummary.current.spend,2500);
  assert.equal(januarySummary.current.categories.Travel,2500);
  assert.equal(januarySummary.current.purchases,1);
  assert.deepEqual(januarySummary.current.weeklySpend,[2500,0,0,0,0]);
  await Promise.all([
    repository.mutate(state => { state.budgets.Dining = 10000; }),
    repository.mutate(state => { state.budgets.Housing = 150000; })
  ]);
  assert.deepEqual({ ...(await repository.read()).state.budgets }, { Travel: 40000, Dining: 10000, Housing: 150000 });
  const subsetRevision=(await repository.read()).state.revision||0;
  await repository.mutateTransactionSubset(['txn-1'],state=>{assert.equal(state.transactions.length,1);assert.equal(state.revision,subsetRevision);state.transactions[0].override='Groceries';});
  const subsetRead=(await repository.read()).state;
  assert.equal(subsetRead.transactions[0].override,'Groceries','scoped transaction writes persist the selected row');
  assert.equal(subsetRead.revision,subsetRevision+1,'scoped transaction writes advance the shared revision');
  await assert.rejects(repository.mutateTransactionSubset(['txn-1'],state=>{state.transactions[0].override='Must Roll Back';throw new Error('synthetic scoped rollback');}),/synthetic scoped rollback/);
  assert.equal((await repository.read()).state.transactions[0].override,'Groceries','failed scoped edits leave the row unchanged');
  assert.equal((await repository.read()).state.revision,subsetRevision+1,'failed scoped edits leave the revision unchanged');
  await repository.mutateTransactionSubset(['txn-1'],state=>{state.transactions[0].override='Travel';});
  await repository.mutate(state=>{state.items.push({id:'sync-item',cursor:'cursor-before',lifecycle:'connected'});});
  const beforeSyncRevision=(await repository.read()).state.revision;
  await repository.mutateTransactionSubset(['sync-added'],state=>{state.items.find(item=>item.id==='sync-item').cursor='cursor-after';state.transactions.push({id:'sync-added',itemId:'sync-item',date:'2026-01-04',merchant:'Synced row',amount:500,currency:'USD'});});
  let syncState=(await repository.read()).state;
  assert.equal(syncState.items.find(item=>item.id==='sync-item').cursor,'cursor-after');
  assert.equal(syncState.transactions.some(transaction=>transaction.id==='sync-added'),true);
  assert.equal(syncState.revision,beforeSyncRevision+1,'sync cursor and transaction share one revision');
  await assert.rejects(repository.mutateTransactionSubset(['sync-added'],state=>{state.items.find(item=>item.id==='sync-item').cursor='cursor-rolled-back';state.transactions[0].amount=999;throw new Error('synthetic cursor rollback');}),/synthetic cursor rollback/);
  syncState=(await repository.read()).state;
  assert.equal(syncState.items.find(item=>item.id==='sync-item').cursor,'cursor-after','failed sync write retains the prior cursor');
  assert.equal(syncState.transactions.find(transaction=>transaction.id==='sync-added').amount,500,'failed sync write retains the prior transaction');
  await repository.mutateTransactionSubset(['sync-added'],state=>{state.items.find(item=>item.id==='sync-item').cursor='cursor-before';state.transactions=[];});
  await assert.rejects(repository.mutate(state => {
    state.accounts.push({ id: 'orphan-account', itemId: 'missing-item' });
  }));
  assert.equal((await repository.read()).state.accounts.length, 1, 'failed FK writes roll back as a unit');
  await repository.close();

  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name IN ('transactions_date_id_idx','transactions_account_date_id_idx','transactions_item_date_id_idx')").get().count,3,'schema migration creates the date/account/item page indexes');
  db.close();

  const backupPath = join(directory, 'verified.sqlite');
  const backupResult = spawnSync(process.execPath, ['scripts/sqlite-backup.mjs', databasePath, backupPath], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(backupResult.status, 0, backupResult.stderr);
  assert.equal(JSON.parse(backupResult.stdout).ok, true);
  assert.equal(JSON.parse(backupResult.stdout).schemaVersion, 3, 'backup manifest reports the database schema it contains');
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  const restoredPath = join(directory, 'restored.sqlite');
  const restoreResult = spawnSync(process.execPath, ['scripts/sqlite-restore.mjs', backupPath, restoredPath], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(restoreResult.status, 0, restoreResult.stderr);
  const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 1);
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM budget_templates').get().count,1);
  assert.equal(restored.prepare('SELECT amount FROM monthly_budgets').get().amount,0);
  assert.equal(restored.prepare("SELECT json_extract(payload_json, '$.override') AS value FROM transactions").get().value, 'Travel');
  restored.close();

  const importKey = randomBytes(32);
  const tokenIv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', importKey, tokenIv);
  const ciphertext = Buffer.concat([cipher.update('synthetic-access-token'), cipher.final(), cipher.getAuthTag()]);
  const encoded = value => value.toString('base64');
  const legacyPath = join(directory, 'legacy-state.json');
  const configPath = join(directory, 'private-config.json');
  const importedPath = join(directory, 'imported.sqlite');
  await writeFile(legacyPath, JSON.stringify({ version: 1, owner: null, items: [{ id: 'legacy-item', token: { iv: encoded(tokenIv), data: encoded(ciphertext) }, cursor: 'cursor-legacy' }], accounts: [{ id: 'legacy-account', itemId: 'legacy-item' }], transactions: [{ id: 'legacy-transaction', accountId: 'legacy-account', itemId: 'legacy-item', amount: 1, date: '2026-01-01', override: 'Travel' }], budgets: { Travel: 5 } }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ tokenEncryptionKey: encoded(importKey), plaidEnv: 'production' }), { mode: 0o600 });
  await chmod(legacyPath, 0o600); await chmod(configPath, 0o600);
  const importer = ['scripts/import-legacy-json.mjs', legacyPath, importedPath, configPath];
  const firstImport = spawnSync(process.execPath, importer, { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(firstImport.status, 0, firstImport.stderr);
  const firstSummary = JSON.parse(firstImport.stdout);
  assert.equal(firstSummary.verifiedEncryptedTokens, 1);
  assert.equal(firstSummary.environmentUnspecifiedItems, 1, 'deployment environment is not guessed for legacy items');
  assert.equal((await stat(importedPath)).mode & 0o777, 0o600);
  const secondImport = spawnSync(process.execPath, importer, { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(secondImport.status, 0, secondImport.stderr);
  assert.equal(JSON.parse(secondImport.stdout).imported, false, 'same-source reruns are idempotent');
  const importedDb = new Database(importedPath, { readonly: true, fileMustExist: true });
  const importedItem = JSON.parse(importedDb.prepare('SELECT payload_json FROM items').get().payload_json);
  assert.equal(importedItem.environment, undefined);
  assert.equal(importedItem.token.data, encoded(ciphertext));
  assert.equal(importedItem.cursor, 'cursor-legacy');
  assert.equal(importedDb.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 1);
  assert.equal(importedDb.prepare('SELECT amount FROM budgets WHERE category=?').get('Travel').amount, 5);
  importedDb.close();

  const metadataOnlyPath = join(directory, 'metadata-only.sqlite');
  const metadataOnlyDb = await openLedgerDatabase(metadataOnlyPath);
  metadataOnlyDb.prepare('INSERT INTO state_meta(singleton,payload_json) VALUES(1,?)').run(JSON.stringify({version:1,goals:[{id:'preserve-me'}]}));
  const metadataOnlyRepository = createSqliteRepository(metadataOnlyDb);
  await assert.rejects(metadataOnlyRepository.importLegacyState({items:[],accounts:[],transactions:[],holdings:[],budgets:{},customCategories:[]}, 'synthetic-different-source'), /already contains records/);
  assert.deepEqual((await metadataOnlyRepository.read()).state.goals, [{id:'preserve-me'}], 'metadata-only entities prevent an import from overwriting them');
  await metadataOnlyRepository.close();

  const orderingRepository=await createSqliteRepositoryAt(join(directory,'ordering.sqlite'));
  await orderingRepository.mutate(state=>{state.transactions=[{id:'z-last',date:'2026-10-25',merchant:'Same day Z',amount:200,currency:'USD',category:'Dining'},{id:'a-first',date:'2026-10-25',merchant:'Same day A',amount:300,currency:'USD',category:'Dining'},{id:'refund',date:'2026-10-24',merchant:'Refund',amount:-50,currency:'USD',category:'Dining'},{id:'pending',date:'2026-10-24',merchant:'Pending',amount:500,currency:'USD',category:'Dining',pending:true}];});
  const orderedPage=await orderingRepository.queryTransactions({page:1,limit:3,from:'2026-10-01',to:'2026-10-31'});
  assert.deepEqual(orderedPage.transactions.map(row=>row.id),['a-first','z-last','pending'],'same-day transaction pages have stable ID ordering');
  const completeSummary=await orderingRepository.queryMonthSummary('2026-10');
  assert.equal(completeSummary.current.spend,450,'monthly summaries include every matching posted record including refunds and exclude pending rows');
  assert.equal(completeSummary.transactionCount,4);
  await orderingRepository.close();

  const effectiveCategoryRepository=await createSqliteRepositoryAt(join(directory,'effective-category.sqlite'));
  await effectiveCategoryRepository.mutate(state=>{state.transactions=[
    {id:'source-groceries',accountId:'synthetic-checking',date:'2026-10-23',merchant:'Synthetic unchanged groceries',amount:100,currency:'USD',category:'Groceries',categoryId:'system:groceries'},
    {id:'override-dining',accountId:'synthetic-checking',date:'2026-10-25',merchant:'Synthetic overridden dining',amount:200,currency:'USD',category:'Groceries',categoryId:'system:groceries',override:'Dining',overrideCategoryId:'system:dining'},
    {id:'legacy-dining',accountId:'synthetic-checking',date:'2026-10-24',merchant:'Synthetic legacy dining',amount:300,currency:'USD',category:'Groceries',override:'Dining'},
    {id:'empty-override',accountId:'synthetic-checking',date:'2026-10-22',merchant:'Synthetic empty override',amount:400,currency:'USD',category:'Groceries',categoryId:'system:groceries',override:'',overrideCategoryId:'system:dining'},
    {id:'renamed-custom',accountId:'synthetic-checking',date:'2026-10-21',merchant:'Synthetic renamed custom',amount:500,currency:'USD',category:'Old custom name',categoryId:'custom:stable',override:'New custom name',overrideCategoryId:'custom:stable'}
  ];});
  const categoryIds=async(category,options={})=>(await effectiveCategoryRepository.queryTransactions({page:1,limit:50,...options,category})).transactions.map(row=>row.id);
  assert.deepEqual(await categoryIds('Groceries'),['source-groceries','empty-override'],'effective Groceries name excludes rows currently overridden to another category');
  assert.deepEqual(await categoryIds('system:groceries'),['source-groceries','empty-override'],'effective source category ID is used when there is no nonempty override');
  assert.deepEqual(await categoryIds('Dining'),['override-dining','legacy-dining'],'legacy label-only and ID-backed overrides match their displayed category');
  assert.deepEqual(await categoryIds('system:dining'),['override-dining'],'override category IDs do not include source-category matches');
  assert.deepEqual(await categoryIds('Old custom name'),[],'a renamed transaction does not remain under its previous source label');
  assert.deepEqual(await categoryIds('New custom name'),['renamed-custom']);
  assert.deepEqual(await categoryIds('custom:stable'),['renamed-custom'],'renamed custom category identity remains filterable by ID');
  const filteredSecondPage=await effectiveCategoryRepository.queryTransactions({page:2,limit:1,category:'Dining',search:'synthetic',accountId:'synthetic-checking',from:'2026-10-01',to:'2026-10-31'});
  assert.equal(filteredSecondPage.total,2,'filtered total counts only the two effective Dining rows');assert.deepEqual(filteredSecondPage.transactions.map(row=>row.id),['legacy-dining'],'effective category filtering composes with search/account/date filters and paging');
  await effectiveCategoryRepository.close();

  const legacyDatabase=join(directory,'schema-v1.sqlite');
  const oldDb=new Database(legacyDatabase);
  oldDb.exec(await readFile(new URL('../server/migrations/001-initial.sql',import.meta.url),'utf8'));
  oldDb.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)').run(new Date().toISOString());
  oldDb.close();
  const migrated=await openLedgerDatabase(legacyDatabase);
  assert.equal(migrated.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,3);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='monthly_budgets'").get().count,1);
  migrated.close();
  const migrationBackupDirectory=join(directory,'backups');
  const migrationBackups=(await readdir(migrationBackupDirectory)).filter(name=>name.endsWith('.sqlite'));
  assert.equal(migrationBackups.length,1);
  assert.equal((await stat(migrationBackupDirectory)).mode & 0o777,0o700);
  const preMigrationBackupPath=join(migrationBackupDirectory,migrationBackups[0]);
  assert.equal((await stat(preMigrationBackupPath)).mode & 0o777,0o600);
  const preMigrationBackup=new Database(preMigrationBackupPath,{readonly:true,fileMustExist:true});
  assert.equal(preMigrationBackup.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(preMigrationBackup.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,1,'backup captured the old schema before applying migration 002');
  preMigrationBackup.close();

  const futureSchemaPath=join(directory,'future-schema.sqlite'),futureSchema=new Database(futureSchemaPath);
  futureSchema.pragma('journal_mode = DELETE');futureSchema.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL); CREATE TABLE future_data(value TEXT);');
  futureSchema.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(4,?)').run(new Date().toISOString());futureSchema.prepare('INSERT INTO future_data(value) VALUES(?)').run('preserved');futureSchema.close();
  await assert.rejects(openLedgerDatabase(futureSchemaPath),/newer than this application supports/);
  const afterFutureRefusal=new Database(futureSchemaPath,{readonly:true,fileMustExist:true});assert.equal(afterFutureRefusal.pragma('journal_mode',{simple:true}),'delete','future-schema refusal does not change the database journal mode');assert.equal(afterFutureRefusal.prepare('SELECT value FROM future_data').get().value,'preserved');afterFutureRefusal.close();

  const invalidHistoryPath=join(directory,'invalid-history.sqlite'),invalidHistory=new Database(invalidHistoryPath);
  invalidHistory.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);');invalidHistory.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)').run(new Date().toISOString());invalidHistory.close();
  await assert.rejects(openLedgerDatabase(invalidHistoryPath),/migration history is inconsistent/);
  const unversionedPath=join(directory,'unversioned.sqlite'),unversioned=new Database(unversionedPath);unversioned.exec('CREATE TABLE unrelated(value TEXT);');unversioned.close();
  await assert.rejects(openLedgerDatabase(unversionedPath),/without migration history/);

  const rollbackPath=join(directory,'atomic-migration.sqlite'),rollbackDb=new Database(rollbackPath);
  rollbackDb.exec(await readFile(new URL('../server/migrations/001-initial.sql',import.meta.url),'utf8'));
  rollbackDb.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)').run(new Date().toISOString());
  rollbackDb.exec("CREATE TRIGGER block_schema_v2 BEFORE INSERT ON schema_migrations WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'synthetic migration interruption'); END;");rollbackDb.close();
  await assert.rejects(openLedgerDatabase(rollbackPath),/synthetic migration interruption/);
  const rolledBack=new Database(rollbackPath,{readonly:true,fileMustExist:true});assert.equal(rolledBack.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='monthly_budgets'").get().count,0,'failed DDL is rolled back with its migration version');assert.equal(rolledBack.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,1);rolledBack.close();

  console.log('SQLite ARM64 runtime, constraints, import preservation/idempotency, schema compatibility, atomic migration, automatic migration backup, backup and restore passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
