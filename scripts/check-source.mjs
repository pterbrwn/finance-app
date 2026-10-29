import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
async function git(args) {
  try { return (await run('git', args, { encoding: 'utf8', maxBuffer: 5_000_000 })).stdout; }
  catch { throw new Error('Cannot inspect the Git index. No file content has been logged.'); }
}

// Inspect the current candidate, including modified and new files. File contents
// are never printed, including on failure. The two owner-protected documents
// are excluded before any file read.
const tracked = (await git(['ls-files', '-z'])).split('\0').filter(Boolean);
const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
const paths = [...new Set([...tracked, ...untracked])];
const excludedByPolicy = new Set(['docs/IMPLEMENTATION_PROGRESS.md', 'docs/STABILITY_REVIEW_2026-10-27.md']);
const forbidden = /(^|\/)(?:\.env[^/]*|\.openai|\.sites-runtime|\.wrangler|data|backups|imports|exports|outputs|node_modules|dist)(\/|$)|(?:^|\/)(?:state\.json(?:\..*)?|config\.json|config\.local\.[^/]+)$|^docs\/FINANCE_APP_(?:EXECUTION_PLAN|REVIEW|COMPLETION_PLAN)\.md$|\.(?:csv|tsv|ofx|qfx|qif|db(?:-.*)?|sqlite[^/]*|pem|key|p12|pfx|log|zip|gz)$/i;
const secret = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{25,}|(?:AKIA|ASIA)[A-Z0-9]{16}|access-(?:sandbox|production)-[a-z0-9-]{20,}/;
let invalid = false;
for (const path of paths) {
  if (excludedByPolicy.has(path)) continue;
  if (forbidden.test(path)) {
    console.error('Private/generated file is staged: ' + path); invalid = true; continue;
  }
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch { console.error('Candidate source file could not be read: ' + path); invalid = true; continue; }
  if (secret.test(text)) { console.error('Potential secret in candidate file: ' + path); invalid = true; }
  if (path === 'config.example.json') {
    const sample = JSON.parse(text);
    if (sample.enablePlaid !== false || Object.entries(sample).some(([key,value]) => key !== 'enablePlaid' && key !== 'plaidEnv' && value !== '')) {
      console.error('Example configuration must contain blank values.'); invalid = true;
    }
  }
}
if (invalid) process.exitCode = 1;
else console.log('Source boundary check passed for ' + paths.length + ' permitted candidate files. Run Gitleaks for comprehensive secret scanning.');
