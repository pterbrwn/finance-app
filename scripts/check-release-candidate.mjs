import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, cp, lstat, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

const repo = resolve(import.meta.dirname, '..');
const runtime = process.env.LEDGER_NODE_BIN || process.execPath;
assert.match(process.version, /^v24\.22\.1$/);
const protectedPaths = new Set(['docs/IMPLEMENTATION_PROGRESS.md', 'docs/STABILITY_REVIEW_2026-10-27.md']);
const forbidden = /(^|\/)(?:\.git|node_modules|dist|data|backups|imports|exports|outputs)(\/|$)|\.(?:sqlite[^/]*|csv|tsv|ofx|qfx|qif|pem|p12|pfx|zip|gz)$/i;
const root = await mkdtemp(join(tmpdir(), 'ledger-release-candidate-'));
async function makeWritable(path) {
  let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
  await chmod(path, 0o700).catch(() => {});
  for (const entry of entries) { const child = join(path, entry.name); if (entry.isDirectory()) await makeWritable(child); else await chmod(child, 0o600).catch(() => {}); }
}
try {
  const source = join(root, 'source'), releaseRoot = join(root, 'releases');
  await mkdir(source, { mode: 0o700 }); await mkdir(releaseRoot, { mode: 0o700 });
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo }).toString().split('\0').filter(Boolean);
  for (const path of [...new Set(paths)].sort()) {
    if (protectedPaths.has(path) || forbidden.test(path)) continue;
    const input = join(repo, path), output = join(source, path);
    let info; try { info = await lstat(input); } catch { continue; }
    if (info.isSymbolicLink()) throw new Error(`Candidate contains an unsupported symlink: ${path}`);
    if (info.isDirectory()) continue;
    await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await cp(input, output);
  }
  const git = args => { const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(['init', '--quiet']); git(['config', 'user.name', 'Synthetic Release Test']); git(['config', 'user.email', 'synthetic-release@example.test']);
  git(['add', '-A']); git(['commit', '--quiet', '-m', 'Synthetic candidate for release checks']);
  const releaseId = git(['rev-parse', '--short=12', 'HEAD']);
  const prepared = spawnSync('bash', [join(source, 'scripts/prepare-release.sh'), releaseId], {
    cwd: source, encoding: 'utf8', timeout: 600_000,
    env: { ...process.env, HOME: root, LEDGER_NODE_BIN: runtime, LEDGER_RELEASE_ROOT: releaseRoot }
  });
  assert.equal(prepared.error, undefined, `release preparation timed out or failed to spawn: ${prepared.error?.message}`);
  assert.equal(prepared.status, 0, `immutable release preparation failed: ${prepared.stderr}\n${prepared.stdout}`);
  const release = join(releaseRoot, releaseId);
  const metadata=JSON.parse(await readFile(join(release,'release.json'),'utf8'));
  assert.equal(metadata.commit.startsWith(releaseId),true,'immutable package records the synthetic candidate commit');
  for(const file of ['scripts/encrypted-backup.mjs','scripts/portable-export.mjs','shared/categories.mjs','manifest.sha256'])await stat(join(release,file));
  console.log(`Disposable immutable release passed from synthetic candidate ${releaseId}; preparation ran packaged importer, backup, restore, portable export, fail-closed recovery CLI, server health, checksums, and rollback checks.`);
} finally { await makeWritable(root); await rm(root, { recursive: true, force: true }); }
