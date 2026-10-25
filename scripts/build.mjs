import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const [server, client, css] = await Promise.all(['worker/index.js','ui/browser.js','ui/styles.css'].map(p => readFile(resolve(root,p),'utf8')));
await rm(resolve(root,'dist'),{recursive:true,force:true});
await mkdir(resolve(root,'dist/server'),{recursive:true});
await writeFile(resolve(root,'dist/server/index.js'),server+'\nconst STYLES = '+JSON.stringify(css)+';\n'+client);
console.log('Built standalone Ledger application.');
