import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
async function git(args) {
  try { return (await run('git', args, { encoding: 'utf8', maxBuffer: 5_000_000 })).stdout; }
  catch { throw new Error('Cannot inspect the Git index. No file content has been logged.'); }
}

// Inspect committed candidates from Git's index, including files force-added past
// .gitignore. File contents are never printed, including on failure.
const paths = (await git(['ls-files', '-z'])).split('\0').filter(Boolean);
const forbidden = /(^|\/)(?:\.env[^/]*|\.openai|\.sites-runtime|\.wrangler|data|backups|imports|exports|outputs|node_modules|dist)(\/|$)|(?:^|\/)(?:state\.json(?:\..*)?|config\.json|config\.local\.[^/]+)$|^docs\/FINANCE_APP_(?:EXECUTION_PLAN|REVIEW|COMPLETION_PLAN)\.md$|\.(?:csv|tsv|ofx|qfx|qif|db(?:-.*)?|sqlite[^/]*|pem|key|p12|pfx|log|zip|gz)$/i;
const secret = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{25,}|(?:AKIA|ASIA)[A-Z0-9]{16}|access-(?:sandbox|production)-[a-z0-9-]{20,}/;
let invalid = false;
for (const path of paths) {
  if (forbidden.test(path)) {
    console.error('Private/generated file is staged: ' + path); invalid = true; continue;
  }
  const text = await git(['show', ':' + path]);
  if (secret.test(text)) { console.error('Potential secret in staged file: ' + path); invalid = true; }
  if (path === 'config.example.json') {
    const sample = JSON.parse(text);
    if (sample.enablePlaid !== false || Object.entries(sample).some(([key,value]) => key !== 'enablePlaid' && key !== 'plaidEnv' && value !== '')) {
      console.error('Example configuration must contain blank values.'); invalid = true;
    }
  }
}
if (invalid) process.exitCode = 1;
else console.log('Source boundary check passed for ' + paths.length + ' staged files. Run Gitleaks for comprehensive secret scanning.');
