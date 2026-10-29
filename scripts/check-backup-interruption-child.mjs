import { writeFile } from 'node:fs/promises';
import { runScheduledBackup } from './backup-runner.mjs';

const [dataDir, configurationPath, markerPath] = process.argv.slice(2);
if (!dataDir || !configurationPath || !markerPath) throw new Error('Synthetic interruption check requires temporary paths.');
await runScheduledBackup({
  dataDir,
  configurationPath,
  now: () => new Date('2026-11-03T12:00:00.000Z'),
  faultInjection: async stage => {
    if (stage !== 'after_database_snapshot') return;
    await writeFile(markerPath, 'synthetic backup reached interruption point\n', { mode: 0o600, flag: 'wx' });
    await new Promise(() => { setInterval(() => {}, 60_000); });
  }
});
