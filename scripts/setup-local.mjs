import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { configPath, dataDirectory } from './runtime.mjs';

await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
await chmod(dirname(configPath), 0o700);
await chmod(dataDirectory, 0o700);
try {
  await writeFile(configPath, JSON.stringify({
    enablePlaid: process.argv.includes('--enable-plaid'), plaidEnv: 'sandbox', plaidClientId: '', plaidSecret: '',
    tokenEncryptionKey: randomBytes(32).toString('base64'), plaidRedirectUri: '', publicOrigin: '', tailscaleLogin: ''
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created private local configuration. Add credentials before connecting banks.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Preserved existing local configuration and encryption key.');
}
console.log('Configuration: ' + configPath);
console.log('Financial data: ' + dataDirectory);
