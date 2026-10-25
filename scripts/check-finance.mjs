import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
const source = await readFile(new URL('../dist/server/index.js', import.meta.url),'utf8');
const { default: worker, totals, fromPlaid, categoryFor, applyChanges, applySyncPages, parseCSV } = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
globalThis.crypto ||= webcrypto;

assert.deepEqual(totals([
  {amount:10000,category:'Shopping',currency:'USD'},
  {amount:-2000,category:'Shopping',currency:'USD'},
  {amount:-300000,category:'Income',currency:'USD'},
  {amount:80000,category:'Transfers',currency:'USD'},
  {amount:5000,category:'Dining',currency:'USD',pending:true},
  {amount:5000,category:'Dining',currency:'CAD'}
]),{income:300000,spend:8000,categories:{Shopping:8000}});
assert.equal(categoryFor({personal_finance_category:{primary:'LOAN_PAYMENTS',detailed:'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'}}),'Transfers');
assert.equal(categoryFor({personal_finance_category:{primary:'FOOD_AND_DRINK',detailed:'FOOD_AND_DRINK_GROCERIES'}}),'Groceries');
assert.equal(categoryFor({personal_finance_category:{primary:'RENT_AND_UTILITIES',detailed:'RENT_AND_UTILITIES_INTERNET_AND_CABLE'}}),'Utilities');
assert.equal(categoryFor({personal_finance_category:{primary:'RENT_AND_UTILITIES',detailed:'RENT_AND_UTILITIES_RENT'}}),'Housing');
assert.equal(fromPlaid({amount:19.99,transaction_id:'t'},'i').amount,1999);
const pending = {id:'pending',override:'Travel',category:'Other',currency:'USD',amount:1000,pending:true};
const state={transactions:[pending,{id:'gone',amount:1}]};
const posted={transaction_id:'posted',pending_transaction_id:'pending',amount:12.34,date:'2026-10-01',name:'Hotel',iso_currency_code:'USD'};
applyChanges(state,'item',[posted],[],[{transaction_id:'pending'},{transaction_id:'gone'}]);
assert.equal(state.transactions.length,1);assert.equal(state.transactions[0].override,'Travel');
for (const pages of [
  [{added:[],modified:[],removed:[{transaction_id:'pending'}]},{added:[posted],modified:[],removed:[]}],
  [{added:[posted],modified:[],removed:[]},{added:[],modified:[],removed:[{transaction_id:'pending'}]}]
]) {
  const paged={transactions:[{...pending}]};
  applySyncPages(paged,'item',pages);
  assert.equal(paged.transactions.length,1);
  assert.equal(paged.transactions[0].override,'Travel');
}
applyChanges(state,'item',[posted],[{...posted,amount:15}],[]);
assert.equal(state.transactions.length,1);assert.equal(state.transactions[0].amount,1500);
assert.equal(parseCSV('Date,Merchant,Amount,Category\r\n2026-10-01,"Store, \"\"Main\"\"",12.34,Shopping\r\n')[0].merchant,'Store, "Main"');
assert.throws(()=>parseCSV('Date,Merchant,Amount\n2026-02-30,Store,1.00'),/Invalid/);
assert.throws(()=>parseCSV('Date,Merchant,Amount\n2026-10-01,Store,NaN'),/amount/);
assert.throws(()=>parseCSV('Date,Merchant,Amount,Currency\n2026-10-01,Store,1.00,CAD'),/USD/);

