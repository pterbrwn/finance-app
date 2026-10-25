import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

process.umask(0o077);

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || process.argv.length > 4) throw new Error('Usage: node scripts/sqlite-backup.mjs DATABASE [BACKUP_FILE]');
const source = resolve(sourceArg);
await stat(source);
const target = resolve(targetArg || `${source}.backup-${new Date().toISOString().replaceAll(':', '-')}`);
const directory = dirname(target);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
try { await stat(target); throw new Error('Backup destination already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const temporary = `${target}.tmp-${randomUUID()}`;
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(temporary);
} finally {
  db.close();
}
let backup;
try {
  backup = new Database(temporary, { readonly: true, fileMustExist: true });
  const integrity = backup.pragma('integrity_check', { simple: true });
  const foreignKeys = backup.pragma('foreign_key_check');
  if (integrity !== 'ok' || foreignKeys.length) throw new Error('Backup verification failed.');
  backup.close(); backup = null;
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  console.log(JSON.stringify({ ok: true, backup: target, schemaVersion: 1 }));
} catch (error) {
  backup?.close();
  await rm(temporary, { force: true });
  throw error;
}
