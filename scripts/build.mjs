import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const [server, client, css] = await Promise.all(['worker/index.js','ui/browser.js','ui/styles.css'].map(p => readFile(resolve(root,p),'utf8')));
let buildId = process.env.LEDGER_BUILD_ID;
if (!buildId) {
  try { buildId = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { buildId = 'unversioned'; }
}
if (!/^[A-Za-z0-9._-]{1,80}$/.test(buildId)) throw new Error('LEDGER_BUILD_ID must be a short safe identifier.');
await rm(resolve(root,'dist'),{recursive:true,force:true});
await mkdir(resolve(root,'dist/server'),{recursive:true});
await writeFile(resolve(root,'dist/server/index.js'),server+'\nconst BUILD_ID = '+JSON.stringify(buildId)+';\nconst STYLES = '+JSON.stringify(css)+';\n'+client);
console.log('Built standalone Ledger application.');
