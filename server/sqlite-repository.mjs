import Database from 'better-sqlite3';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const MIGRATION_VERSION = 1;
const TABLES = ['items', 'accounts', 'transactions', 'holdings'];
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
}

export async function openLedgerDatabase(path) {
  const filename = resolve(path);
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  await chmod(dirname(filename), 0o700);
  const db = new Database(filename, { timeout: 5000 });
  try { await chmod(filename, 0o600); } catch {}
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const migration = await readFile(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8');
  db.exec(migration);
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(MIGRATION_VERSION, new Date().toISOString());
  return db;
}

export function createSqliteRepository(db) {
  let writes = Promise.resolve();
  const statements = {
    meta: db.prepare('SELECT payload_json FROM state_meta WHERE singleton=1'),
    rows: Object.fromEntries(TABLES.map(name => [name, db.prepare(`SELECT payload_json FROM ${name} ORDER BY rowid`)])),
    clear: Object.fromEntries(['transactions', 'holdings', 'accounts', 'items', 'custom_categories', 'budgets'].map(name => [name, db.prepare(`DELETE FROM ${name}`)])),
    putMeta: db.prepare('INSERT INTO state_meta(singleton,payload_json) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET payload_json=excluded.payload_json'),
    putItem: db.prepare('INSERT INTO items(id,payload_json) VALUES(?,?)'),
    putAccount: db.prepare('INSERT INTO accounts(id,item_id,payload_json) VALUES(?,?,?)'),
    putTransaction: db.prepare('INSERT INTO transactions(id,account_id,item_id,payload_json) VALUES(?,?,?,?)'),
    putHolding: db.prepare('INSERT INTO holdings(id,item_id,payload_json) VALUES(?,?,?)'),
    putCategory: db.prepare('INSERT INTO custom_categories(id,name,normalized_name) VALUES(?,?,?)'),
    putBudget: db.prepare('INSERT INTO budgets(category,amount) VALUES(?,?)'),
    findImport: db.prepare('SELECT source_checksum FROM import_batches WHERE source_checksum=?'),
    addImport: db.prepare('INSERT INTO import_batches(source_checksum,schema_version,imported_at,record_counts_json) VALUES(?,?,?,?)')
  };
  function load() {
    const meta = statements.meta.get();
    const state = meta ? parse(meta.payload_json) : { version: 1, owner: null, lastSync: null, lease: null };
    for (const name of TABLES) state[name] = statements.rows[name].all().map(row => parse(row.payload_json));
    state.customCategories = db.prepare('SELECT name FROM custom_categories ORDER BY rowid').all().map(row => row.name);
    state.budgets = Object.fromEntries(db.prepare('SELECT category,amount FROM budgets ORDER BY category').all().map(row => [row.category, row.amount]));
    return state;
  }
  const persist = db.transaction(state => {
    validateState(state);
    for (const name of [...TABLES, 'custom_categories', 'budgets']) statements.clear[name].run();
    const { items = [], accounts = [], transactions = [], holdings = [], customCategories = [], budgets = {}, ...meta } = state;
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
  });
  const importLegacy = db.transaction((state, checksum) => {
    if (statements.findImport.get(checksum)) return { imported: false };
    const count = db.prepare('SELECT (SELECT COUNT(*) FROM items)+(SELECT COUNT(*) FROM accounts)+(SELECT COUNT(*) FROM transactions)+(SELECT COUNT(*) FROM holdings)+(SELECT COUNT(*) FROM budgets)+(SELECT COUNT(*) FROM custom_categories) AS count').get().count;
    if (count) throw new Error('Destination already contains records; refusing to merge an unreviewed import.');
    persist(state);
    const recordCounts = Object.fromEntries([...TABLES, 'customCategories'].map(name => [name, state[name]?.length ?? 0]));
    recordCounts.budgets = Object.keys(state.budgets ?? {}).length;
    statements.addImport.run(checksum, MIGRATION_VERSION, new Date().toISOString(), json(recordCounts));
    return { imported: true, recordCounts };
  });
  return Object.freeze({
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
