import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

assert.match(process.version, /^v24\.22\.1$/, 'browser harness checks use pinned Node.js 24.22.1');
const appRoot = resolve(import.meta.dirname, '..');
const artifactRoot = await mkdtemp(join(tmpdir(), 'ledger-browser-harness-'));
await chmod(artifactRoot, 0o700);
try {
  for (const [caseName, diagnostic] of [
    ['__self-check-pageerror', 'synthetic injected browser page error'],
    ['__self-check-assertion', 'synthetic injected assertion must fail the browser case']
  ]) {
    const result = spawnSync('bash', ['scripts/run-node.sh', 'scripts/check-browser.mjs'], {
      cwd: appRoot,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, BROWSER_CASE: caseName, LEDGER_BROWSER_ARTIFACTS: artifactRoot }
    });
    assert.equal(result.error, undefined, `${caseName} child completes within the harness timeout: ${result.error?.message}`);
    assert.notEqual(result.status, 0, `${caseName} makes the browser runner fail`);
    const output = result.stdout + result.stderr;
    const match = output.match(/Browser case failure artifacts retained at (.+)/);
    assert.ok(match, `${caseName} retains failure artifacts: ${output}`);
    const artifacts = match[1].trim();
    const files = new Set(await readdir(artifacts));
    for (const file of ['failure.png', 'failure.txt', 'requests.json', 'trace.zip']) assert.ok(files.has(file), `${caseName} retains ${file}`);
    const failure = await readFile(join(artifacts, 'failure.txt'), 'utf8');
    assert.ok(failure.includes(diagnostic), `${caseName} metadata records its injected diagnostic`);
    const metadata = await stat(artifacts);
    assert.equal(metadata.mode & 0o077, 0, `${caseName} artifacts remain private`);
  }
  assert.equal((await readdir(artifactRoot)).length, 2, 'each injected failure retains one isolated artifact directory');
  console.log('Browser harness self-check passed: injected page and assertion failures fail promptly and retain private screenshot, trace, console, and request metadata.');
} finally {
  await rm(artifactRoot, { recursive: true, force: true });
}
