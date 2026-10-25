// The loopback-only Node server supplies the local owner's identity.
import { CATEGORIES } from '../shared/categories.mjs';
import { budgetMonthKey, resolveBudget, validMonth } from '../shared/budgets.mjs';
import { cents } from '../shared/money.mjs';
import { accountRecord, investmentHoldings } from '../shared/investments.mjs';
import { categoryFor, fromPlaid, totals } from '../shared/reporting.mjs';
import { applyChanges, applySyncPages } from '../shared/reconciliation.mjs';
import { BUILD_ID, UI_ASSETS } from './generated.mjs';
import { repositoryFor } from '../server/repository.mjs';

export { categoryFor, fromPlaid, totals, applyChanges, applySyncPages, investmentHoldings };

const normalizeCategory = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
const validDateOnly = value => typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
const systemCategories = CATEGORIES.map((name,index) => ({ id: 'system:'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-'), name, normalizedName: normalizeCategory(name), kind: name === 'Income' ? 'income' : name === 'Transfers' ? 'transfer' : 'expense', system: true, order: index, archivedAt: null }));
function categoryCatalog(state) {
  const legacy = (state.customCategories || []).map((value,index) => typeof value === 'string' ? { id:'legacy:'+encodeURIComponent(normalizeCategory(value)), name:value, normalizedName:normalizeCategory(value), kind:'expense', system:false, order:CATEGORIES.length+index, archivedAt:null } : value);
  const known = new Set((state.categoryRecords || []).map(category => category.id));
  const customs = [...(state.categoryRecords || []), ...legacy.filter(category => !known.has(category.id) && !(state.categoryRecords || []).some(existing => existing.normalizedName === category.normalizedName))];
  return [...systemCategories, ...customs].sort((a,b) => a.order-b.order || a.name.localeCompare(b.name));
}
const categories = state => categoryCatalog(state).filter(category => !category.archivedAt).map(category => category.name);
function replaceProviderAccounts(state,itemId,accounts){
  const previous=new Map(state.accounts.filter(a=>a.itemId===itemId).map(a=>[a.id,a]));
  state.accounts=state.accounts.filter(a=>a.itemId!==itemId).concat(accounts.map(raw=>{const next=accountRecord(raw,itemId),old=previous.get(next.id);return old?{...next,includeInReporting:old.includeInReporting,archivedAt:old.archivedAt}:next;}));
}
const apiError = (message, status = 400) => Object.assign(new Error(message), { status });
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
function ready(env) { return !env.LOCAL_ONLY && !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET && env.TOKEN_ENCRYPTION_KEY && ['sandbox', 'production'].includes(env.PLAID_ENV)); }
function monthInReportingZone(date = new Date()) { const parts = new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit'}).formatToParts(date); return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}`; }
function budgetTemplates(state) {
  const templates = [...(Array.isArray(state.budgetTemplates) ? state.budgetTemplates : [])];
  const effectiveFrom = state.budgetHistoryUnavailableBefore || monthInReportingZone();
  for (const [name,amount] of Object.entries(state.budgets || {})) {
    const category = categoryCatalog(state).find(c=>c.name===name&&c.kind==='expense');
    if (category && !templates.some(entry=>entry.categoryId===category.id)) templates.push({ categoryId:category.id, amount, effectiveFrom });
  }
  return templates;
}
async function readState(env) {
  const repository=repositoryFor(env);
  return { ...await repository.read(), storageSchemaVersion:repository.schemaVersion };
}
async function mutate(env, update) {
  return repositoryFor(env).mutate(async state => {
    await update(state);
    state.revision = (Number.isSafeInteger(state.revision) ? state.revision : 0) + 1;
  });
}
function checkRevision(state,input) { if (input.revision !== undefined && input.revision !== state.revision) throw apiError('This data changed in another tab. Reload it and try again.', 409); }
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
    const messages = { ITEM_LOGIN_REQUIRED: 'Reconnect this account to resume updates.', PRODUCT_NOT_ENABLED: 'Enable the requested product in your Plaid dashboard before connecting this account.', INSTITUTION_NOT_SUPPORTED: 'This provider does not support the selected connection type.', NO_INVESTMENT_ACCOUNTS: 'No supported investment accounts were found at this provider.', PRODUCT_NOT_READY: 'Account data is still being prepared. Try syncing again shortly.', ADDITIONAL_CONSENT_REQUIRED: 'Reconnect this account to authorize the required data access.' };
    const error = apiError(messages[data.error_code] || 'The account connection could not be updated. Please try again later.', 502);
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
export function parseCSV(text, allowedCategories = CATEGORIES) {
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
    if (!allowedCategories.includes(category)) throw apiError('Unknown category at CSV row '+(index+2)+'. Create the budget bucket first or use Other.');
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
    if (!s.items.some(item=>item.lifecycle!=='unlinked')) throw apiError('Connect an account before syncing.');
    if (s.lease && s.lease.expiresAt > Date.now()) throw apiError('A bank sync is already running.', 409);
    s.lease = { id: leaseId, expiresAt: Date.now() + 5 * 60_000 };
  });
  const failures = [];
  try {
    for (const item of acquired.items.filter(item=>item.lifecycle!=='unlinked')) {
      try {
        if (!item.environment || item.environment !== env.PLAID_ENV) throw apiError('Connection environment must be verified before syncing. Reconnect only after the saved environment is confirmed.');
        const access_token = await decryptToken(env, item.token);
        if (item.product === 'investments') {
          const data = await plaid(env, '/investments/holdings/get', { access_token });
          const holdings = investmentHoldings(data, item.id);
          await mutate(env, s => {
            if (s.lease?.id !== leaseId) throw apiError('Sync was superseded. Please try again.', 409);
            const liveItem = s.items.find(i => i.id === item.id);
            if (!liveItem) return;
            s.holdings = (s.holdings || []).filter(h => h.itemId !== item.id).concat(holdings);
            replaceProviderAccounts(s,item.id,data.accounts);
            liveItem.lastSync = new Date().toISOString(); liveItem.error = null;
          });
          continue;
        }
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
          applySyncPages(s, item.id, result.pages);
          liveItem.cursor = result.cursor; liveItem.lastSync = new Date().toISOString(); liveItem.error = null;
          replaceProviderAccounts(s,item.id,accountData.accounts);
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
  const currentBudgetMonth = monthInReportingZone();
  const templates = budgetTemplates(state), overrides = state.monthlyBudgets || {};
  const budgets = Object.fromEntries(categoryCatalog(state).filter(c=>c.kind==='expense'&&!c.archivedAt).map(c=>[c.name,resolveBudget(templates,overrides,c.id,currentBudgetMonth).amount]).filter(([,amount])=>amount!==null));
  return { ...state, budgets, budgetTemplates: templates, monthlyBudgets: overrides, budgetHistoryUnavailableBefore: state.budgetHistoryUnavailableBefore || currentBudgetMonth, categories: categories(state), categoryCatalog: categoryCatalog(state), holdings: state.holdings || [], owner: undefined, lease: undefined, items: state.items.map(({ token, cursor, ...i }) => i), setup: { localOnly: !!env.LOCAL_ONLY, configured: ready(env), environment: env.PLAID_ENV || 'not configured' } };
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (request.method === 'GET' && Object.hasOwn(UI_ASSETS, path)) {
        const contentType = path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        return new Response(UI_ASSETS[path], { headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (path === '/' && request.method === 'GET') return new Response(page(), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': ready(env) ? "default-src 'self'; script-src 'self' https://cdn.plaid.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.plaid.com; frame-src https://*.plaid.com; connect-src 'self' https://*.plaid.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
      if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
      if (request.method !== 'GET' && request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
      if (request.method === 'POST' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return response({ error: 'Request origin is not allowed.' }, 403);
      const user = request.headers.get('oai-authenticated-user-id');
      if (!user) return response({ error: 'Local owner access is required.' }, 401);
      const { state, storageSchemaVersion } = await readState(env);
      if (state.owner && state.owner !== user) return response({ error: 'This dashboard belongs to another account.' }, 403);
      if (path === '/api/health' && request.method === 'GET') return response({ codeVersion: typeof BUILD_ID === 'string' ? BUILD_ID : 'unversioned', schemaVersion: Number.isInteger(storageSchemaVersion) ? storageSchemaVersion : Number.isInteger(state.version) ? state.version : null, configurationReady: ready(env), localOnly: !!env.LOCAL_ONLY, lastSync: state.lastSync || null });
      if (['/api/link-token', '/api/exchange-token', '/api/sync', '/api/scheduled-sync', '/api/disconnect', '/api/delete-history'].includes(path) && !ready(env)) return response({ error: 'Bank connections are disabled. Import CSV files for local-only operation.' }, 503);
      if (path === '/api/state' && request.method === 'GET') return response(publicState(state, env));
      if (path === '/api/link-token' && request.method === 'POST') {
        const input = await body(request);
        const params = { user: { client_user_id: user }, client_name: 'Ledger Personal Finance', language: 'en', country_codes: ['US'], ...(env.PLAID_REDIRECT_URI ? { redirect_uri: env.PLAID_REDIRECT_URI } : {}) };
        if (input.itemId) {
          const item = state.items.find(i => i.id === input.itemId);
          if (!item || item.lifecycle==='unlinked' || !item.token) throw apiError('This connection is unlinked. Add it again to resume access.', 409);
          if (!item.environment || item.environment !== env.PLAID_ENV) throw apiError('Saved connection environment does not match the configured provider environment. No token was sent.');
          if (input.product && input.product !== item.product) throw apiError('Connection type cannot change during update mode.', 409);
          params.access_token = await decryptToken(env, item.token);
        } else {
          const product = input.product || 'transactions';
          if (!['transactions', 'investments'].includes(product)) throw apiError('Choose bank or investment accounts.');
          params.products = [product];
          if (product === 'transactions') params.transactions = { days_requested: 365 };
        }
        const data = await plaid(env, '/link/token/create', params);
        return response({ link_token: data.link_token, environment: env.PLAID_ENV });
      }
      if (path === '/api/exchange-token' && request.method === 'POST') {
        const input = await body(request);
        if (typeof input.public_token !== 'string' || input.public_token.length > 500) throw apiError('Invalid bank authorization.');
        const product = input.product || 'transactions';
        if (!['transactions', 'investments'].includes(product)) throw apiError('Choose bank or investment accounts.');
        if(input.environment&&input.environment!==env.PLAID_ENV)throw apiError('The saved authorization environment does not match the configured provider environment. Restart the connection in its original environment.');
        // Validate encryption before consuming the one-time public token.
        await tokenKey(env);
        const data = await plaid(env, '/item/public_token/exchange', { public_token: input.public_token });
        const token = await encryptToken(env, data.access_token);
        await mutate(env, s => {
          if (s.owner && s.owner !== user) throw apiError('Access denied.', 403);
          s.owner = user;
          const existing=s.items.find(i=>i.id===data.item_id);
          if(existing){existing.name=String(input.name||existing.name||'Connected account').slice(0,100);existing.product=product;existing.environment=env.PLAID_ENV;existing.token=token;existing.lifecycle='connected';existing.error=null;}
          else s.items.push({ id: data.item_id, name: String(input.name || 'Connected account').slice(0,100), product, environment:env.PLAID_ENV, token, cursor: null, lastSync: null, error: null, lifecycle:'connected' });
        });
        return response({ connected: true, ...await syncBanks(env) });
      }
      if (['/api/sync', '/api/scheduled-sync'].includes(path) && request.method === 'POST') return response(await syncBanks(env));
      if (path === '/api/category' && request.method === 'POST') {
        const input = await body(request);
        const category = categoryCatalog(state).find(c => c.id === input.categoryId && !c.archivedAt) || categoryCatalog(state).find(c => c.name === input.category && !c.archivedAt);
        if (!category) throw apiError('Choose a valid category.');
        const saved = await mutate(env, s => { checkRevision(s,input); const t = s.transactions.find(t => t.id === input.id); if (!t) throw apiError('Transaction not found.', 404); const live = categoryCatalog(s).find(c => c.id === category.id && !c.archivedAt); if (!live) throw apiError('That category is no longer available.', 409); t.override = live.name; t.overrideCategoryId = live.id; });
        return response({ ok: true, revision: saved.revision });
      }
      if (path === '/api/import' && request.method === 'POST') {
        const input = await body(request);
        if (typeof input.csv !== 'string' || input.csv.length > 1_000_000 || typeof input.account !== 'string' || !input.account.trim() || input.account.trim().length > 100) throw apiError('Choose a CSV under 1 MB and enter an account name.');
        const transactions = parseCSV(input.csv, categories(state)), name = input.account.trim();
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
        const category = categoryCatalog(state).find(c => c.id === input.categoryId && !c.archivedAt) || categoryCatalog(state).find(c => c.name === input.category && !c.archivedAt);
        const mode=input.mode||'template', month=input.month||monthInReportingZone();
        if (!category || category.kind !== 'expense' || !['template','month'].includes(mode) || !validMonth(month) || input.amount!==null&&(!Number.isSafeInteger(input.amount)||input.amount<0||input.amount>100_000_000)) throw apiError('Enter a valid monthly budget.');
        const saved=await mutate(env, s => {
          checkRevision(s,input);
          const live=categoryCatalog(s).find(c=>c.id===category.id&&!c.archivedAt); if(!live) throw apiError('That category is no longer available.',409);
          s.owner=user; s.budgetHistoryUnavailableBefore ||= monthInReportingZone();
          s.budgetTemplates=budgetTemplates(s);
          if(mode==='template'){
            const index=s.budgetTemplates.findIndex(entry=>entry.categoryId===live.id&&entry.effectiveFrom===month);
            const template={categoryId:live.id,amount:input.amount,effectiveFrom:month};
            if(index>=0)s.budgetTemplates[index]=template;else s.budgetTemplates.push(template);
            if(month<=monthInReportingZone()){if(input.amount===null)delete s.budgets[live.name];else s.budgets[live.name]=input.amount;}
          }else{
            s.monthlyBudgets={...(s.monthlyBudgets||{}),[budgetMonthKey(month,live.id)]:input.amount};
          }
          s.budgetCategoryIds={...(s.budgetCategoryIds||{}),[live.id]:live.name};
        });
        return response({ ok:true,revision:saved.revision,amount:resolveBudget(budgetTemplates(saved),saved.monthlyBudgets||{},category.id,month).amount });
      }
      if (path === '/api/budget-reset' && request.method === 'POST') {
        const input=await body(request),category=categoryCatalog(state).find(c=>c.id===input.categoryId&&!c.archivedAt);
        if(!category||category.kind!=='expense'||!validMonth(input.month))throw apiError('Choose a valid category and month.');
        const saved=await mutate(env,s=>{checkRevision(s,input);s.monthlyBudgets={...(s.monthlyBudgets||{})};delete s.monthlyBudgets[budgetMonthKey(input.month,category.id)];});
        return response({ok:true,revision:saved.revision,amount:resolveBudget(budgetTemplates(saved),saved.monthlyBudgets||{},category.id,input.month).amount});
      }
      if (path === '/api/category-create' && request.method === 'POST') {
        const input = await body(request), name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
        if (!name || name.length > 80 || !/^[\p{L}\p{N}][\p{L}\p{N} .&'’()/_-]*$/u.test(name) || Object.hasOwn(Object.prototype, name)) throw apiError('Use a bucket name up to 80 characters, starting with a letter or number.');
        if (input.amount !== undefined && input.amount !== null && (!Number.isSafeInteger(input.amount) || input.amount < 0 || input.amount > 100_000_000)) throw apiError('Enter a valid monthly budget.');
        const saved=await mutate(env, s => {
          checkRevision(s,input);
          if (categoryCatalog(s).some(c => c.normalizedName === normalizeCategory(name))) throw apiError('A bucket with this name already exists.', 409);
          if ((s.customCategories || []).length >= 50) throw apiError('Use up to 50 custom budget buckets.');
          const catalog = categoryCatalog(s), records = s.categoryRecords || catalog.filter(c => !c.system);
          const category = { id: crypto.randomUUID(), name, normalizedName: normalizeCategory(name), kind: 'expense', system: false, order: Math.max(CATEGORIES.length-1,...catalog.map(c=>c.order))+1, archivedAt: null };
          s.owner = user; s.categoryRecords = [...records, category]; s.customCategories = [...(s.customCategories || []), name];
          if (input.amount !== undefined && input.amount !== null) s.budgets[name] = input.amount;
          s.budgetCategoryIds = { ...(s.budgetCategoryIds || {}), [category.id]: name };
        });
        return response({ ok: true, revision:saved.revision, category: categoryCatalog(saved).find(c => c.name === name && !c.system) });
      }
      if (path === '/api/category-update' && request.method === 'POST') {
        const input = await body(request);
        let result;
        const saved=await mutate(env, s => {
          checkRevision(s,input);
          const records = s.categoryRecords || categoryCatalog(s).filter(c => !c.system), index = records.findIndex(c => c.id === input.id);
          if (index < 0) throw apiError('Custom category not found.', 404);
          const category = records[index];
          if (category.system || category.kind !== 'expense') throw apiError('System categories cannot be changed here.', 400);
          if (input.action === 'rename') {
            const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
            if (!name || name.length > 80 || !/^[\p{L}\p{N}][\p{L}\p{N} .&'’()/_-]*$/u.test(name)) throw apiError('Use a bucket name up to 80 characters, starting with a letter or number.');
            const normalizedName = normalizeCategory(name);
            if (categoryCatalog(s).some(c => c.id !== category.id && c.normalizedName === normalizedName)) throw apiError('A bucket with this name already exists.', 409);
            const oldName = category.name;
            records[index] = { ...category, name, normalizedName };
            if (Object.hasOwn(s.budgets || {}, oldName)) { s.budgets[name] = s.budgets[oldName]; delete s.budgets[oldName]; s.budgetCategoryIds = { ...(s.budgetCategoryIds || {}), [category.id]: name }; }
            s.transactions.forEach(t => { if (t.overrideCategoryId === category.id || (!t.overrideCategoryId && t.override === oldName)) { t.overrideCategoryId = category.id; t.override = name; } if (t.category === oldName) { t.sourceCategory ??= oldName; t.categoryId = category.id; t.category = name; } });
            s.customCategories = (s.customCategories || []).map(value => value === oldName ? name : value);
            if (s.budgetCategoryIds?.[category.id]) s.budgetCategoryIds[category.id] = name;
          } else if (input.action === 'archive') {
            records[index] = { ...category, archivedAt: new Date().toISOString() };
          } else if (input.action === 'move') {
            if (!['up','down'].includes(input.direction)) throw apiError('Choose a valid category order.');
            const ordered = records.map((c,i)=>({c,i})).sort((a,b)=>a.c.order-b.c.order);
            const position = ordered.findIndex(entry=>entry.c.id===category.id), otherPosition = position + (input.direction === 'up' ? -1 : 1);
            if (otherPosition >= 0 && otherPosition < ordered.length) {
              const first=ordered[position], second=ordered[otherPosition], order=first.c.order;
              records[first.i]={...first.c,order:second.c.order}; records[second.i]={...second.c,order};
            }
          } else throw apiError('Choose rename, archive, or move.');
          s.owner = user; s.categoryRecords = records; result = records[index];
        });
        return response({ ok: true, revision:saved.revision, category: result });
      }
      if (path === '/api/manual-account' && request.method === 'POST') {
        const input=await body(request),name=typeof input.name==='string'?input.name.trim():'';
        if(input.action==='archive'||input.action==='restore'||input.action==='include'){
          if(input.action==='include'&&typeof input.value!=='boolean')throw apiError('Choose whether to include this account in reports.');
          const saved=await mutate(env,s=>{checkRevision(s,input);const account=s.accounts.find(a=>a.id===input.id&&a.manual);if(!account)throw apiError('Manual account not found.',404);if(input.action==='include')account.includeInReporting=input.value;else account.archivedAt=input.action==='archive'?new Date().toISOString():null;account.updatedAt=new Date().toISOString();});
          return response({ok:true,revision:saved.revision});
        }
        const allowedTypes=['depository','credit','investment','retirement','hsa','asset','liability','other'];
        const currency=typeof input.currency==='string'?input.currency.toUpperCase():'USD';
        if(!name||name.length>100||typeof input.type!=='string'||!allowedTypes.includes(input.type)||!/^[A-Z]{3}$/.test(currency)||input.balance!==null&&(!Number.isSafeInteger(input.balance)||Math.abs(input.balance)>1_000_000_000_000)||input.balance!==null&&!validDateOnly(input.asOf)||input.institution!==undefined&&(typeof input.institution!=='string'||input.institution.length>100)||input.notes!==undefined&&(typeof input.notes!=='string'||input.notes.length>500)||input.includeInReporting!==undefined&&typeof input.includeInReporting!=='boolean')throw apiError('Enter a valid manual account name, type, currency, and observed balance.');
        let savedAccount;
        const saved=await mutate(env,s=>{
          checkRevision(s,input);
          const existing=input.id?s.accounts.find(a=>a.id===input.id&&a.manual):null;
          if(input.id&&!existing)throw apiError('Manual account not found.',404);
          const now=new Date().toISOString();
          savedAccount={...(existing||{}),id:existing?.id||crypto.randomUUID(),itemId:null,connectionId:null,source:'manual',manual:true,name,institution:input.institution?.trim()||null,type:input.type,subtype:typeof input.subtype==='string'?input.subtype.trim().slice(0,60)||null:null,balance:input.balance,currency,balanceAsOf:input.balance===null?null:input.asOf,balanceSource:input.balance===null?null:'manual',includeInReporting:input.includeInReporting!==false,notes:input.notes?.trim()||'',createdAt:existing?.createdAt||now,updatedAt:now,archivedAt:null};
          if(existing)Object.assign(existing,savedAccount);else s.accounts.push(savedAccount);
          s.owner=user;
        });
        return response({ok:true,revision:saved.revision,account:savedAccount});
      }
      if (path === '/api/account-update' && request.method === 'POST') {
        const input=await body(request);
        const saved=await mutate(env,s=>{
          checkRevision(s,input);
          const account=s.accounts.find(a=>a.id===input.id&&!a.manual);
          if(!account)throw apiError('Connected account not found.',404);
          if(input.action==='archive')account.archivedAt=account.archivedAt||new Date().toISOString();
          else if(input.action==='restore')account.archivedAt=null;
          else if(input.action==='include')account.includeInReporting=input.value===true;
          else throw apiError('Choose archive, restore, or include.');
        });
        return response({ok:true,revision:saved.revision});
      }
      if (path === '/api/investment-account' && request.method === 'POST') {
        const input = await body(request), name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name || name.length > 100 || !Number.isSafeInteger(input.balance) || input.balance < 0 || input.balance > 1_000_000_000_000 || !['hsa', '401k', 'ira', 'brokerage', 'other'].includes(input.subtype)) throw apiError('Enter an account name, type, and a valid USD balance.');
        const id = 'manual-investment:' + await hash(name.toLowerCase());
        await mutate(env, s => {
          s.owner = user;
          s.accounts = s.accounts.filter(a => a.id !== id).concat({ id, itemId: null, name, type: 'investment', subtype: input.subtype, balance: input.balance, currency: 'USD', manual: true, updatedAt: new Date().toISOString() });
        });
        return response({ ok: true });
      }
      if (path === '/api/disconnect' && request.method === 'POST') {
        const input = await body(request), item = state.items.find(i => i.id === input.itemId);
        if (!item) throw apiError('Bank connection not found.', 404);
        if (state.lease && state.lease.expiresAt > Date.now()) throw apiError('Wait for the current sync to finish before disconnecting.', 409);
        if(item.lifecycle!=='unlinked'&&item.token){if(!item.environment||item.environment!==env.PLAID_ENV)throw apiError('Saved connection environment must be verified before unlinking; no token was sent.');await plaid(env, '/item/remove', { access_token: await decryptToken(env, item.token) });}
        const saved=await mutate(env, s => { const link=s.items.find(i=>i.id===item.id); if(!link)return; link.token=null;link.lifecycle='unlinked';link.error=null;link.unlinkedAt=new Date().toISOString(); });
        return response({ ok: true, historyRetained:true, revision:saved.revision });
      }
      if (path === '/api/delete-history' && request.method === 'POST') {
        const input=await body(request),item=state.items.find(i=>i.id===input.itemId);
        if(!item)throw apiError('Connection history not found.',404);
        if(state.lease&&state.lease.expiresAt>Date.now())throw apiError('Wait for the current sync to finish before deleting history.',409);
        if(item.lifecycle!=='unlinked'&&item.token){if(!item.environment||item.environment!==env.PLAID_ENV)throw apiError('Saved connection environment must be verified before deleting history; no token was sent.');await plaid(env,'/item/remove',{access_token:await decryptToken(env,item.token)});}
        await mutate(env,s=>{s.items=s.items.filter(i=>i.id!==item.id);s.accounts=s.accounts.filter(a=>a.itemId!==item.id);s.transactions=s.transactions.filter(t=>t.itemId!==item.id);s.holdings=(s.holdings||[]).filter(h=>h.itemId!==item.id);});
        return response({ok:true,historyDeleted:true});
      }
      return response({ error: 'Not found' }, 404);
    } catch (e) { return response({ error: e.status ? e.message : 'Something went wrong. Please try again.' }, e.status || 500); }
  }
};

function page() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Your spending, beautifully in focus. A private personal finance dashboard."><title>Ledger · Personal finance</title><link rel="stylesheet" href="/assets/styles.css"></head><body><div id="app"></div><div id="toast" role="status" aria-live="polite"></div><script type="module" src="/assets/app.js"></script></body></html>';
}
