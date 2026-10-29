import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, cp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableBrowserCases } from './browser-cases.mjs';

const root = resolve(import.meta.dirname, '..');
const profile = process.argv[2];
const node = process.env.LEDGER_NODE_BIN || process.execPath;
assert.match(process.version, /^v24\.22\.1$/, 'profiles require pinned Node 24.22.1');
const scripts = {
  fast: ['scripts/validate-artifact.mjs', 'scripts/check-finance.mjs', 'scripts/check-budget.mjs', 'scripts/check-statement-reconciliation.mjs', 'scripts/check-transaction-splits.mjs', 'scripts/check-commitments.mjs'],
  integration: ['scripts/check-dev.mjs', 'scripts/check-sqlite.mjs', 'scripts/check-backup.mjs', 'scripts/check-runtime-status.mjs', 'scripts/check-portable-export.mjs'],
  browser: ['scripts/check-browser.mjs', 'scripts/check-browser-harness.mjs'],
  recovery: ['scripts/check-backup.mjs', 'scripts/check-encrypted-backup.mjs'],
  release: ['scripts/check-source.mjs', 'scripts/check-source-harness.mjs', 'scripts/check-release-candidate.mjs'],
  extended: ['scripts/measure-performance.mjs', 'scripts/measure-operation-storage.mjs']
};
assert.ok(Object.hasOwn(scripts, profile), `Unknown test profile ${profile}`);

const protectedPaths = new Set(['docs/IMPLEMENTATION_PROGRESS.md', 'docs/STABILITY_REVIEW_2026-10-27.md']);
const excludedPath = /(^|\/)(?:\.git|node_modules|dist|data|backups|imports|exports|outputs)(\/|$)|\.(?:sqlite[^/]*|csv|tsv|ofx|qfx|qif|pem|p12|pfx|zip|gz)$/i;
function candidateIdentity() {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  const hash = createHash('sha256');
  const included = [];
  for (const name of [...new Set(names)].sort()) {
    if (protectedPaths.has(name) || excludedPath.test(name)) continue;
    try { const bytes = readFileSync(join(root, name)); hash.update(name).update('\0').update(bytes).update('\0'); included.push(name); }
    catch { /* removed tracked paths are represented in git status, not read */ }
  }
  return { sha256: hash.digest('hex'), fileCount: included.length };
}

const temp = await mkdtemp(join(tmpdir(), 'ledger-test-profile-'));
await chmod(temp, 0o700);
const initialCandidate = candidateIdentity();
const report = { profile, startedAt: new Date().toISOString(), runtime: process.version, candidate: initialCandidate, suites: [], browserCases: [], status: 'PASS' };
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LEDGER_|PLAID_|TWS_|BROWSER_CASE$)/.test(key)));
Object.assign(cleanEnv, { PATH: process.env.PATH, HOME: temp, TMPDIR: temp, LEDGER_NODE_BIN: node, LEDGER_TEST_TMP: temp });
if (process.env.PLAYWRIGHT_BROWSERS_PATH) cleanEnv.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
else cleanEnv.PLAYWRIGHT_BROWSERS_PATH = join(process.env.HOME || '', '.cache', 'ms-playwright');
function run(script, args = [], extra = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(node, [join(root, script), ...args], { cwd: root, env: { ...cleanEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const signalTree = signal => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    const timer = setTimeout(() => { signalTree('SIGTERM'); setTimeout(() => signalTree('SIGKILL'), 5000).unref(); }, 120_000);
    child.once('close', (code, signal) => { clearTimeout(timer); resolvePromise({ code: code ?? 1, signal, output }); });
    child.once('error', error => { clearTimeout(timer); resolvePromise({ code: 1, signal: null, output: String(error) }); });
  });
}
try {
  const selected = [...scripts[profile]];
  const build = await run('scripts/build.mjs');
  report.suites.push({ id: 'build', ...build });
  if (build.code !== 0) throw new Error(`build failed: ${build.output.slice(-4000)}`);
  if (profile === 'browser') {
    selected.splice(0, 1);
    const base = await run('scripts/check-browser.mjs');
    report.suites.push({ id: 'browser-acceptance', ...base });
    if (base.code !== 0) {
      for (const name of availableBrowserCases.filter(value => !value.startsWith('__'))) report.browserCases.push({ id: name, status: 'NOT_RUN', reason: 'broad browser acceptance failed' });
    } else for (const name of availableBrowserCases.filter(value => !value.startsWith('__'))) {
      const result = await run('scripts/check-browser.mjs', [], { BROWSER_CASE: name });
      report.browserCases.push({ id: name, status: result.code === 0 ? 'PASS' : (/Executable doesn't exist/i.test(result.output) ? 'BLOCKED' : 'FAIL'), ...result });
    }
  }
  for (const script of selected) {
    const result = script.endsWith('check-dev.mjs') && profile === 'integration'
      ? await run(script, ['--http'])
      : await run(script);
    report.suites.push({ id: script, status: result.code === 0 ? 'PASS' : (/^BLOCKED:|Executable doesn't exist/i.test(result.output) ? 'BLOCKED' : 'FAIL'), ...result });
  }
} catch (error) {
  if (report.status !== 'BLOCKED') report.status = /Executable doesn't exist|Set LEDGER_.*AGE_|spawn age ENOENT/i.test(String(error)) ? 'BLOCKED' : 'FAIL';
  report.error = String(error?.stack || error);
} finally {
  const finalCandidate = candidateIdentity();
  report.candidateAfter = finalCandidate;
  if (finalCandidate.sha256 !== initialCandidate.sha256) {
    report.status = 'FAIL'; report.error = 'Candidate source changed while the test profile was running.';
  }
  report.finishedAt = new Date().toISOString();
  const results = [...report.suites, ...report.browserCases];
  if (report.status === 'PASS' && results.some(result => result.status === 'BLOCKED')) report.status = 'BLOCKED';
  if (report.status === 'PASS' && results.some(result => result.status === 'NOT_RUN' || result.code !== 0)) report.status = 'FAIL';
  if (report.status !== 'PASS') {
    report.artifacts = temp;
    if (process.env.TEST_ARTIFACTS_DIR) {
      const artifactRoot = resolve(process.env.TEST_ARTIFACTS_DIR);
      const destination = join(artifactRoot, `${profile}-${Date.now()}`);
      await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
      await chmod(artifactRoot, 0o700);
      await cp(temp, destination, { recursive: true, errorOnExist: true });
      await chmod(destination, 0o700);
      report.artifacts = destination;
    }
  }
  if (process.env.LEDGER_TEST_REPORT) {
    const destination = resolve(process.env.LEDGER_TEST_REPORT);
    await writeFile(destination, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
  else await rm(temp, { recursive: true, force: true });
}
