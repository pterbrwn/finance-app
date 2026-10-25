import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
const { default: worker, totals, fromPlaid, categoryFor, applyChanges, applySyncPages, parseCSV } = await import('../dist/server/index.js');
const { accountRecord, investmentHoldings } = await import('../dist/shared/investments.mjs');
const { budgetMonthKey, resolveBudget } = await import('../dist/shared/budgets.mjs');
globalThis.crypto ||= webcrypto;

assert.deepEqual(resolveBudget([{categoryId:'food',amount:10000,effectiveFrom:'2026-01'}],{},'food','2026-03'),{amount:10000,source:'template',effectiveFrom:'2026-01',month:'2026-03',categoryId:'food'});
assert.equal(resolveBudget([{categoryId:'food',amount:10000,effectiveFrom:'2026-01'},{categoryId:'food',amount:12000,effectiveFrom:'2026-07'}],{},'food','2026-06').amount,10000);
assert.equal(resolveBudget([{categoryId:'food',amount:10000,effectiveFrom:'2026-01'},{categoryId:'food',amount:12000,effectiveFrom:'2026-07'}],{},'food','2026-07').amount,12000);
assert.equal(resolveBudget([{categoryId:'food',amount:10000,effectiveFrom:'2026-01'}],{'2026-03:food':0},'food','2026-03').amount,0);
assert.equal(resolveBudget([{categoryId:'food',amount:10000,effectiveFrom:'2026-01'}],{'2026-03:food':null},'food','2026-03').amount,null);

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
const providerAccount={account_id:'same-account',name:'Brokerage',type:'investment',balances:{current:1000,iso_currency_code:'USD'}};
assert.notEqual(accountRecord(providerAccount,'item-a').id,accountRecord(providerAccount,'item-b').id,'provider account IDs are scoped to their connection');
assert.equal(fromPlaid({amount:1,transaction_id:'scoped-tx',account_id:'same-account'},'item-a').accountId,accountRecord(providerAccount,'item-a').id);
assert.equal(investmentHoldings({securities:[{security_id:'security-1',name:'Fund',ticker_symbol:'FND'}],holdings:[{account_id:'same-account',security_id:'security-1',quantity:2,institution_value:40,iso_currency_code:'CAD',institution_price_as_of:'2026-10-01'}]},'item-a')[0].accountId,accountRecord(providerAccount,'item-a').id);
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
const env={BUCKET:new Bucket(),getSyncTimerStatus:async()=>({state:'available',enabled:false,active:false,enabledState:'disabled',activeState:'inactive'}),PLAID_ENV:'sandbox',PLAID_CLIENT_ID:'test-client',PLAID_SECRET:'test-secret',TOKEN_ENCRYPTION_KEY:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')};
const call=(path,input,user='owner',origin)=>worker.fetch(new Request('https://ledger.test/api/'+path,{method:input===undefined?'GET':'POST',headers:{...(user?{'oai-authenticated-user-id':user}:{}),...(origin?{Origin:origin}:{}),...(input!==undefined?{'Content-Type':'application/json'}:{})},body:input===undefined?undefined:JSON.stringify(input)}),env);
const waitJob=async initial=>{let job=initial.job;for(let i=0;i<2000&&job?.status==='running';i++){await new Promise(resolve=>setTimeout(resolve,2));job=(await(await call('sync-status')).json()).job;}return job;};
assert.equal((await call('state',undefined,null)).status,401);
assert.equal((await call('sync',{},'owner','https://other.test')).status,403);
assert.equal((await call('scheduled-sync',{},null)).status,401);
const health=await (await call('health')).json();
assert.equal(health.schemaVersion,1);
assert.equal(typeof health.codeVersion,'string');
assert.equal(health.configurationReady,true);
let syncCalls=0,failInvestmentHoldings=false,rateLimitAccountsOnce=true,holdTransactionSync=false,releaseTransactionSync;const seen=[];const realFetch=globalThis.fetch;
globalThis.fetch=async (url,options)=>{
  const input=JSON.parse(options.body);seen.push({url,input});
  if(url.endsWith('/link/token/create'))return Response.json({link_token:'temporary-link'});
  if(url.endsWith('/item/public_token/exchange'))return Response.json({item_id:input.public_token==='public-investment'?'item-2':'item-1',access_token:input.public_token==='public-investment'?'never-expose-investment-token':'never-expose-bank-token'});
  if(url.endsWith('/investments/holdings/get')){if(failInvestmentHoldings)return new Response(JSON.stringify({error_code:'PRODUCT_NOT_READY'}),{status:400});return Response.json({accounts:[{account_id:'same-account',name:'Brokerage',mask:'8888',type:'investment',subtype:'brokerage',balances:{current:1000,iso_currency_code:'USD'}}],securities:[{security_id:'security-1',name:'Index Fund',ticker_symbol:'IDX'}],holdings:[{account_id:'same-account',security_id:'security-1',quantity:2,institution_value:500,iso_currency_code:'USD',institution_price_as_of:'2026-10-01'}]});}
  if(url.endsWith('/transactions/sync')){if(holdTransactionSync)await new Promise(resolve=>{releaseTransactionSync=resolve;});syncCalls++;return Response.json({added:syncCalls===1?[{...posted,pending_transaction_id:null}]:[],modified:[],removed:[],next_cursor:'cursor-'+syncCalls,has_more:false});}
  if(url.endsWith('/accounts/get')){if(rateLimitAccountsOnce){rateLimitAccountsOnce=false;return new Response(JSON.stringify({error_code:'RATE_LIMIT_EXCEEDED'}),{status:429});}return Response.json({accounts:[{account_id:'a',name:'Checking',mask:'1234',type:'depository',balances:{current:234.56,iso_currency_code:'USD'}}]});}
  if(url.endsWith('/item/remove'))return Response.json({removed:true});
  throw new Error('Unexpected mocked endpoint');
};
try {
  assert.equal((await call('link-token',{})).status,200);
  assert.equal(seen.at(-1).input.redirect_uri,undefined);
  env.PLAID_REDIRECT_URI='https://ledger.test/';
  assert.equal((await call('link-token',{})).status,200);
  assert.equal(seen.at(-1).input.redirect_uri,'https://ledger.test/');
  assert.equal((await call('link-token',{product:'investments'})).status,200);
  assert.deepEqual(seen.at(-1).input.products,['investments'],'investment intent is preserved when creating Link');
  const connected=await call('exchange-token',{public_token:'public-test',name:'Chase',product:'transactions'});
  const connectedResult=await connected.json();assert.equal(connected.status,200,JSON.stringify(connectedResult));assert.equal((await waitJob(connectedResult)).status,'succeeded');
  let publicData=await (await call('state')).json();
  assert.equal(publicData.transactions.length,1);assert.equal(publicData.items[0].name,'Chase');assert.equal(publicData.setup.syncTimer.enabled,false);
  assert.ok(!JSON.stringify(publicData).includes('never-expose'));
  assert.ok(!env.BUCKET.value.includes('never-expose'));
  assert.equal(publicData.items[0].token,undefined);assert.equal(publicData.items[0].cursor,undefined);
  const savedAccount=publicData.accounts.find(a=>a.itemId==='item-1');
  assert.ok(savedAccount);assert.equal(rateLimitAccountsOnce,false,'a transient provider rate limit is retried with backoff');
  const includeResult=await call('account-update',{id:savedAccount.id,action:'include',value:false,revision:publicData.revision});
  assert.equal(includeResult.status,200);
  publicData=await (await call('state')).json();
  assert.equal(publicData.accounts.find(a=>a.id===savedAccount.id).includeInReporting,false);
  assert.equal((await call('link-token',{itemId:'item-1',product:'investments'})).status,409,'update mode cannot silently change the saved product');
  assert.equal((await call('account-update',{id:savedAccount.id,action:'archive',revision:publicData.revision})).status,200);
  assert.ok((await (await call('state')).json()).accounts.find(a=>a.id===savedAccount.id).archivedAt);
  assert.equal((await call('state',undefined,'other-owner')).status,403);
  assert.equal((await call('category',{id:'posted',category:'Travel'})).status,200);
  const firstManualSync=await call('sync',{});assert.equal(firstManualSync.status,200);assert.equal((await waitJob(await firstManualSync.json())).status,'succeeded');
  publicData=await (await call('state')).json();
  assert.equal(publicData.transactions.length,1);assert.equal(publicData.transactions[0].override,'Travel');
  assert.equal(seen.filter(x=>x.url.endsWith('/transactions/sync')).at(-1).input.cursor,'cursor-1');
  holdTransactionSync=true;releaseTransactionSync=null;const overlapStart=await(await call('sync',{})).json();for(let i=0;i<100&&!releaseTransactionSync;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(releaseTransactionSync,'sync runner reaches the held provider request');const overlapping=await(await call('scheduled-sync',{})).json();assert.equal(overlapping.joined,true,'a second trigger joins the active job');assert.equal(overlapping.job.id,overlapStart.job.id);holdTransactionSync=false;releaseTransactionSync();releaseTransactionSync=null;assert.equal((await waitJob(overlapStart)).status,'succeeded');
  assert.equal((await call('budget',{category:'Travel',amount:-100})).status,400);
  assert.equal((await call('budget',{category:'Travel',amount:50000})).status,200);
  publicData=await (await call('state')).json();
  const budgetRevision=publicData.revision;
  assert.equal((await call('budget',{category:'Travel',amount:51000,revision:budgetRevision})).status,200);
  assert.equal((await call('budget',{category:'Travel',amount:52000,revision:budgetRevision})).status,409,'stale budget edits require a reload');
  publicData=await (await call('state')).json();
  const currentBudgetMonth=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit'}).formatToParts(new Date());
  const currentMonth=currentBudgetMonth.find(x=>x.type==='year').value+'-'+currentBudgetMonth.find(x=>x.type==='month').value;
  const nextMonthDate=new Date(currentMonth+'-01T12:00:00Z');nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth()+1);const nextMonth=nextMonthDate.toISOString().slice(0,7);
  assert.equal((await call('budget',{category:'Travel',categoryId:'system:travel',amount:25000,mode:'month',month:currentMonth,revision:publicData.revision})).status,200);
  publicData=await (await call('state')).json();
  assert.equal(resolveBudget(publicData.budgetTemplates,publicData.monthlyBudgets,'system:travel',currentMonth).amount,25000);
  assert.equal(resolveBudget(publicData.budgetTemplates,publicData.monthlyBudgets,'system:travel',nextMonth).amount,51000);
  assert.equal((await call('budget',{category:'Travel',categoryId:'system:travel',amount:0,mode:'template',month:nextMonth,revision:publicData.revision})).status,200);
  publicData=await (await call('state')).json();
  assert.equal(resolveBudget(publicData.budgetTemplates,publicData.monthlyBudgets,'system:travel',currentMonth).amount,25000,'future template edits leave earlier month overrides intact');
  assert.equal(resolveBudget(publicData.budgetTemplates,publicData.monthlyBudgets,'system:travel',nextMonth).amount,0,'zero is an intentional zero-dollar limit');
  assert.equal((await call('budget-reset',{categoryId:'system:travel',month:currentMonth,revision:publicData.revision})).status,200);
  publicData=await (await call('state')).json();
  assert.equal(resolveBudget(publicData.budgetTemplates,publicData.monthlyBudgets,'system:travel',currentMonth).amount,51000,'reset restores the effective recurring template');
  const privateConnection=JSON.parse(env.BUCKET.value),connection=privateConnection.items.find(i=>i.id==='item-1');
  delete connection.environment;env.BUCKET.value=JSON.stringify(privateConnection);
  const syncRequestCount=seen.filter(x=>x.url.endsWith('/transactions/sync')).length;
  const unknownEnvironmentStart=await (await call('sync',{})).json();
  const unknownEnvironment=await waitJob(unknownEnvironmentStart);
  assert.equal(unknownEnvironment.status,'failed');
  assert.match(unknownEnvironment.failures[0].message,/environment must be verified/i);
  assert.equal(seen.filter(x=>x.url.endsWith('/transactions/sync')).length,syncRequestCount,'unknown environments never receive a decrypted token request');
  connection.environment='sandbox';env.BUCKET.value=JSON.stringify(privateConnection);
  const createdCategoryResponse=await call('category-create',{name:'Gifts & Giving',amount:10000,revision:publicData.revision});
  assert.equal(createdCategoryResponse.status,200);
  const createdCategory=await createdCategoryResponse.json(),categoryId=createdCategory.category.id;
  assert.ok(categoryId);assert.equal(createdCategory.category.kind,'expense');
  publicData=await (await call('state')).json();
  assert.equal((await call('category-create',{name:' gifts & giving ',revision:publicData.revision})).status,409);
  const assigned=await call('category',{id:'posted',category:'Gifts & Giving',categoryId,revision:publicData.revision});
  assert.equal(assigned.status,200);
  const afterAssignment=await assigned.json();
  assert.equal((await call('category-update',{id:categoryId,action:'rename',name:'Generosity & Gifts',revision:publicData.revision})).status,409,'stale category writes fail instead of overwriting newer changes');
  publicData=await (await call('state')).json();
  const renamedResponse=await call('category-update',{id:categoryId,action:'rename',name:'Generosity & Gifts',revision:publicData.revision});
  assert.equal(renamedResponse.status,200);
  assert.equal((await renamedResponse.json()).category.id,categoryId,'category identity survives rename');
  publicData=await (await call('state')).json();
  assert.equal(publicData.transactions[0].override,'Generosity & Gifts');
  assert.equal(publicData.transactions[0].overrideCategoryId,categoryId);
  assert.equal(publicData.budgets['Generosity & Gifts'],10000);
  const archived=await call('category-update',{id:categoryId,action:'archive',revision:publicData.revision});
  assert.equal(archived.status,200);
  publicData=await (await call('state')).json();
  assert.ok(!publicData.categories.includes('Generosity & Gifts'));
  assert.equal(publicData.categoryCatalog.find(c=>c.id===categoryId).archivedAt!==null,true);
  assert.equal(publicData.transactions[0].override,'Generosity & Gifts');
  const manualOneResponse=await call('manual-account',{name:'Shared Name',institution:'Local Bank',type:'depository',balance:123456,currency:'USD',asOf:'2026-10-01',revision:publicData.revision});
  assert.equal(manualOneResponse.status,200);
  const manualOne=(await manualOneResponse.json()).account;
  publicData=await (await call('state')).json();
  const manualTwoResponse=await call('manual-account',{name:'Shared Name',type:'credit',balance:35000,currency:'USD',asOf:'2026-10-01',revision:publicData.revision});
  assert.equal(manualTwoResponse.status,200);
  const manualTwo=(await manualTwoResponse.json()).account;
  assert.notEqual(manualOne.id,manualTwo.id,'same-named manual accounts have independent IDs');
  publicData=await (await call('state')).json();
  const updatedManual=await call('manual-account',{id:manualOne.id,name:'Renamed Savings',institution:'Local Bank',type:'depository',balance:null,currency:'USD',revision:publicData.revision});
  assert.equal(updatedManual.status,200);
  assert.equal((await updatedManual.json()).account.id,manualOne.id,'editing retains the account ID');
  publicData=await (await call('state')).json();
  assert.equal(publicData.accounts.find(a=>a.id===manualOne.id).balance,null,'unknown manual balances remain unavailable');
  assert.equal((await call('manual-account',{id:manualTwo.id,action:'archive',revision:publicData.revision})).status,200);
  assert.ok((await (await call('state')).json()).accounts.find(a=>a.id===manualTwo.id).archivedAt);
  const csv={account:'Manual account',csv:'Date,Merchant,Amount,Category\n2026-10-01,Meijer,22.35,Groceries'};
  assert.equal((await (await call('import',csv)).json()).imported,1);
  assert.equal((await (await call('import',csv)).json()).skipped,1);
  assert.equal((await call('scheduled-sync',{},null)).status,401);
  assert.equal((await call('scheduled-sync',{},'other-owner')).status,403);
  const scheduled=await call('scheduled-sync',{});assert.equal(scheduled.status,200);assert.equal((await waitJob(await scheduled.json())).status,'succeeded');
  assert.equal((await call('disconnect',{itemId:'item-1'})).status,200);
  publicData=await (await call('state')).json();
  assert.equal(publicData.items.length,1);assert.equal(publicData.items[0].lifecycle,'unlinked');assert.equal(publicData.transactions.filter(t=>t.itemId==='item-1').length,1);
  assert.ok(publicData.transactions.some(t=>t.itemId==='item-1'&&t.id==='posted'),'unlink retains provider transaction history');
  assert.equal((await call('delete-history',{itemId:'item-1'})).status,200);
  publicData=await (await call('state')).json();
  assert.equal(publicData.items.length,0);assert.equal(publicData.transactions.filter(t=>t.itemId==='item-1').length,0);assert.equal(publicData.transactions.length,1,'deleting a provider connection preserves unrelated CSV history');assert.equal(publicData.accounts.some(a=>a.itemId==='item-1'),false);
  const transactionCallsBeforeInvestment=seen.filter(x=>x.url.endsWith('/transactions/sync')).length;
  const investmentConnected=await call('exchange-token',{public_token:'public-investment',name:'Fidelity',product:'investments',environment:'sandbox'});
  assert.equal(investmentConnected.status,200);assert.equal((await waitJob(await investmentConnected.json())).status,'succeeded');
  assert.equal(seen.filter(x=>x.url.endsWith('/transactions/sync')).length,transactionCallsBeforeInvestment,'investment connections do not use transaction spending sync');
  publicData=await (await call('state')).json();
  const investmentAccount=publicData.accounts.find(a=>a.itemId==='item-2');
  assert.ok(investmentAccount);assert.equal(investmentAccount.id,accountRecord(providerAccount,'item-2').id);
  assert.equal(publicData.holdings[0].accountId,investmentAccount.id);
  assert.equal(publicData.holdings[0].value,50000);
  failInvestmentHoldings=true;
  const failedInvestmentStart=await (await call('sync',{})).json();const failedInvestmentSync=await waitJob(failedInvestmentStart);
  assert.equal(failedInvestmentSync.status,'failed');
  publicData=await (await call('state')).json();
  assert.equal(publicData.holdings.length,1,'failed holdings refresh retains the prior snapshot');
  assert.equal(publicData.items.find(i=>i.id==='item-2').lifecycle,'connected');
  failInvestmentHoldings=false;
  const interruptedState=JSON.parse(env.BUCKET.value);interruptedState.syncJob={id:'crashed-job',status:'running',startedAt:new Date().toISOString(),lastHeartbeatAt:new Date().toISOString(),total:1,completed:0,failures:[]};env.BUCKET.value=JSON.stringify(interruptedState);
  const restartedEnv={...env},recoveredStatus=await worker.fetch(new Request('https://ledger.test/api/sync-status',{headers:{'oai-authenticated-user-id':'owner'}}),restartedEnv);
  assert.equal((await recoveredStatus.json()).job.status,'interrupted','a persisted in-progress job is marked interrupted after process restart');
} finally { globalThis.fetch=realFetch; }

// Local-only mode overrides even present credentials and prevents network calls.
env.LOCAL_ONLY=true;
globalThis.fetch=()=>{throw new Error('Unexpected external request in local-only mode');};
try {
  for(const path of ['link-token','exchange-token','sync','scheduled-sync','sync-status','disconnect','delete-history'])assert.equal((await call(path,{})).status,503);
  const localState=await (await call('state')).json();
  assert.equal(localState.setup.localOnly,true);
  assert.equal(localState.setup.configured,false);
  const page=await worker.fetch(new Request('http://127.0.0.1:3000/'),env);
  assert.ok(!page.headers.get('Content-Security-Policy').includes('plaid.com'));
} finally {globalThis.fetch=realFetch;env.LOCAL_ONLY=false;}

// Smoke the allowlisted browser module without a browser; visual layout remains unverified.
const html=await (await worker.fetch(new Request('https://ledger.test/'),env)).text();
assert.ok(html.includes('<script type="module" src="/assets/app.js"></script>'));
assert.ok(!html.includes('<script>'));
const assetResponse=await worker.fetch(new Request('https://ledger.test/assets/app.js'),env);
assert.equal(assetResponse.headers.get('Content-Type'),'text/javascript; charset=utf-8');
const client=await assetResponse.text();
const budgetAsset=await worker.fetch(new Request('https://ledger.test/assets/budgets.mjs'),env);
assert.equal(budgetAsset.headers.get('Content-Type'),'text/javascript; charset=utf-8');
assert.ok((await budgetAsset.text()).includes('resolveBudget'));
const browserClient=client.replace("import { budgetMonthKey, resolveBudget } from '/assets/budgets.mjs';",'');
assert.equal((await worker.fetch(new Request('https://ledger.test/assets/../worker/index.js'),env)).status,404);
const elements=new Map();
const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',className:'',addEventListener(){}});return elements.get(id);};
const queryNodes=new Map();
const querySelectorAll=selector=>{if(selector==='[data-open-demo]'){if(!queryNodes.has(selector))queryNodes.set(selector,[{onclick:null}]);return queryNodes.get(selector);}return [];};
vm.runInNewContext(browserClient,{document:{getElementById:element,querySelectorAll,activeElement:null},window:{scrollTo(){},addEventListener(){}},fetch:async()=>({ok:true,json:async()=>({items:[],accounts:[],transactions:[],budgets:{},setup:{configured:false}})}),budgetMonthKey,resolveBudget,URL,URLSearchParams,Date,Intl,Map,Set,JSON,Promise,console,setTimeout,clearTimeout,location:{href:'https://ledger.test/',pathname:'/'},history:{replaceState(){},pushState(){}},sessionStorage:{getItem:()=>null}});
await new Promise(resolve=>setTimeout(resolve,0));
assert.ok(element('app').innerHTML.includes('No accounts or transactions have been imported yet'));
assert.ok(!element('app').innerHTML.includes('Whole Foods Market'));
querySelectorAll('[data-open-demo]')[0].onclick();
assert.ok(element('app').innerHTML.includes('Sample data preview'));
assert.ok(element('app').innerHTML.includes('Spending over time'));
async function clientPage(href,stateOrError){
  const nodes=new Map();
  const get=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',className:'',addEventListener(){}});return nodes.get(id);};
  const selectors=new Map();
  const select=selector=>{if(selector==='[data-open-demo]'){if(!selectors.has(selector))selectors.set(selector,[{onclick:null}]);return selectors.get(selector);}return [];};
  const elements={document:{getElementById:get,querySelectorAll:select,activeElement:null},window:{scrollTo(){},addEventListener(){}},fetch:async()=>{if(stateOrError instanceof Error)throw stateOrError;return{ok:true,json:async()=>stateOrError};},URL,URLSearchParams,Date,Intl,Map,Set,JSON,Promise,console,setTimeout,clearTimeout,location:{href,pathname:'/'},history:{replaceState(){},pushState(){}},sessionStorage:{getItem:()=>null}};
  elements.budgetMonthKey=budgetMonthKey;elements.resolveBudget=resolveBudget;
  vm.runInNewContext(browserClient,elements);
  await new Promise(resolve=>setTimeout(resolve,0));
  return get('app').innerHTML;
}
const pageBase={items:[],accounts:[],transactions:[],budgets:{},setup:{configured:false,localOnly:true}};
const manualHtml=await clientPage('https://ledger.test/',{...pageBase,accounts:[{id:'manual-1',name:'Manual Savings',balance:123456,currency:'USD'}]});
assert.ok(manualHtml.includes('Your records are ready'));
assert.ok(manualHtml.includes('Manual Savings'));
assert.ok(manualHtml.includes('$1,234.56'));
const investmentsHtml=await clientPage('https://ledger.test/?page=investments',{...pageBase,items:[{id:'investment-item',name:'Fidelity',product:'investments',error:'Update unavailable'}],accounts:[{id:'plaid:investment-item:account-1',itemId:'investment-item',name:'Brokerage',type:'investment',balance:100000,currency:'USD'}],holdings:[{itemId:'investment-item',accountId:'plaid:investment-item:account-1',name:'Index fund',ticker:'IDX',quantity:2,value:100000,currency:'USD',asOf:'2026-10-01'}]});
assert.ok(investmentsHtml.includes('Investment account balances'));
assert.ok(investmentsHtml.includes('Balance unavailable')===false);
assert.ok(investmentsHtml.includes('Saved value; update failed'));
assert.ok(investmentsHtml.includes('Holdings'));
const budgetOnlyHtml=await clientPage('https://ledger.test/',{...pageBase,budgets:{Housing:150000}});
assert.ok(budgetOnlyHtml.includes('Saved monthly budgets'));
assert.ok(budgetOnlyHtml.includes('Housing'));
const importingHtml=await clientPage('https://ledger.test/?page=accounts',{...pageBase,items:[{id:'chase-item',name:'Chase'}],setup:{configured:true,localOnly:false,environment:'production'}});
assert.ok(importingHtml.includes('Waiting for the first successful sync'));
assert.ok(importingHtml.includes('<h1>Accounts</h1>'));
const settingsHtml=await clientPage('https://ledger.test/?page=settings',{...pageBase,setup:{configured:false,localOnly:true,syncTimer:{state:'available',enabled:false,active:false}},syncJob:{status:'succeeded',startedAt:'2026-10-25T12:00:00.000Z',completed:2,total:2,failures:[]}});
assert.ok(settingsHtml.includes('Disabled · inactive'));
assert.ok(settingsHtml.includes('Latest sync job'));
assert.ok(settingsHtml.includes('succeeded'));
const linkedEmptyHtml=await clientPage('https://ledger.test/',{...pageBase,items:[{id:'chase-item',name:'Chase'}],setup:{configured:true,localOnly:false,environment:'production'}});
assert.ok(linkedEmptyHtml.includes('Your bank is connected'));
assert.ok(linkedEmptyHtml.includes('first account and transaction data is still arriving'));
const errorHtml=await clientPage('https://ledger.test/',new Error('Service unavailable'));
assert.ok(errorHtml.includes('Ledger could not load your records'));
assert.ok(!errorHtml.includes('Whole Foods Market'));
const hostileMonthHtml=await clientPage('https://ledger.test/?page=transactions&month=%3Cscript%3Ealert(1)%3C%2Fscript%3E',pageBase);
assert.ok(!hostileMonthHtml.includes('<script>alert(1)</script>'));
const hostileCategoryHtml=await clientPage('https://ledger.test/?page=transactions',{...pageBase,categoryCatalog:[{id:'custom-1',name:'Gifts & <img src=x onerror=alert(1)>',kind:'expense',system:false,order:12,archivedAt:null}],transactions:[{id:'safe-tx',merchant:'Synthetic Merchant',amount:100,date:'2026-10-01',category:'Other',currency:'USD'}]});
assert.ok(!hostileCategoryHtml.includes('<img src=x onerror=alert(1)>'));
assert.ok(hostileCategoryHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));
const localParts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit'}).formatToParts(new Date()),thisMonth=localParts.find(x=>x.type==='year').value+'-'+localParts.find(x=>x.type==='month').value;
const monthBudgetHtml=await clientPage('https://ledger.test/?page=budgets&month='+thisMonth,{...pageBase,categoryCatalog:[{id:'system:housing',name:'Housing',kind:'expense',system:true,order:0,archivedAt:null}],budgetTemplates:[{categoryId:'system:housing',amount:50000,effectiveFrom:thisMonth}],monthlyBudgets:{[thisMonth+':system:housing']:0},budgetHistoryUnavailableBefore:thisMonth});
assert.ok(monthBudgetHtml.includes('Only '+thisMonth));
assert.ok(monthBudgetHtml.includes('Zero-dollar limit'));
console.log('Finance checks passed: totals, refunds/transfers, currencies, pending replacements, CSV validation/idempotency, authentication, encryption, incremental sync, persistence, disconnect, and client render.');
