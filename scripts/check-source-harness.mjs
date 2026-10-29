import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sentinel = 'SYNTHETIC_SECRET_CANARY_9f4c2b';
const canary = resolve(root, `.candidate-secret-canary-${process.pid}.mjs`);
try {
  const marker = '-----BEGIN ' + 'PRIVATE KEY-----';
  await writeFile(canary, `const synthetic = "${marker} ${sentinel}";\n`, { mode: 0o600, flag: 'wx' });
  const result = spawnSync(process.execPath, ['scripts/check-source.mjs'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.notEqual(result.status, 0, 'working-tree secret canary must fail the source boundary scan');
  const output = result.stdout + result.stderr;
  assert.match(output, /Potential secret in staged file|Potential secret in candidate file/);
  assert.equal(output.includes(sentinel), false, 'the scanner never prints secret contents');
  console.log('Source scan harness passed: an untracked synthetic key canary is detected without exposing its contents.');
} finally { await rm(canary, { force: true }); }
