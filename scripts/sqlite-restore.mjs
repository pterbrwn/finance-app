import Database from 'better-sqlite3';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const [backupArg, destinationArg] = process.argv.slice(2);
if (!backupArg || !destinationArg || process.argv.length !== 4) throw new Error('Usage: node scripts/sqlite-restore.mjs BACKUP_FILE NEW_DATABASE_PATH');
const backupPath = resolve(backupArg);
const destination = resolve(destinationArg);
await stat(backupPath);
try { await stat(destination); throw new Error('Restore destination already exists; choose a new path.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const directory = dirname(destination);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const temporary = `${destination}.restore-${randomUUID()}`;
try {
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    if (backup.pragma('integrity_check', { simple: true }) !== 'ok' || backup.pragma('foreign_key_check').length) throw new Error('Backup failed integrity verification.');
    await backup.backup(temporary);
  } finally { backup.close(); }
  const restored = new Database(temporary, { readonly: true, fileMustExist: true });
  try {
    if (restored.pragma('integrity_check', { simple: true }) !== 'ok' || restored.pragma('foreign_key_check').length) throw new Error('Restored database failed verification.');
  } finally { restored.close(); }
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  console.log(JSON.stringify({ ok: true, restoredTo: destination }));
} catch (error) {
  await rm(temporary, { force: true });
  throw error;
}