class Bucket {
  value = null; version = 0;
  async get(){return this.value===null?null:{etag:String(this.version),json:async()=>JSON.parse(this.value)};}
  async put(key,value,options){const condition=options.onlyIf;if(condition.etagMatches && condition.etagMatches!==String(this.version))return null;if(condition.etagDoesNotMatch==='*'&&this.value!==null)return null;this.value=value;this.version++;return {etag:String(this.version)};}
}
const env={BUCKET:new Bucket(),PLAID_ENV:'sandbox',PLAID_CLIENT_ID:'test-client',PLAID_SECRET:'test-secret',TOKEN_ENCRYPTION_KEY:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')};
const call=(path,input,user='owner',origin)=>worker.fetch(new Request('https://ledger.test/api/'+path,{method:input===undefined?'GET':'POST',headers:{...(user?{'oai-authenticated-user-id':user}:{}),...(origin?{Origin:origin}:{}),...(input!==undefined?{'Content-Type':'application/json'}:{})},body:input===undefined?undefined:JSON.stringify(input)}),env);
assert.equal((await call('state',undefined,null)).status,401);
assert.equal((await call('sync',{},'owner','https://other.test')).status,403);
assert.equal((await call('scheduled-sync',{},null)).status,401);
const health=await (await call('health')).json();
assert.equal(health.schemaVersion,1);
assert.equal(typeof health.codeVersion,'string');
assert.equal(health.configurationReady,true);
let syncCalls=0;const seen=[];const realFetch=globalThis.fetch;
globalThis.fetch=async (url,options)=>{
  const input=JSON.parse(options.body);seen.push({url,input});
  if(url.endsWith('/link/token/create'))return Response.json({link_token:'temporary-link'});
  if(url.endsWith('/item/public_token/exchange'))return Response.json({item_id:'item-1',access_token:'never-expose-bank-token'});
  if(url.endsWith('/transactions/sync')){syncCalls++;return Response.json({added:syncCalls===1?[{...posted,pending_transaction_id:null}]:[],modified:[],removed:[],next_cursor:'cursor-'+syncCalls,has_more:false});}
  if(url.endsWith('/accounts/get'))return Response.json({accounts:[{account_id:'a',name:'Checking',mask:'1234',type:'depository',balances:{current:234.56,iso_currency_code:'USD'}}]});
  if(url.endsWith('/item/remove'))return Response.json({removed:true});
  throw new Error('Unexpected mocked endpoint');
};
try {
  assert.equal((await call('link-token',{})).status,200);
  assert.equal(seen.at(-1).input.redirect_uri,undefined);
  env.PLAID_REDIRECT_URI='https://ledger.test/';
  assert.equal((await call('link-token',{})).status,200);
  assert.equal(seen.at(-1).input.redirect_uri,'https://ledger.test/');
  const connected=await call('exchange-token',{public_token:'public-test',name:'Chase'});
  assert.equal(connected.status,200);assert.equal((await connected.json()).ok,true);
  let publicData=await (await call('state')).json();
  assert.equal(publicData.transactions.length,1);assert.equal(publicData.items[0].name,'Chase');
  assert.ok(!JSON.stringify(publicData).includes('never-expose'));
  assert.ok(!env.BUCKET.value.includes('never-expose'));
  assert.equal(publicData.items[0].token,undefined);assert.equal(publicData.items[0].cursor,undefined);
  assert.equal((await call('state',undefined,'other-owner')).status,403);
  assert.equal((await call('category',{id:'posted',category:'Travel'})).status,200);
  assert.equal((await call('sync',{})).status,200);
  publicData=await (await call('state')).json();
  assert.equal(publicData.transactions.length,1);assert.equal(publicData.transactions[0].override,'Travel');
  assert.equal(seen.filter(x=>x.url.endsWith('/transactions/sync')).at(-1).input.cursor,'cursor-1');
  assert.equal((await call('budget',{category:'Travel',amount:-100})).status,400);
  assert.equal((await call('budget',{category:'Travel',amount:50000})).status,200);
  const csv={account:'Manual account',csv:'Date,Merchant,Amount,Category\n2026-10-01,Meijer,22.35,Groceries'};
  assert.equal((await (await call('import',csv)).json()).imported,1);
  assert.equal((await (await call('import',csv)).json()).skipped,1);
  assert.equal((await call('scheduled-sync',{},null)).status,401);
  assert.equal((await call('scheduled-sync',{},'other-owner')).status,403);
  assert.equal((await call('scheduled-sync',{})).status,200);
  assert.equal((await call('disconnect',{itemId:'item-1'})).status,200);
  publicData=await (await call('state')).json();
  assert.equal(publicData.items.length,0);assert.equal(publicData.transactions.length,1);
  assert.equal(publicData.transactions[0].category,'Groceries');
} finally { globalThis.fetch=realFetch; }

// Local-only mode overrides even present credentials and prevents network calls.
env.LOCAL_ONLY=true;
globalThis.fetch=()=>{throw new Error('Unexpected external request in local-only mode');};
try {
  for(const path of ['link-token','exchange-token','sync','scheduled-sync','disconnect'])assert.equal((await call(path,{})).status,503);
  const localState=await (await call('state')).json();
  assert.equal(localState.setup.localOnly,true);
  assert.equal(localState.setup.configured,false);
  const page=await worker.fetch(new Request('http://127.0.0.1:3000/'),env);
  assert.ok(!page.headers.get('Content-Security-Policy').includes('plaid.com'));
} finally {globalThis.fetch=realFetch;env.LOCAL_ONLY=false;}

// Smoke the embedded client without a browser; visual layout remains unverified.
const html=await (await worker.fetch(new Request('https://ledger.test/'),env)).text();
const client=html.match(/<script>([\s\S]*)<\/script>/)[1];
const elements=new Map();
const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',className:'',addEventListener(){}});return elements.get(id);};
vm.runInNewContext(client,{document:{getElementById:element,querySelectorAll:()=>[]},window:{scrollTo(){}},fetch:async()=>({ok:true,json:async()=>({items:[],accounts:[],transactions:[],budgets:{},setup:{configured:false}})}),URL,Date,Intl,Map,Set,JSON,Promise,console,setTimeout,clearTimeout,location:{href:'https://ledger.test/'},history:{replaceState(){}},sessionStorage:{getItem:()=>null}});
await new Promise(resolve=>setTimeout(resolve,0));
assert.ok(element('app').innerHTML.includes('These are sample transactions'));
assert.ok(element('app').innerHTML.includes('Spending over time'));
element('sync').onclick();assert.ok(element('app').innerHTML.includes('Finish your bank connection setup'));
console.log('Finance checks passed: totals, refunds/transfers, currencies, pending replacements, CSV validation/idempotency, authentication, encryption, incremental sync, persistence, disconnect, and client render.');
