import { createHash, createDecipheriv } from 'node:crypto';
import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
let sqliteRepositoryModule;
try {
  sqliteRepositoryModule=await import('../server/sqlite-repository.mjs');
} catch(error) {
  if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;
  sqliteRepositoryModule=await import('../dist/server/sqlite-repository.mjs');
}
const { createSqliteRepository, openLedgerDatabase, SQLITE_SCHEMA_VERSION }=sqliteRepositoryModule;

const [sourceArg, destinationArg, configArg] = process.argv.slice(2);
if (!sourceArg || process.argv.length > 5) throw new Error('Usage: node scripts/import-legacy-json.mjs SOURCE_JSON [NEW_DATABASE] [PRIVATE_CONFIG]');
const source = resolve(sourceArg);
const dataDirectory = resolve(process.env.LEDGER_LOCAL_DATA_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'ledger'));
const destination = resolve(destinationArg || join(dataDirectory, 'ledger.sqlite'));
const configPath = resolve(configArg || process.env.LEDGER_CONFIG_FILE || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ledger/config.json'));

function assertPrivate(path, label, details) {
  if ((details.mode & 0o077) !== 0 || details.uid !== process.getuid()) throw new Error(`${label} must belong to this user and have private permissions.`);
}
const sourceInfo = await stat(source);
assertPrivate(source, 'Source JSON', sourceInfo);
let destinationExists = false;
try { await stat(destination); destinationExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
const sourceBytes = await readFile(source);
const checksum = createHash('sha256').update(sourceBytes).digest('hex');
let state;
try { state = JSON.parse(sourceBytes.toString('utf8')); } catch { throw new Error('Source JSON is invalid; no records were imported.'); }
if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Source JSON root is invalid; no records were imported.');
for (const key of ['items','accounts','transactions','holdings']) if (state[key] != null && !Array.isArray(state[key])) throw new Error(`Source ${key} field is invalid; no records were imported.`);
state.items ??= []; state.accounts ??= []; state.transactions ??= []; state.holdings ??= [];
state.customCategories ??= []; state.budgets ??= {};
if (!Array.isArray(state.customCategories) || !state.budgets || typeof state.budgets !== 'object' || Array.isArray(state.budgets)) throw new Error('Source categories or budgets are invalid; no records were imported.');

let config = {};
try {
  const configInfo = await stat(configPath);
  assertPrivate(configPath, 'Private config', configInfo);
  config = JSON.parse(await readFile(configPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Private config is unreadable or invalid; no records were imported.');
}
const tokenItems = state.items.filter(item => item?.token);
if (tokenItems.length) {
  let key;
  try { key = Buffer.from(config.tokenEncryptionKey || '', 'base64'); } catch {}
  if (!key || key.length !== 32) throw new Error('Encrypted bank records require the existing 32-byte key in the private config; no records were imported.');
  try {
    for (const item of tokenItems) {
      if (typeof item.token?.iv !== 'string' || typeof item.token?.data !== 'string') throw new Error('Invalid encrypted token pair.');
      const iv = Buffer.from(item.token.iv, 'base64');
      const encrypted = Buffer.from(item.token.data, 'base64');
      if (iv.length !== 12 || encrypted.length < 17) throw new Error('Invalid encrypted token pair.');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(encrypted.subarray(-16));
      const clear = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
      if (!clear.length) throw new Error('Empty encrypted token.');
    }
  } catch { throw new Error('At least one encrypted bank token failed local verification; no records were imported.'); }
}

await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
await chmod(dirname(destination), 0o700);
let database;
try {
  database = await openLedgerDatabase(destination);
  const stateRepository = createSqliteRepository(database);
  const result = await stateRepository.importLegacyState(state, checksum);
  const integrity = database.pragma('integrity_check', { simple: true });
  const foreignKeys = database.pragma('foreign_key_check');
  if (integrity !== 'ok' || foreignKeys.length) throw new Error('Imported database integrity verification failed.');
  await chmod(destination, 0o600);
  const unknownEnvironmentItems = state.items.filter(item => !item.environment && !item.env).length;
  console.log(JSON.stringify({ ok: true, imported: result.imported, checksum, schemaVersion: SQLITE_SCHEMA_VERSION, recordCounts: result.recordCounts ?? null, verifiedEncryptedTokens: tokenItems.length, environmentUnspecifiedItems: unknownEnvironmentItems }));
  database.close(); database = null;
} catch (error) {
  database?.close();
  if (!destinationExists) {
    await Promise.all([rm(destination, { force: true }), rm(`${destination}-wal`, { force: true }), rm(`${destination}-shm`, { force: true })]);
  }
  throw error;
}
