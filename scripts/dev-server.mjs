import { createServer } from 'node:http';
import { webcrypto } from 'node:crypto';
import { localRuntime } from './runtime.mjs';
import worker from '../dist/server/index.js';

if (process.env.LEDGER_WRITER_LOCKED !== '1') throw new Error('Start Ledger through scripts/start-ledger.sh to acquire the data-directory lock.');
globalThis.crypto ||= webcrypto;
const env = await localRuntime();

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
let origin;
const server = createServer(async (incoming, outgoing) => {
  const reject = (status, message) => {
    outgoing.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    outgoing.end(JSON.stringify({ error: message }));
  };
  // This adapter supplies a local identity. Keep it loopback-only and reject
  // alternate Host values so a forwarded port cannot be used via DNS rebinding.
  const host = incoming.headers.host;
  const proxied = !!(incoming.headers['tailscale-user-login'] || incoming.headers['x-forwarded-for'] || incoming.headers['x-forwarded-proto'] || (env.publicOrigin && host === new URL(env.publicOrigin).host));
  if (host !== new URL(origin).host && (!env.publicOrigin || host !== new URL(env.publicOrigin).host)) {
    incoming.resume();
    reject(403, 'Open the dashboard using its printed local URL.');
    return;
  }
  if (proxied && (!env.publicOrigin || incoming.headers['tailscale-user-login'] !== env.tailscaleLogin)) {
    incoming.resume();
    reject(403, 'Connect with the authorized Tailscale account.');
    return;
  }
  if (!incoming.url.startsWith('/') || incoming.url.startsWith('//')) {
    incoming.resume();
    reject(400, 'Invalid request path.');
    return;
  }
  // Permit opening the dashboard from an external link or OAuth redirect. Its
  // API requests originate from the dashboard; cross-site API calls stay blocked.
  const navigation = incoming.method === 'GET' && incoming.url.split('?')[0] === '/' && incoming.headers['sec-fetch-mode'] === 'navigate' && incoming.headers['sec-fetch-dest'] === 'document';
  if (incoming.headers['sec-fetch-site'] === 'cross-site' && !navigation) {
    incoming.resume();
    reject(403, 'Cross-site requests are not allowed.');
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(413, 'This upload is too large.');
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('oai-authenticated-user-id', 'local-owner');
    const method = incoming.method;
    const request = new Request((proxied ? env.publicOrigin : origin) + incoming.url, {
      method, headers,
      ...(!['GET', 'HEAD'].includes(method) ? { body: Buffer.concat(chunks) } : {})
    });
    const response = await worker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) reject(500, 'The local server could not handle this request.');
    else outgoing.end();
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Port is in use. Choose another with PORT=3001 npm run dev.' : 'Could not start the local server: ' + error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  origin = 'http://127.0.0.1:' + server.address().port;
  console.log('Ledger: ' + origin);
  console.log(env.LOCAL_ONLY ? 'Local-only mode. CSV imports are available; external bank connections are disabled.' : 'Bank integration enabled. Financial records are stored on this machine.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
