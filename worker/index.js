// The loopback-only Node server supplies the local owner's identity.
const CATEGORIES = ['Housing', 'Groceries', 'Dining', 'Shopping', 'Transport', 'Utilities', 'Health', 'Entertainment', 'Travel', 'Other', 'Income', 'Transfers'];
const STATE_KEY = 'finance/owner-v1.json';
const blankState = () => ({ version: 1, owner: null, items: [], accounts: [], transactions: [], budgets: {}, lastSync: null, lease: null });

export function categoryFor(t) {
  const p = t.personal_finance_category?.primary || '', d = t.personal_finance_category?.detailed || '';
  if (p.startsWith('TRANSFER') || d === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') return 'Transfers';
  if (d === 'LOAN_PAYMENTS_MORTGAGE_PAYMENT') return 'Housing';
  return ({ INCOME: 'Income', RENT_AND_UTILITIES: d === 'RENT_AND_UTILITIES_RENT' ? 'Housing' : 'Utilities', FOOD_AND_DRINK: d.includes('GROCER') ? 'Groceries' : 'Dining', TRANSPORTATION: 'Transport', TRAVEL: 'Travel', MEDICAL: 'Health', PERSONAL_CARE: 'Health', ENTERTAINMENT: 'Entertainment', GENERAL_MERCHANDISE: 'Shopping', HOME_IMPROVEMENT: 'Housing' })[p] || 'Other';
}
export function fromPlaid(t, itemId) {
  if (!Number.isFinite(t.amount)) throw new Error('Invalid transaction amount');
  return { id: t.transaction_id, itemId, accountId: t.account_id, date: t.date, merchant: t.merchant_name || t.name || 'Transaction', amount: Math.round(t.amount * 100), category: categoryFor(t), pending: !!t.pending, currency: t.iso_currency_code || t.unofficial_currency_code || 'UNKNOWN' };
}
export function totals(rows) {
  return rows.filter(t => !t.pending && t.currency === 'USD').reduce((s, t) => {
    const c = t.override || t.category;
    if (c === 'Income') s.income -= t.amount;
    else if (c !== 'Transfers') { s.spend += t.amount; s.categories[c] = (s.categories[c] || 0) + t.amount; }
    return s;
  }, { income: 0, spend: 0, categories: {} });
}
export function applyChanges(state, itemId, added, modified, removed) {
  const map = new Map(state.transactions.map(t => [t.id, t]));
  // Capture pending overrides before removed records disappear in this same batch.
  const overrides = new Map(state.transactions.filter(t => t.override).map(t => [t.id, t.override]));
  for (const t of removed) map.delete(t.transaction_id);
  for (const t of [...added, ...modified]) {
    const override = overrides.get(t.transaction_id) || overrides.get(t.pending_transaction_id);
    map.set(t.transaction_id, { ...fromPlaid(t, itemId), ...(override ? { override } : {}) });
    if (t.pending_transaction_id && t.pending_transaction_id !== t.transaction_id) map.delete(t.pending_transaction_id);
  }
  state.transactions = [...map.values()];
}
const apiError = (message, status = 400) => Object.assign(new Error(message), { status });
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
function ready(env) { return !env.LOCAL_ONLY && !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET && env.TOKEN_ENCRYPTION_KEY && ['sandbox', 'production'].includes(env.PLAID_ENV)); }
async function readState(env) {
  if (!env.BUCKET) throw apiError('Storage is unavailable. Please try again later.', 503);
  const object = await env.BUCKET.get(STATE_KEY);
  return { state: object ? await object.json() : blankState(), etag: object?.etag };
}
async function mutate(env, update) {
  for (let n = 0; n < 4; n++) {
    const { state, etag } = await readState(env);
    await update(state);
    const saved = await env.BUCKET.put(STATE_KEY, JSON.stringify(state), { onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    if (saved) return state;
  }
  throw apiError('Another update is in progress. Please try again.', 409);
}
async function body(request) {
  const text = await request.text();
  if (text.length > 2_000_000) throw apiError('This upload is too large.', 413);
  try { return JSON.parse(text); } catch { throw apiError('Invalid request.'); }
}
async function plaid(env, path, params) {
  if (!ready(env)) throw apiError('Bank connections need setup. See the Banks page.', 503);
  const result = await fetch(`https://${env.PLAID_ENV}.plaid.com${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Plaid-Version': '2020-09-14' }, body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...params }), signal: AbortSignal.timeout(25000) });
  const data = await result.json();
  if (!result.ok) {
    const error = apiError(data.error_code === 'ITEM_LOGIN_REQUIRED' ? 'Reconnect this bank to resume updates.' : 'The bank connection could not be updated. Please try again later.', 502);
    error.plaidCode = data.error_code; throw error;
  }
  return data;
}
async function tokenKey(env) {
  let bytes;
  try { bytes = Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY), c => c.charCodeAt(0)); } catch { throw apiError('Bank encryption needs setup.', 503); }
  if (bytes.length !== 32) throw apiError('Bank encryption needs setup.', 503);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export function parseCSV(text) {
  const rows = []; let row = [], value = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(value); value = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { row.push(value); if (row.some(v => v.trim())) rows.push(row); row = []; value = ''; if (c === '\r' && text[i+1] === '\n') i++; }
    else value += c;
  }
  if (quoted) throw apiError('A quoted CSV field is not closed.');
  row.push(value); if (row.some(v => v.trim())) rows.push(row);
  if (rows.length < 2) throw apiError('Add a header row and at least one transaction.');
  const header = rows.shift().map(v => v.trim().toLowerCase());
  for (const name of ['date','merchant','amount']) if (!header.includes(name)) throw apiError('Required CSV columns: Date, Merchant, Amount.');
  if (new Set(header).size !== header.length) throw apiError('CSV column names must be unique.');
  if (rows.length > 5000) throw apiError('Import up to 5,000 transactions at a time.');
  return rows.map((values, index) => {
    const get = key => (values[header.indexOf(key)] || '').trim();
    const date = get('date'), merchant = get('merchant'), amount = get('amount'), category = get('category') || 'Other';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date+'T12:00:00Z').toISOString().slice(0,10) !== date) throw apiError('Invalid YYYY-MM-DD date at CSV row '+(index+2)+'.');
    if (!merchant || merchant.length > 300) throw apiError('Invalid merchant at CSV row '+(index+2)+'.');
    if (!/^-?\d{1,9}(\.\d{1,2})?$/.test(amount)) throw apiError('Use a plain amount with up to two decimal places at CSV row '+(index+2)+'.');
    if (!CATEGORIES.includes(category)) throw apiError('Unknown category at CSV row '+(index+2)+'. Use Other or a dashboard category.');
    if (get('currency') && get('currency') !== 'USD') throw apiError('CSV import currently supports USD only.');
    const status = get('status').toLowerCase();
    if (status && !['pending','posted'].includes(status)) throw apiError('Use Posted or Pending status at CSV row '+(index+2)+'.');
    return { date, merchant, amount: Math.round(Number(amount)*100), category, pending: status === 'pending', currency: 'USD' };
  });
}
async function hash(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2,'0')).join(''); }
async function encryptToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv: base64(iv), data: base64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tokenKey(env), new TextEncoder().encode(token))) };
}
async function decryptToken(env, value) {
  const decode = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv) }, await tokenKey(env), decode(value.data)));
}
async function syncBanks(env) {
  const leaseId = crypto.randomUUID();
  const acquired = await mutate(env, s => {
    if (!s.items.length) throw apiError('Connect a bank before syncing.');
    if (s.lease && s.lease.expiresAt > Date.now()) throw apiError('A bank sync is already running.', 409);
    s.lease = { id: leaseId, expiresAt: Date.now() + 5 * 60_000 };
  });
  const failures = [];
  try {
    for (const item of acquired.items) {
      try {
        const access_token = await decryptToken(env, item.token);
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
          let cursor = item.cursor || undefined;
          const pages = [];
          try {
            for (let page = 0; ; page++) {
              if (page >= 100) throw apiError('This bank has more history than one sync can process.', 502);
              const data = await plaid(env, '/transactions/sync', { access_token, ...(cursor ? { cursor } : {}), count: 500 });
              pages.push({ added: data.added, modified: data.modified, removed: data.removed });
              cursor = data.next_cursor;
              if (!data.has_more) break;
            }
            result = { pages, cursor }; break;
          } catch (e) { if (e.plaidCode !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' || attempt === 2) throw e; }
        }
        const accountData = await plaid(env, '/accounts/get', { access_token });
        await mutate(env, s => {
          if (s.lease?.id !== leaseId) throw apiError('Sync was superseded. Please try again.', 409);
          const liveItem = s.items.find(i => i.id === item.id);
          if (!liveItem) return;
          for (const page of result.pages) applyChanges(s, item.id, page.added, page.modified, page.removed);
          liveItem.cursor = result.cursor; liveItem.lastSync = new Date().toISOString(); liveItem.error = null;
          s.accounts = s.accounts.filter(a => a.itemId !== item.id).concat(accountData.accounts.map(a => ({ id: a.account_id, itemId: item.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype, balance: a.balances.current === null ? null : Math.round(a.balances.current * 100), currency: a.balances.iso_currency_code || a.balances.unofficial_currency_code || 'UNKNOWN' })));
        });
      } catch (e) {
        failures.push({ bank: item.name, message: e.status ? e.message : 'Bank update failed. Try again later.' });
        await mutate(env, s => { const i = s.items.find(i => i.id === item.id); if (i) i.error = failures[failures.length - 1].message; });
      }
    }
    await mutate(env, s => { if (!failures.length && s.lease?.id === leaseId) s.lastSync = new Date().toISOString(); });
    return { ok: failures.length === 0, failures };
  } finally { await mutate(env, s => { if (s.lease?.id === leaseId) s.lease = null; }); }
}
function publicState(state, env) {
  return { ...state, owner: undefined, lease: undefined, items: state.items.map(({ token, cursor, ...i }) => i), setup: { localOnly: !!env.LOCAL_ONLY, configured: ready(env), environment: env.PLAID_ENV || 'not configured' } };
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (path === '/' && request.method === 'GET') return new Response(page(), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': ready(env) ? "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.plaid.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.plaid.com; frame-src https://*.plaid.com; connect-src 'self' https://*.plaid.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
      if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
      if (request.method !== 'GET' && request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
      if (request.method === 'POST' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return response({ error: 'Request origin is not allowed.' }, 403);
      const user = request.headers.get('oai-authenticated-user-id');
      if (!user) return response({ error: 'Local owner access is required.' }, 401);
      const { state } = await readState(env);
      if (state.owner && state.owner !== user) return response({ error: 'This dashboard belongs to another account.' }, 403);
      if (['/api/link-token', '/api/exchange-token', '/api/sync', '/api/scheduled-sync', '/api/disconnect'].includes(path) && !ready(env)) return response({ error: 'Bank connections are disabled. Import CSV files for local-only operation.' }, 503);
      if (path === '/api/state' && request.method === 'GET') return response(publicState(state, env));
      if (path === '/api/link-token' && request.method === 'POST') {
        const input = await body(request);
        const params = { user: { client_user_id: user }, client_name: 'Ledger Personal Finance', language: 'en', country_codes: ['US'], ...(env.PLAID_REDIRECT_URI ? { redirect_uri: env.PLAID_REDIRECT_URI } : {}) };
        if (input.itemId) {
          const item = state.items.find(i => i.id === input.itemId);
          if (!item) throw apiError('Bank connection not found.', 404);
          params.access_token = await decryptToken(env, item.token);
        } else { params.products = ['transactions']; params.transactions = { days_requested: 365 }; }
        const data = await plaid(env, '/link/token/create', params);
        return response({ link_token: data.link_token });
      }
      if (path === '/api/exchange-token' && request.method === 'POST') {
        const input = await body(request);
        if (typeof input.public_token !== 'string' || input.public_token.length > 500) throw apiError('Invalid bank authorization.');
        // Validate encryption before consuming the one-time public token.
        await tokenKey(env);
        const data = await plaid(env, '/item/public_token/exchange', { public_token: input.public_token });
        const token = await encryptToken(env, data.access_token);
        await mutate(env, s => {
          if (s.owner && s.owner !== user) throw apiError('Access denied.', 403);
          s.owner = user;
          if (!s.items.some(i => i.id === data.item_id)) s.items.push({ id: data.item_id, name: String(input.name || 'Connected bank').slice(0,100), token, cursor: null, lastSync: null, error: null });
        });
        return response({ connected: true, ...await syncBanks(env) });
      }
      if (['/api/sync', '/api/scheduled-sync'].includes(path) && request.method === 'POST') return response(await syncBanks(env));
      if (path === '/api/category' && request.method === 'POST') {
        const input = await body(request);
        if (!CATEGORIES.includes(input.category)) throw apiError('Choose a valid category.');
        await mutate(env, s => { const t = s.transactions.find(t => t.id === input.id); if (!t) throw apiError('Transaction not found.', 404); t.override = input.category; });
        return response({ ok: true });
      }
      if (path === '/api/import' && request.method === 'POST') {
        const input = await body(request);
        if (typeof input.csv !== 'string' || input.csv.length > 1_000_000 || typeof input.account !== 'string' || !input.account.trim() || input.account.trim().length > 100) throw apiError('Choose a CSV under 1 MB and enter an account name.');
        const transactions = parseCSV(input.csv), name = input.account.trim();
        const accountId = 'csv:' + await hash(name.toLowerCase()), fileId = await hash(accountId+'\n'+input.csv);
        let imported = 0, skipped = 0;
        await mutate(env, s => {
          imported = 0; skipped = 0; s.owner = user;
          if (!s.accounts.some(a => a.id === accountId)) s.accounts.push({ id: accountId, itemId: null, name, mask: null, type: 'manual', subtype: 'CSV import', balance: null, currency: 'USD' });
          const ids = new Set(s.transactions.map(t => t.id));
          transactions.forEach((t,index) => { const id = 'csv:'+fileId+':'+index; if (ids.has(id)) skipped++; else { s.transactions.push({...t,id,accountId,itemId:null}); imported++; } });
        });
        return response({ imported, skipped, month: transactions.map(t => t.date.slice(0,7)).sort().at(-1) });
      }
      if (path === '/api/budget' && request.method === 'POST') {
        const input = await body(request);
        if (!CATEGORIES.includes(input.category) || ['Income','Transfers'].includes(input.category) || !Number.isSafeInteger(input.amount) || input.amount < 0 || input.amount > 100_000_000) throw apiError('Enter a valid monthly budget.');
        await mutate(env, s => { s.owner = user; s.budgets[input.category] = input.amount; });
        return response({ ok: true });
      }
      if (path === '/api/disconnect' && request.method === 'POST') {
        const input = await body(request), item = state.items.find(i => i.id === input.itemId);
        if (!item) throw apiError('Bank connection not found.', 404);
        if (state.lease && state.lease.expiresAt > Date.now()) throw apiError('Wait for the current sync to finish before disconnecting.', 409);
        await plaid(env, '/item/remove', { access_token: await decryptToken(env, item.token) });
        await mutate(env, s => { s.items = s.items.filter(i => i.id !== item.id); s.accounts = s.accounts.filter(a => a.itemId !== item.id); s.transactions = s.transactions.filter(t => t.itemId !== item.id); });
        return response({ ok: true });
      }
      return response({ error: 'Not found' }, 404);
    } catch (e) { return response({ error: e.status ? e.message : 'Something went wrong. Please try again.' }, e.status || 500); }
  }
};

function page() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Your spending, beautifully in focus. A private personal finance dashboard."><title>Ledger · Personal finance</title><style>' + STYLES + '</style></head><body><div id="app"></div><div id="toast" role="status" aria-live="polite"></div><script>' + browserApp.toString() + ';browserApp();</script></body></html>';
}
