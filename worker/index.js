// The loopback-only Node server supplies the local owner's identity.
import { CATEGORIES } from '../shared/categories.mjs';
import { budgetMonthKey, resolveBudget, validMonth } from '../shared/budgets.mjs';
import { cents } from '../shared/money.mjs';
import { accountRecord, investmentHoldings, providerAccountKey } from '../shared/investments.mjs';
import { categoryFor, fromPlaid, totals } from '../shared/reporting.mjs';
import { applyChanges, applySyncPages } from '../shared/reconciliation.mjs';
import { eligibleCashAccounts, summarizeGoals } from '../shared/goals.mjs';
import { amortizeFixedRate, compareAmortization, summarizeProperties } from '../shared/mortgages.mjs';
import { calculateHomeScenario, SCENARIO_CALCULATION_VERSION, validateScenarioInput } from '../shared/scenarios.mjs';
import { makeBalanceSheetSnapshot, summarizeBalanceSheet } from '../shared/net-worth.mjs';
import { BUILD_ID, UI_ASSETS } from './generated.mjs';
import { repositoryFor } from '../server/repository.mjs';

export { categoryFor, fromPlaid, totals, applyChanges, applySyncPages, investmentHoldings, eligibleCashAccounts, summarizeGoals, amortizeFixedRate, compareAmortization, summarizeProperties, calculateHomeScenario, validateScenarioInput, summarizeBalanceSheet, makeBalanceSheetSnapshot };

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
  const existing=state.accounts.filter(a=>a.itemId===itemId),previous=new Map(existing.map(a=>[a.providerAccountId||a.id,a]));
  const providerToLocal=new Map(),nextAccounts=accounts.map(raw=>{const next=accountRecord(raw,itemId),old=previous.get(raw.account_id);if(old){next.id=old.id;next.includeInReporting=old.includeInReporting;next.archivedAt=old.archivedAt;}providerToLocal.set(next.id===providerAccountKey(itemId,raw.account_id)?next.id:providerAccountKey(itemId,raw.account_id),next.id);return next;});
  state.accounts=state.accounts.filter(a=>a.itemId!==itemId).concat(nextAccounts);
  return providerToLocal;
}
function remapProviderAccountReferences(state,itemId,providerToLocal){
  for(const transaction of state.transactions)if(transaction.itemId===itemId&&providerToLocal.has(transaction.accountId))transaction.accountId=providerToLocal.get(transaction.accountId);
  for(const holding of state.holdings||[])if(holding.itemId===itemId&&providerToLocal.has(holding.accountId))holding.accountId=providerToLocal.get(holding.accountId);
}
const apiError = (message, status = 400) => Object.assign(new Error(message), { status });
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
function ready(env) { return !env.LOCAL_ONLY && !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET && env.TOKEN_ENCRYPTION_KEY && ['sandbox', 'production'].includes(env.PLAID_ENV)); }
function monthInReportingZone(date = new Date()) { const parts = new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit'}).formatToParts(date); return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}`; }
function dateInReportingZone(date = new Date()) { const parts = new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date); return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`; }
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
function checkRevision(state,input) { const revision=Number.isSafeInteger(state.revision)?state.revision:0;if (input.revision !== undefined && input.revision !== revision) throw apiError('This data changed in another tab. Reload it and try again.', 409); }
async function body(request) {
  const text = await request.text();
  if (text.length > 2_000_000) throw apiError('This upload is too large.', 413);
  try { return JSON.parse(text); } catch { throw apiError('Invalid request.'); }
}
async function plaid(env, path, params) {
  if (!ready(env)) throw apiError('Bank connections need setup. See the Banks page.', 503);
  const retryable=['/transactions/sync','/accounts/get','/investments/holdings/get'].includes(path),maxAttempts=retryable?3:1;
  for(let attempt=0;attempt<maxAttempts;attempt++){
    try{
      const result=await fetch(`https://${env.PLAID_ENV}.plaid.com${path}`,{method:'POST',headers:{'Content-Type':'application/json','Plaid-Version':'2020-09-14'},body:JSON.stringify({client_id:env.PLAID_CLIENT_ID,secret:env.PLAID_SECRET,...params}),signal:AbortSignal.timeout(25000)});
      let data;try{data=await result.json();}catch{data={};}
      if(result.ok)return data;
      if(retryable&&(result.status===429||result.status>=500)&&attempt+1<maxAttempts){await new Promise(resolve=>setTimeout(resolve,300*(2**attempt)));continue;}
      const messages={ITEM_LOGIN_REQUIRED:'Reconnect this account to resume updates.',PRODUCT_NOT_ENABLED:'Enable the requested product in your Plaid dashboard before connecting this account.',INSTITUTION_NOT_SUPPORTED:'This provider does not support the selected connection type.',NO_INVESTMENT_ACCOUNTS:'No supported investment accounts were found at this provider.',PRODUCT_NOT_READY:'Account data is still being prepared. Try syncing again shortly.',ADDITIONAL_CONSENT_REQUIRED:'Reconnect this account to authorize the required data access.',RATE_LIMIT_EXCEEDED:'The provider is rate-limiting updates. Try syncing again later.'};
      const error=apiError(messages[data.error_code]||'The account connection could not be updated. Please try again later.',502);error.plaidCode=data.error_code;throw error;
    }catch(error){if(error.status)throw error;if(!retryable||attempt+1>=maxAttempts)throw error;await new Promise(resolve=>setTimeout(resolve,300*(2**attempt)));}
  }
  throw apiError('The provider did not respond after retrying.',502);
}
async function tokenKey(env) {
  let bytes;
  try { bytes = Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY), c => c.charCodeAt(0)); } catch { throw apiError('Bank encryption needs setup.', 503); }
  if (bytes.length !== 32) throw apiError('Bank encryption needs setup.', 503);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export function parseCSV(text, allowedCategories = CATEGORIES, options = {}) {
  const rows=[];let row=[],value='',quoted=false,afterQuote=false,line=1,rowLine=1;
  text=String(text).replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){
      if(c==="\""&&text[i+1]==='"'){value+='"';i++;}
      else if(c==='"'){quoted=false;afterQuote=true;}
      else{value+=c;if(c==='\n')line++;}
    }else if(c==='"'){
      if(value!==''||afterQuote)throw apiError('Unexpected quote at CSV row '+rowLine+'.');quoted=true;
    }else if(c===','){
      row.push(value);value='';afterQuote=false;
    }else if(c==='\n'||c==='\r'){
      row.push(value);if(row.some(v=>v.trim()))rows.push({values:row,line:rowLine});row=[];value='';afterQuote=false;if(c==='\r'&&text[i+1]==='\n')i++;line++;rowLine=line;
    }else if(afterQuote){if(!/\s/.test(c))throw apiError('Unexpected text after a quoted CSV field at row '+rowLine+'.');}
    else value+=c;
  }
  if(quoted)throw apiError('A quoted CSV field is not closed.');
  row.push(value);if(row.some(v=>v.trim()))rows.push({values:row,line:rowLine});
  if(rows.length<2)throw apiError('Add a header row and at least one transaction.');
  const header=rows.shift().values.map(v=>v.trim());
  if(new Set(header.map(v=>v.normalize('NFKC').toLocaleLowerCase('en-US'))).size!==header.length)throw apiError('CSV column names must be unique.');
  if(rows.length>5000)throw apiError('Import up to 5,000 transactions at a time.');
  const names=Object.fromEntries(header.map(h=>[h.normalize('NFKC').trim().toLocaleLowerCase('en-US'),h]));
  const mapping={date:names.date,merchant:names.merchant||names.description,amount:names.amount,category:names.category,currency:names.currency,status:names.status,...(options.columnMapping||{})};
  for(const field of ['date','merchant','amount'])if(!mapping[field]||!header.includes(mapping[field]))throw apiError('Select a CSV column for '+field+'.');
  for(const field of ['category','currency','status'])if(mapping[field]&&!header.includes(mapping[field]))throw apiError('Select a valid CSV column for '+field+'.');
  if(new Set([mapping.date,mapping.merchant,mapping.amount]).size!==3)throw apiError('Date, merchant, and amount need separate CSV columns.');
  const dateFormat=options.dateFormat||'YYYY-MM-DD',amountMode=options.amountMode||'positive-spending',categoryMapping=options.categoryMapping||{};
  if(!['YYYY-MM-DD','MM/DD/YYYY','DD/MM/YYYY'].includes(dateFormat))throw apiError('Choose a supported date format.');
  if(!['positive-spending','negative-spending'].includes(amountMode))throw apiError('Choose a supported amount sign convention.');
  return rows.map(({values,line:rowNumber})=>{
    if(values.length!==header.length)throw apiError('CSV row '+rowNumber+' has '+values.length+' fields; expected '+header.length+'.');
    const get=key=>mapping[key]?(values[header.indexOf(mapping[key])]||'').trim():'';
    let date=get('date');
    if(dateFormat==='MM/DD/YYYY'&&/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)){const [m,d,y]=date.split('/');date=`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;}
    if(dateFormat==='DD/MM/YYYY'&&/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)){const [d,m,y]=date.split('/');date=`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;}
    const merchant=get('merchant'),amount=get('amount'),sourceCategory=get('category')||'Other';
    if(!validDateOnly(date))throw apiError('Invalid date at CSV row '+rowNumber+'.');
    if(!merchant||merchant.length>300)throw apiError('Invalid merchant at CSV row '+rowNumber+'.');
    if(!/^-?\d{1,9}(\.\d{1,2})?$/.test(amount))throw apiError('Use a plain amount with up to two decimal places at CSV row '+rowNumber+'.');
    let category=sourceCategory,unknownCategory=null,storedSourceCategory=null;
    if(!allowedCategories.includes(category)){if(categoryMapping[category]&&allowedCategories.includes(categoryMapping[category])){storedSourceCategory=category;category=categoryMapping[category];}else if(options.allowUnknownCategories){unknownCategory=category;category='Other';}else throw apiError('Unknown category at CSV row '+rowNumber+': '+category+'. Map it to an existing bucket or create that bucket first.');}
    const currency=get('currency');if(currency&&currency!=='USD')throw apiError('CSV import currently supports USD only.');
    const status=get('status').toLowerCase();if(status&&!['pending','posted'].includes(status))throw apiError('Use Posted or Pending status at CSV row '+rowNumber+'.');
    const centsAmount=Math.round(Number(amount)*100)*(amountMode==='negative-spending'?-1:1);
    return{date,merchant,amount:centsAmount,category,pending:status==='pending',currency:'USD',...(unknownCategory?{unknownCategory}:{}),...(storedSourceCategory?{sourceCategory:storedSourceCategory}:{}),sourceRow:rowNumber};
  });
}
async function hash(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2,'0')).join(''); }
function transactionFingerprint(row){return [row.date,String(row.merchant||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US'),row.amount,row.currency||'USD'].join('|');}
async function prepareCsvImport(input,state){
  if(typeof input.csv!=='string'||input.csv.length>1_000_000||typeof input.account!=='string'||!input.account.trim()||input.account.trim().length>100)throw apiError('Choose a CSV under 1 MB and enter an account name.');
  const name=input.account.trim(),accountId='csv:'+await hash(name.normalize('NFKC').toLocaleLowerCase('en-US')),fileId=await hash(accountId+'\n'+input.csv);
  const options={columnMapping:input.columnMapping||{},dateFormat:input.dateFormat||'YYYY-MM-DD',amountMode:input.amountMode||'positive-spending',categoryMapping:input.categoryMapping||{},allowUnknownCategories:true};
  const rows=parseCSV(input.csv,categories(state),options),unknownCategories=[...new Set(rows.map(row=>row.unknownCategory).filter(Boolean))];
  const existingBatch=(state.importBatches||[]).find(batch=>batch.id===fileId);
  const fingerprints=new Map();for(const transaction of state.transactions){const key=transactionFingerprint(transaction);if(!fingerprints.has(key))fingerprints.set(key,[]);fingerprints.get(key).push(transaction);}
  const overlaps=existingBatch?[]:rows.flatMap((row,index)=>{const candidates=fingerprints.get(transactionFingerprint(row))||[];return candidates.length?[{row:index+1,date:row.date,merchant:row.merchant,amount:row.amount,existingIds:candidates.slice(0,3).map(t=>t.id)}]:[];});
  const firstRecord=input.csv.replace(/^\uFEFF/,'').split(/\r?\n/,1)[0],headers=[...firstRecord.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map(match=>(match[1]??match[2]??'').replaceAll('""','"').trim()).filter((_,index)=>index===0||true);
  return{name,accountId,fileId,rows,unknownCategories,existingBatch,overlaps,revision:Number.isSafeInteger(state.revision)?state.revision:0,headers};
}

async function encryptToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv: base64(iv), data: base64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tokenKey(env), new TextEncoder().encode(token))) };
}
async function decryptToken(env, value) {
  const decode = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv) }, await tokenKey(env), decode(value.data)));
}
const syncRunners=new WeakMap();
function assertSyncOwner(state,jobId){if(state.syncJob?.id!==jobId||state.syncJob.status!=='running')throw apiError('Sync job was superseded. Please try again.',409);if(Date.now()-Date.parse(state.syncJob.startedAt)>15*60_000)throw apiError('Sync exceeded its 15-minute run limit.',504);}
async function syncOwned(env,jobId){const {state}=await readState(env);if(state.syncJob?.id!==jobId||state.syncJob.status!=='running')throw apiError('Sync job is no longer active.',409);if(Date.now()-Date.parse(state.syncJob.startedAt)>15*60_000)throw apiError('Sync exceeded its 15-minute run limit.',504);return state;}
async function runSyncJob(env,jobId){
  const failures=[];
  try{
    const initial=await syncOwned(env,jobId),items=initial.items.filter(item=>item.lifecycle!=='unlinked');
    for(const item of items){
      await syncOwned(env,jobId);
      try{
        if(!item.environment||item.environment!==env.PLAID_ENV)throw apiError('Connection environment must be verified before syncing. Reconnect only after the saved environment is confirmed.');
        const access_token=await decryptToken(env,item.token);
        if(item.product==='investments'){
          const data=await plaid(env,'/investments/holdings/get',{access_token});
          const holdings=investmentHoldings(data,item.id);
          await mutate(env,s=>{
            assertSyncOwner(s,jobId);
            const liveItem=s.items.find(i=>i.id===item.id);if(!liveItem||liveItem.lifecycle==='unlinked')return;
            s.holdings=(s.holdings||[]).filter(h=>h.itemId!==item.id).concat(holdings);
            const providerToLocal=replaceProviderAccounts(s,item.id,data.accounts);remapProviderAccountReferences(s,item.id,providerToLocal);
            liveItem.lastAttempt=liveItem.lastAttempt||new Date().toISOString();liveItem.lastSync=new Date().toISOString();liveItem.lastSuccess=liveItem.lastSync;liveItem.error=null;
            s.syncJob.completed+=1;s.syncJob.lastHeartbeatAt=new Date().toISOString();
          });
          continue;
        }
        let result;
        for(let attempt=0;attempt<3;attempt++){
          let cursor=item.cursor||undefined;const pages=[];
          try{
            for(let page=0;;page++){
              if(page>=100)throw apiError('This bank has more history than one sync can process.',502);
              await syncOwned(env,jobId);
              const data=await plaid(env,'/transactions/sync',{access_token,...(cursor?{cursor}:{}),count:500});
              pages.push({added:data.added,modified:data.modified,removed:data.removed});cursor=data.next_cursor;if(!data.has_more)break;
            }
            result={pages,cursor};break;
          }catch(e){if(e.plaidCode!=='TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'||attempt===2)throw e;}
        }
        const accountData=await plaid(env,'/accounts/get',{access_token});
        await mutate(env,s=>{
          assertSyncOwner(s,jobId);
          const liveItem=s.items.find(i=>i.id===item.id);if(!liveItem||liveItem.lifecycle==='unlinked')return;
          applySyncPages(s,item.id,result.pages);liveItem.cursor=result.cursor;liveItem.lastSync=new Date().toISOString();liveItem.lastSuccess=liveItem.lastSync;liveItem.error=null;
          const providerToLocal=replaceProviderAccounts(s,item.id,accountData.accounts);remapProviderAccountReferences(s,item.id,providerToLocal);
          s.syncJob.completed+=1;s.syncJob.lastHeartbeatAt=new Date().toISOString();
        });
      }catch(error){
        if(error.status===409&&error.message==='Sync job is no longer active.')throw error;
        const failure={bank:item.name,message:error.status?error.message:'Bank update failed. Try again later.'};failures.push(failure);
        await mutate(env,s=>{assertSyncOwner(s,jobId);const liveItem=s.items.find(i=>i.id===item.id);if(liveItem){liveItem.lastAttempt=new Date().toISOString();liveItem.error=failure.message;}s.syncJob.completed+=1;s.syncJob.failures.push(failure);s.syncJob.lastHeartbeatAt=new Date().toISOString();});
      }
    }
    await mutate(env,s=>{assertSyncOwner(s,jobId);const now=new Date().toISOString();s.syncJob.status=failures.length===0?'succeeded':failures.length===items.length?'failed':'partial';s.syncJob.finishedAt=now;s.syncJob.lastHeartbeatAt=now;if(!failures.length)s.lastSync=now;});
  }catch(error){
    await mutate(env,s=>{if(s.syncJob?.id===jobId&&s.syncJob.status==='running'){s.syncJob.status='failed';s.syncJob.finishedAt=new Date().toISOString();s.syncJob.failures.push({bank:'Sync',message:error.status?error.message:'Sync stopped unexpectedly.'});}}).catch(()=>{});
  }finally{if(syncRunners.get(env)?.id===jobId)syncRunners.delete(env);}
}
async function startSync(env,source='manual'){
  const {state:current}=await readState(env),active=current.items.filter(item=>item.lifecycle!=='unlinked');
  if(!active.length)return{job:{id:null,status:'skipped',failures:[],completed:0,total:0}};
  const running=current.syncJob?.status==='running';
  if(running&&syncRunners.get(env)?.id===current.syncJob.id)return{job:current.syncJob,joined:true};
  if(running)await mutate(env,s=>{if(s.syncJob?.id===current.syncJob.id&&s.syncJob.status==='running'){s.syncJob.status='interrupted';s.syncJob.finishedAt=new Date().toISOString();s.syncJob.failures=[...(s.syncJob.failures||[]),{bank:'Sync',message:'The previous sync stopped before it completed. Start another sync to continue.'}];}});
  const id=crypto.randomUUID(),startedAt=new Date().toISOString();
  let saved;try{saved=await mutate(env,s=>{if(s.syncJob?.status==='running')throw apiError('A bank sync is already running.',409);const items=s.items.filter(item=>item.lifecycle!=='unlinked');s.syncJob={id,status:'running',source,startedAt,lastHeartbeatAt:startedAt,finishedAt:null,total:items.length,completed:0,failures:[]};for(const item of items)item.lastAttempt=startedAt;});}catch(error){if(error.status===409){const {state:latest}=await readState(env);if(latest.syncJob?.status==='running'&&syncRunners.get(env)?.id===latest.syncJob.id)return{job:latest.syncJob,joined:true};}throw error;}
  const runner=Promise.resolve().then(()=>runSyncJob(env,id));syncRunners.set(env,{id,promise:runner});
  return{job:saved.syncJob,joined:false};
}
async function syncStatus(env){const repository=repositoryFor(env);let state=typeof repository.readSyncJob==='function'?{syncJob:await repository.readSyncJob()}:(await readState(env)).state;if(state.syncJob?.status==='running'&&!syncRunners.has(env)){const id=state.syncJob.id;state=await mutate(env,s=>{if(s.syncJob?.id===id&&s.syncJob.status==='running'){s.syncJob.status='interrupted';s.syncJob.finishedAt=new Date().toISOString();s.syncJob.failures=[...(s.syncJob.failures||[]),{bank:'Sync',message:'The previous sync stopped before it completed.'}];}});}return state.syncJob||null;}

async function publicState(state, env) {
  const currentBudgetMonth = monthInReportingZone();
  const templates = budgetTemplates(state), overrides = state.monthlyBudgets || {};
  const budgets = Object.fromEntries(categoryCatalog(state).filter(c=>c.kind==='expense'&&!c.archivedAt).map(c=>[c.name,resolveBudget(templates,overrides,c.id,currentBudgetMonth).amount]).filter(([,amount])=>amount!==null));
  const goalSummary=summarizeGoals(state.goals||[],state.goalAllocations||[],state.accounts,state.items,new Date());
  const propertySummary=summarizeProperties(state.properties||[],state.mortgages||[],state.accounts);
  const balanceSheet=summarizeBalanceSheet(state.accounts,state.items,propertySummary,new Date());
  return { ...state, budgets, budgetTemplates: templates, monthlyBudgets: overrides, budgetHistoryUnavailableBefore: state.budgetHistoryUnavailableBefore || currentBudgetMonth, categories: categories(state), categoryCatalog: categoryCatalog(state), holdings: state.holdings || [], goalSummary, propertySummary, balanceSheet, owner: undefined, lease: undefined, items: state.items.map(({ token, cursor, ...i }) => i), setup: { localOnly: !!env.LOCAL_ONLY, configured: ready(env), environment: env.PLAID_ENV || 'not configured', syncTimer: typeof env.getSyncTimerStatus==='function'?await env.getSyncTimerStatus():{state:'unavailable',enabled:null,active:null}, backup: typeof env.getBackupStatus==='function'?await env.getBackupStatus():{state:'unavailable',timer:{state:'unavailable',enabled:null,active:null}} } };
}
function scenarioFunding(state, linkedGoalId, asOf=new Date()) {
  const summary=summarizeGoals(state.goals||[],state.goalAllocations||[],state.accounts,state.items,asOf);
  const goal=linkedGoalId?summary.goals.find(value=>value.id===linkedGoalId&&!value.archived):null;
  if(linkedGoalId&&!goal)throw apiError('Choose an active savings goal.');
  return{goal,snapshot:{eligibleCash:summary.unallocatedTotal,allocatedGoalFunds:goal?.backed||0,asOf:asOf.toISOString()}};
}
function requireCompleteSavedScenario(scenario){
  const validation=validateScenarioInput(scenario.inputs||{});
  if(validation)throw apiError('This saved estimate needs input review before it can create a goal or budget: '+validation);
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
      if(['link-token','exchange-token','sync','scheduled-sync','sync-status','disconnect','delete-history'].some(action=>path===`/api/${action}`)&&!ready(env))return response({error:'Bank connections are disabled. Import CSV files for local-only operation.'},503);
      const repository=repositoryFor(env);
      if(request.method==='GET'&&typeof repository.readDashboard==='function'&&['/api/health','/api/state','/api/transactions','/api/month-summary','/api/scenarios','/api/sync-status'].includes(path)){
        const state=path==='/api/state'?(await repository.readDashboard()).state:await repository.readIdentity();
        if(state.owner&&state.owner!==user)return response({error:'This dashboard belongs to another account.'},403);
        if(path==='/api/health')return response({codeVersion:typeof BUILD_ID==='string'?BUILD_ID:'unversioned',schemaVersion:Number.isInteger(repository.schemaVersion)?repository.schemaVersion:Number.isInteger(state.version)?state.version:null,configurationReady:ready(env),localOnly:!!env.LOCAL_ONLY,lastSync:state.lastSync||null});
        if(path==='/api/state')return response(await publicState(state,env));
        if(path==='/api/transactions'){
          const query=url.searchParams,page=Number(query.get('page')||1),limit=Math.min(100,Math.max(1,Number(query.get('limit')||50))),search=(query.get('search')||'').slice(0,120),category=query.get('category')||'',accountId=query.get('account')||'',from=query.get('from')||'',to=query.get('to')||'',review=query.get('review')==='true';
          if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||from&&!validDateOnly(from)||to&&!validDateOnly(to))throw apiError('Choose a valid transaction page and date range.');
          return response(await repository.queryTransactions({page,limit,search,category,accountId,from,to,review}));
        }
        if(path==='/api/month-summary'){
          const month=url.searchParams.get('month')||monthInReportingZone();if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw apiError('Choose a valid reporting month.');
          return response(await repository.queryMonthSummary(month));
        }
        if(path==='/api/sync-status')return response({job:await syncStatus(env)});
        return response({scenarios:await repository.readScenarios()});
      }
      const { state, storageSchemaVersion } = await readState(env);
      if (state.owner && state.owner !== user) return response({ error: 'This dashboard belongs to another account.' }, 403);
      if (path === '/api/health' && request.method === 'GET') return response({ codeVersion: typeof BUILD_ID === 'string' ? BUILD_ID : 'unversioned', schemaVersion: Number.isInteger(storageSchemaVersion) ? storageSchemaVersion : Number.isInteger(state.version) ? state.version : null, configurationReady: ready(env), localOnly: !!env.LOCAL_ONLY, lastSync: state.lastSync || null });
      if (['/api/link-token', '/api/exchange-token', '/api/sync', '/api/scheduled-sync', '/api/sync-status', '/api/disconnect', '/api/delete-history'].includes(path) && !ready(env)) return response({ error: 'Bank connections are disabled. Import CSV files for local-only operation.' }, 503);
      if (path === '/api/state' && request.method === 'GET') return response(await publicState(state, env));
      if(path==='/api/sync-status'&&request.method==='GET')return response({job:await syncStatus(env)});
      if(path==='/api/transactions'&&request.method==='GET'){
        const query=url.searchParams,page=Number(query.get('page')||1),limit=Math.min(100,Math.max(1,Number(query.get('limit')||50))),search=(query.get('search')||'').slice(0,120).toLocaleLowerCase('en-US'),category=query.get('category')||'',accountId=query.get('account')||'',from=query.get('from')||'',to=query.get('to')||'',review=query.get('review')==='true';
        if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||from&&!validDateOnly(from)||to&&!validDateOnly(to))throw apiError('Choose a valid transaction page and date range.');
        const matches=state.transactions.filter(t=>(!search||String(t.merchant||'').toLocaleLowerCase('en-US').includes(search))&&(!category||(t.overrideCategoryId===category||(!t.overrideCategoryId&&(t.override||t.category)===category)||t.override===category||t.category===category))&&(!accountId||t.accountId===accountId)&&(!from||t.date>=from)&&(!to||t.date<=to)&&(!review||t.review===true||t.confidence!==undefined&&t.confidence<0.5||(t.override||t.category)==='Other')).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
        return response({page,limit,total:matches.length,transactions:matches.slice((page-1)*limit,page*limit),revision:state.revision});
      }
      if(path==='/api/balance-snapshot'&&request.method==='POST'){
        const input=await body(request),date=dateInReportingZone(new Date());if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before recording a balance snapshot.',409);
        const existing=(state.balanceSheetSnapshots||[]).find(snapshot=>snapshot.date===date);if(existing)return response({ok:true,existing:true,snapshot:existing,revision:state.revision||0});
        const summary=summarizeBalanceSheet(state.accounts,state.items,summarizeProperties(state.properties||[],state.mortgages||[],state.accounts),new Date()),snapshot=makeBalanceSheetSnapshot(summary,date);
        const saved=await mutate(env,s=>{checkRevision(s,input);s.balanceSheetSnapshots||=[];if(!s.balanceSheetSnapshots.some(row=>row.date===date))s.balanceSheetSnapshots.push(snapshot);});return response({ok:true,existing:false,snapshot,revision:saved.revision});
      }
      if(path==='/api/scenario-calculate'&&request.method==='POST'){
        const input=await body(request),scenarioInput=input.input||{},linkedGoalId=input.linkedGoalId||scenarioInput.linkedGoalId||null,asOf=new Date(),{snapshot}=scenarioFunding(state,linkedGoalId,asOf),result=calculateHomeScenario(scenarioInput,snapshot);
        if(!result.available)throw apiError(result.error||'Scenario inputs are incomplete.');return response({result,calculationVersion:SCENARIO_CALCULATION_VERSION});
      }
      if(path==='/api/scenario'&&request.method==='POST'){
        const input=await body(request);if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before saving a scenario.',409);
        if(input.action==='archive'||input.action==='restore'||input.action==='rename'||input.action==='duplicate'){
          let scenario;const saved=await mutate(env,s=>{checkRevision(s,input);s.scenarios||=[];const existing=s.scenarios.find(row=>row.id===input.id);if(!existing)throw apiError('Scenario not found.',404);if(input.action==='rename'){const name=typeof input.name==='string'?input.name.trim():'';if(!name||name.length>100)throw apiError('Enter a scenario name up to 100 characters.');existing.name=name;existing.updatedAt=new Date().toISOString();scenario=existing;}else if(input.action==='archive'||input.action==='restore'){existing.archivedAt=input.action==='archive'?existing.archivedAt||new Date().toISOString():null;existing.updatedAt=new Date().toISOString();scenario=existing;}else{scenario={...existing,id:crypto.randomUUID(),name:(typeof input.name==='string'&&input.name.trim()?input.name.trim():existing.name+' copy').slice(0,100),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1,versions:[],archivedAt:null};s.scenarios.push(scenario);}});return response({ok:true,revision:saved.revision,scenario});
        }
        const scenarioInput=input.input||{},validation=validateScenarioInput(scenarioInput);if(validation)throw apiError(validation);const goalId=input.linkedGoalId||scenarioInput.linkedGoalId||null,asOf=new Date(),{snapshot:fundingSnapshot}=scenarioFunding(state,goalId,asOf),result=calculateHomeScenario(scenarioInput,fundingSnapshot);if(!result.available)throw apiError(result.error||'Scenario inputs are incomplete.');
        let savedScenario;const saved=await mutate(env,s=>{checkRevision(s,input);s.scenarios||=[];const existing=input.id?s.scenarios.find(row=>row.id===input.id):null;if(input.id&&!existing)throw apiError('Scenario not found.',404);const now=new Date().toISOString(),versions=[...(existing?.versions||[])];if(existing)versions.push({version:existing.version||1,inputs:existing.inputs,fundingSnapshot:existing.fundingSnapshot,result:existing.result,calculationVersion:existing.calculationVersion,savedAt:existing.updatedAt});savedScenario={...(existing||{}),id:existing?.id||crypto.randomUUID(),name:scenarioInput.name.trim(),inputs:{...scenarioInput,linkedGoalId:goalId},linkedGoalId:goalId,fundingSnapshot,result,inputVersion:1,version:(existing?.version||0)+1,versions,calculationVersion:SCENARIO_CALCULATION_VERSION,createdAt:existing?.createdAt||now,updatedAt:now,archivedAt:null};if(existing)Object.assign(existing,savedScenario);else s.scenarios.push(savedScenario);s.owner=user;});return response({ok:true,revision:saved.revision,scenario:savedScenario});
      }
      if(path==='/api/scenario-goal'&&request.method==='POST'){
        const input=await body(request);if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before linking a goal.',409);const scenario=(state.scenarios||[]).find(row=>row.id===input.scenarioId&&!row.archivedAt);if(!scenario)throw apiError('Scenario not found.',404);
        requireCompleteSavedScenario(scenario);
        if(!validDateOnly(scenario.inputs.targetDate))throw apiError('Add a target date to the scenario before creating a savings goal.');if(!Number.isSafeInteger(scenario.result.allInAcquisitionFunding)||scenario.result.allInAcquisitionFunding>100_000_000_000)throw apiError('The scenario target is above the supported savings-goal limit.');let goalId;
        const saved=await mutate(env,s=>{checkRevision(s,input);const live=s.scenarios.find(row=>row.id===scenario.id&&!row.archivedAt);if(!live)throw apiError('Scenario is no longer active.',409);s.goals||=[];const goal=live.linkedGoalId?s.goals.find(row=>row.id===live.linkedGoalId&&!row.archivedAt):null;if(input.action==='update'){if(!goal)throw apiError('This scenario has no active linked goal.',409);goal.target=live.result.allInAcquisitionFunding;goal.targetDate=live.inputs.targetDate;goal.updatedAt=new Date().toISOString();goalId=goal.id;}else{if(goal)throw apiError('This scenario already has a linked goal. Use update to propose its new target.',409);const now=new Date().toISOString();const created={id:crypto.randomUUID(),name:(live.name+' down payment').slice(0,100),target:live.result.allInAcquisitionFunding,targetDate:live.inputs.targetDate,priority:100,monthlyContribution:0,apyBps:0,apyAsOf:null,createdAt:now,updatedAt:now,archivedAt:null};s.goals.push(created);live.linkedGoalId=created.id;live.inputs.linkedGoalId=created.id;goalId=created.id;}live.updatedAt=new Date().toISOString();});return response({ok:true,revision:saved.revision,goalId});
      }
      if(path==='/api/scenario-budget'&&request.method==='POST'){
        const input=await body(request);if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before creating a budget.',409);const scenario=(state.scenarios||[]).find(row=>row.id===input.scenarioId&&!row.archivedAt);if(!scenario)throw apiError('Scenario not found.',404);requireCompleteSavedScenario(scenario);const amount=scenario.result.ownershipOutflow;if(!Number.isSafeInteger(amount)||amount<0||amount>100_000_000)throw apiError('The projected housing outflow is outside the monthly budget limit.');const month=monthInReportingZone(),housing=categoryCatalog(state).find(category=>category.name==='Housing'&&category.kind==='expense'&&!category.archivedAt);if(!housing)throw apiError('Housing budget category is unavailable.');const saved=await mutate(env,s=>{checkRevision(s,input);s.budgetTemplates=budgetTemplates(s);const index=s.budgetTemplates.findIndex(entry=>entry.categoryId===housing.id&&entry.effectiveFrom===month),template={categoryId:housing.id,amount,effectiveFrom:month};if(index>=0)s.budgetTemplates[index]=template;else s.budgetTemplates.push(template);s.budgets={...(s.budgets||{}),Housing:amount};});return response({ok:true,revision:saved.revision,amount,month});
      }
      if(path==='/api/property'&&request.method==='POST'){
        const input=await body(request);if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before saving a property.',409);
        if(input.action==='archive'||input.action==='restore'){
          const saved=await mutate(env,s=>{checkRevision(s,input);const property=s.properties?.find(row=>row.id===input.id);if(!property)throw apiError('Property not found.',404);property.archivedAt=input.action==='archive'?property.archivedAt||new Date().toISOString():null;property.updatedAt=new Date().toISOString();});
          return response({ok:true,revision:saved.revision});
        }
        const name=typeof input.name==='string'?input.name.trim():'';
        if(!name||name.length>100||input.address!==undefined&&(typeof input.address!=='string'||input.address.length>300)||input.ownershipBps!==undefined&&(!Number.isSafeInteger(input.ownershipBps)||input.ownershipBps<1||input.ownershipBps>10000)||input.valuation!==null&&input.valuation!==undefined&&(!Number.isSafeInteger(input.valuation)||input.valuation<0||input.valuation>100_000_000_000_000)||input.valuation!==null&&input.valuation!==undefined&&!validDateOnly(input.valuationAsOf)||input.valuationSource!==undefined&&!['owner_estimate','appraisal','statement','other'].includes(input.valuationSource))throw apiError('Enter a valid property name, ownership share, and observed valuation.');
        let property;const saved=await mutate(env,s=>{checkRevision(s,input);s.properties||=[];const existing=input.id?s.properties.find(row=>row.id===input.id):null;if(input.id&&!existing)throw apiError('Property not found.',404);const now=new Date().toISOString();property={...(existing||{}),id:existing?.id||crypto.randomUUID(),name,address:input.address?.trim()||'',ownershipBps:input.ownershipBps??10000,valuation:input.valuation??null,valuationAsOf:input.valuation==null?null:input.valuationAsOf,valuationSource:input.valuation==null?null:input.valuationSource||'owner_estimate',createdAt:existing?.createdAt||now,updatedAt:now,archivedAt:null};if(existing)Object.assign(existing,property);else s.properties.push(property);s.owner=user;});return response({ok:true,revision:saved.revision,property});
      }
      if(path==='/api/mortgage'&&request.method==='POST'){
        const input=await body(request);if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before saving a mortgage.',409);
        if(input.action==='archive'||input.action==='restore'){
          const saved=await mutate(env,s=>{checkRevision(s,input);const mortgage=s.mortgages?.find(row=>row.id===input.id);if(!mortgage)throw apiError('Mortgage not found.',404);mortgage.archivedAt=input.action==='archive'?mortgage.archivedAt||new Date().toISOString():null;mortgage.updatedAt=new Date().toISOString();});return response({ok:true,revision:saved.revision});
        }
        const property=(state.properties||[]).find(row=>row.id===input.propertyId&&!row.archivedAt),loanTypes=['fixed','adjustable','interest_only','balloon','heloc','other'],loanType=input.loanType||'fixed',lender=typeof input.lender==='string'?input.lender.trim():'';
        const rate=String(input.annualRatePercent??'');const components=input.components||{};const componentNames=['principalInterest','propertyTax','homeownersInsurance','mortgageInsurance','hoa','otherRequired','extraPrincipal'];
        if(!property||lender.length>100||!loanTypes.includes(loanType)||input.statementBalance!==null&&input.statementBalance!==undefined&&(!Number.isSafeInteger(input.statementBalance)||input.statementBalance<0||input.statementBalance>100_000_000_000_000)||input.statementBalance!==null&&input.statementBalance!==undefined&&!validDateOnly(input.balanceAsOf)||input.originalPrincipal!==null&&input.originalPrincipal!==undefined&&(!Number.isSafeInteger(input.originalPrincipal)||input.originalPrincipal<=0)||input.originationDate!==null&&input.originationDate!==undefined&&!validDateOnly(input.originationDate)||rate.length>16||rate!==''&&(!/^\d{1,3}(?:\.\d{1,8})?$/.test(rate)||Number(rate)>100)||input.termMonths!==null&&input.termMonths!==undefined&&(!Number.isSafeInteger(input.termMonths)||input.termMonths<1||input.termMonths>1200)||componentNames.some(key=>components[key]!==undefined&&components[key]!==null&&(!Number.isSafeInteger(components[key])||components[key]<0))||input.linkedAccountId!==null&&input.linkedAccountId!==undefined&&!state.accounts.some(account=>account.id===input.linkedAccountId&&!account.archivedAt&&['credit','loan','liability','mortgage'].includes(String(account.type||'').toLowerCase()))||input.ownerDebtShareBps!==null&&input.ownerDebtShareBps!==undefined&&(!Number.isSafeInteger(input.ownerDebtShareBps)||input.ownerDebtShareBps<0||input.ownerDebtShareBps>10000))throw apiError('Enter a valid property, loan type, observed balance, terms, payment components, and liability link.');
        if(property.ownershipBps<10000&&input.ownerDebtShareBps==null)throw apiError('For a partially owned property, enter your explicit share of this loan.');
        if(input.linkedAccountId&&(state.mortgages||[]).some(mortgage=>mortgage.id!==input.id&&!mortgage.archivedAt&&mortgage.linkedAccountId===input.linkedAccountId))throw apiError('That liability is already linked to another mortgage record.');
        let mortgage,statementChanged=false;const now=new Date().toISOString();const saved=await mutate(env,s=>{checkRevision(s,input);s.mortgages||=[];s.mortgageSnapshots||=[];const existing=input.id?s.mortgages.find(row=>row.id===input.id):null;if(input.id&&!existing)throw apiError('Mortgage not found.',404);statementChanged=!existing||existing.statementBalance!==(input.statementBalance??null)||existing.balanceAsOf!==(input.statementBalance==null?null:input.balanceAsOf);mortgage={...(existing||{}),id:existing?.id||crypto.randomUUID(),propertyId:property.id,lender,loanType,linkedAccountId:input.linkedAccountId||null,ownerDebtShareBps:input.ownerDebtShareBps??(property.ownershipBps===10000?10000:null),statementBalance:input.statementBalance??null,balanceAsOf:input.statementBalance==null?null:input.balanceAsOf,originalPrincipal:input.originalPrincipal??null,originationDate:input.originationDate||null,annualRatePercent:rate||null,termMonths:input.termMonths??null,components:Object.fromEntries(componentNames.map(key=>[key,components[key]??null])),taxInsuranceEscrowed:input.taxInsuranceEscrowed===true,createdAt:existing?.createdAt||now,updatedAt:now,archivedAt:null};if(existing)Object.assign(existing,mortgage);else s.mortgages.push(mortgage);if(mortgage.statementBalance!==null&&statementChanged)s.mortgageSnapshots.push({id:crypto.randomUUID(),mortgageId:mortgage.id,balance:mortgage.statementBalance,asOf:mortgage.balanceAsOf,recordedAt:now,source:'manual'});s.owner=user;});return response({ok:true,revision:saved.revision,mortgage});
      }
      if(path==='/api/mortgage-projection'&&request.method==='POST'){
        const input=await body(request),mortgage=(state.mortgages||[]).find(row=>row.id===input.id&&!row.archivedAt);if(!mortgage)throw apiError('Mortgage not found.',404);
        const base=mortgage.loanType==='fixed'&&mortgage.originalPrincipal!==null&&mortgage.annualRatePercent!==null&&mortgage.termMonths!==null?compareAmortization({principal:mortgage.originalPrincipal,annualRatePercent:mortgage.annualRatePercent,termMonths:mortgage.termMonths,extraPrincipal:input.extraPrincipal??mortgage.components?.extraPrincipal??0}):{available:false,reason:'Projection unavailable for this loan type or incomplete original terms.'};
        const mortgageSummary=summarizeProperties(state.properties||[],state.mortgages||[],state.accounts).properties.find(property=>property.id===mortgage.propertyId)?.mortgages.find(row=>row.id===mortgage.id);return response({projection:base,statementBalance:mortgage.statementBalance,balanceAsOf:mortgage.balanceAsOf,projectedBalanceAtStatement:mortgageSummary?.projectedBalanceAtStatement??null,balanceVariance:mortgageSummary?.balanceVariance??null,calculationVersion:'fixed-monthly-v1'});
      }
      if(path==='/api/goal'&&request.method==='POST'){
        const input=await body(request),name=typeof input.name==='string'?input.name.trim():'';
        if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before saving a goal.',409);
        if(input.action==='archive'){
          const saved=await mutate(env,s=>{checkRevision(s,input);const goal=s.goals?.find(value=>value.id===input.id);if(!goal)throw apiError('Savings goal not found.',404);goal.archivedAt=goal.archivedAt||new Date().toISOString();goal.updatedAt=goal.archivedAt;for(const allocation of s.goalAllocations||[])if(allocation.goalId===goal.id&&allocation.active!==false)allocation.active=false;});
          return response({ok:true,revision:saved.revision});
        }
        const target=input.target,priority=input.priority??100,monthlyContribution=input.monthlyContribution??0,apyBps=input.apyBps??0;
        if(!name||name.length>100||Object.hasOwn(Object.prototype,name)||!Number.isSafeInteger(target)||target<0||target>100_000_000_000||!validDateOnly(input.targetDate)||!Number.isSafeInteger(priority)||priority<0||priority>1000||!Number.isSafeInteger(monthlyContribution)||monthlyContribution<0||monthlyContribution>100_000_000||!Number.isSafeInteger(apyBps)||apyBps<0||apyBps>3000||apyBps>0&&!validDateOnly(input.apyAsOf))throw apiError('Enter a goal name, target, target date, priority, and valid projection assumptions.');
        let savedGoal;
        const saved=await mutate(env,s=>{checkRevision(s,input);s.goals||=[];const existing=input.id?s.goals.find(goal=>goal.id===input.id):null;if(input.id&&!existing)throw apiError('Savings goal not found.',404);const now=new Date().toISOString();savedGoal={...(existing||{}),id:existing?.id||crypto.randomUUID(),name,target,targetDate:input.targetDate,priority,monthlyContribution,apyBps,apyAsOf:apyBps?input.apyAsOf:null,createdAt:existing?.createdAt||now,updatedAt:now,archivedAt:null};if(existing)Object.assign(existing,savedGoal);else s.goals.push(savedGoal);s.owner=user;});
        return response({ok:true,revision:saved.revision,goal:savedGoal,summary:summarizeGoals(saved.goals||[],saved.goalAllocations||[],saved.accounts,saved.items,new Date()).goals.find(goal=>goal.id===savedGoal.id)});
      }
      if(path==='/api/goal-projection'&&request.method==='POST'){
        const input=await body(request),goal=(state.goals||[]).find(value=>value.id===input.id&&!value.archivedAt);if(!goal)throw apiError('Savings goal not found.',404);
        return response(summarizeGoals(state.goals||[],state.goalAllocations||[],state.accounts,state.items,new Date()).goals.find(value=>value.id===goal.id));
      }
      if(path==='/api/goal-allocations'&&request.method==='POST'){
        const input=await body(request),goal=(state.goals||[]).find(value=>value.id===input.goalId&&!value.archivedAt),requested=Array.isArray(input.allocations)?input.allocations:[];
        if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before changing goal allocations.',409);
        if(!goal||requested.length>50||requested.some(row=>!row||typeof row.accountId!=='string'||!Number.isSafeInteger(row.amount)||row.amount<0||row.amount>100_000_000_000)||new Set(requested.map(row=>row.accountId)).size!==requested.length)throw apiError('Choose an active goal and valid account allocation amounts.');
        const eligible=new Map(eligibleCashAccounts(state.accounts,state.items,new Date()).filter(account=>account.eligible).map(account=>[account.accountId,account.balance]));
        const otherReservations=new Map();for(const allocation of state.goalAllocations||[]){if(allocation.active===false||allocation.goalId===goal.id)continue;const reserved=otherReservations.get(allocation.accountId)||0;otherReservations.set(allocation.accountId,reserved+allocation.amount);}
        for(const row of requested){if(!eligible.has(row.accountId))throw apiError('Goals can use only fresh, included USD cash accounts. Investment, retirement, HSA, credit, archived, stale, and unknown-balance accounts are not eligible.');const available=eligible.get(row.accountId)-(otherReservations.get(row.accountId)||0);if(row.amount>available)throw apiError('This allocation exceeds the account’s fresh unallocated cash balance.',409);}
        const batchId=crypto.randomUUID(),now=new Date().toISOString();let newIds=[];
        const saved=await mutate(env,s=>{checkRevision(s,input);const live=s.goals.find(value=>value.id===goal.id&&!value.archivedAt);if(!live)throw apiError('Savings goal is no longer active.',409);s.goalAllocations||=[];s.goalAllocationLedger||=[];const before=s.goalAllocations.filter(value=>value.goalId===goal.id&&value.active!==false).map(value=>({...value}));for(const value of s.goalAllocations)if(value.goalId===goal.id&&value.active!==false)value.active=false;const after=requested.map(row=>({id:crypto.randomUUID(),goalId:goal.id,accountId:row.accountId,amount:row.amount,createdAt:now,active:true}));s.goalAllocations.push(...after);newIds=after.map(value=>value.id);s.goalAllocationLedger.push({id:batchId,goalId:goal.id,createdAt:now,before,afterIds:newIds,undoneAt:null});});
        return response({ok:true,batchId,revision:saved.revision,summary:summarizeGoals(saved.goals||[],saved.goalAllocations||[],saved.accounts,saved.items,new Date()).goals.find(value=>value.id===goal.id)});
      }
      if(path==='/api/goal-allocation-undo'&&request.method==='POST'){
        const input=await body(request),batch=state.goalAllocationLedger?.find(value=>value.id===input.batchId&&!value.undoneAt);
        if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before undoing goal allocations.',409);if(!batch)throw apiError('Goal allocation undo record not found.',404);
        const current=(state.goalAllocations||[]).filter(value=>value.goalId===batch.goalId&&value.active!==false).map(value=>value.id).sort(),expected=[...batch.afterIds].sort();if(JSON.stringify(current)!==JSON.stringify(expected))throw apiError('This goal’s allocations changed after that edit. Review the current allocations before changing them.',409);
        const eligible=new Map(eligibleCashAccounts(state.accounts,state.items,new Date()).filter(account=>account.eligible).map(account=>[account.accountId,account.balance])),other=new Map();for(const allocation of state.goalAllocations||[])if(allocation.active!==false&&allocation.goalId!==batch.goalId)other.set(allocation.accountId,(other.get(allocation.accountId)||0)+allocation.amount);
        for(const allocation of batch.before){if(!eligible.has(allocation.accountId)||allocation.amount>eligible.get(allocation.accountId)-(other.get(allocation.accountId)||0))throw apiError('The previous allocation no longer fits verified cash balances. Refresh the accounts before undoing.',409);}
        const saved=await mutate(env,s=>{checkRevision(s,input);for(const allocation of s.goalAllocations)if(batch.afterIds.includes(allocation.id))allocation.active=false;for(const prior of batch.before){const live=s.goalAllocations.find(value=>value.id===prior.id);if(live)live.active=true;else s.goalAllocations.push({...prior,active:true});}const entry=s.goalAllocationLedger.find(value=>value.id===batch.id);entry.undoneAt=new Date().toISOString();});
        return response({ok:true,revision:saved.revision,undone:batch.afterIds.length});
      }
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
        return response({ connected: true, ...await startSync(env,'new-connection') });
      }
      if (['/api/sync', '/api/scheduled-sync'].includes(path) && request.method === 'POST') return response(await startSync(env,path==='/api/scheduled-sync'?'scheduled':'manual'));
      if (path === '/api/category' && request.method === 'POST') {
        const input = await body(request);
        const category = categoryCatalog(state).find(c => c.id === input.categoryId && !c.archivedAt) || categoryCatalog(state).find(c => c.name === input.category && !c.archivedAt);
        if (!category) throw apiError('Choose a valid category.');
        const saved = await mutate(env, s => { checkRevision(s,input); const t = s.transactions.find(t => t.id === input.id); if (!t) throw apiError('Transaction not found.', 404); const live = categoryCatalog(s).find(c => c.id === category.id && !c.archivedAt); if (!live) throw apiError('That category is no longer available.', 409); t.override = live.name; t.overrideCategoryId = live.id; });
        return response({ ok: true, revision: saved.revision });
      }
      if(path==='/api/category-bulk'&&request.method==='POST'){
        const input=await body(request),ids=Array.isArray(input.ids)?[...new Set(input.ids)]:[],category=categoryCatalog(state).find(c=>c.id===input.categoryId&&!c.archivedAt);
        if(!ids.length||ids.length>100||ids.some(id=>typeof id!=='string')||!category)throw apiError('Choose up to 100 transactions and a valid category.');
        const id=crypto.randomUUID();const saved=await mutate(env,s=>{checkRevision(s,input);const selected=s.transactions.filter(t=>ids.includes(t.id));if(selected.length!==ids.length)throw apiError('One or more selected transactions are no longer available.',409);s.categoryEditBatches||=[];const changes=selected.map(t=>({id:t.id,override:t.override,overrideCategoryId:t.overrideCategoryId}));for(const t of selected){t.override=category.name;t.overrideCategoryId=category.id;}s.categoryEditBatches.push({id,categoryId:category.id,createdAt:new Date().toISOString(),changes});});
        return response({ok:true,batchId:id,count:ids.length,revision:saved.revision});
      }
      if(path==='/api/category-bulk-undo'&&request.method==='POST'){
        const input=await body(request),batch=state.categoryEditBatches?.find(item=>item.id===input.batchId);if(!batch)throw apiError('Bulk edit undo record not found.',404);
        let undone=0;const saved=await mutate(env,s=>{checkRevision(s,input);const index=s.categoryEditBatches.findIndex(item=>item.id===input.batchId);if(index<0)throw apiError('Bulk edit undo record not found.',404);const [record]=s.categoryEditBatches.splice(index,1);for(const prior of record.changes){const transaction=s.transactions.find(t=>t.id===prior.id);if(!transaction||transaction.overrideCategoryId!==record.categoryId)continue;if(prior.override===undefined)delete transaction.override;else transaction.override=prior.override;if(prior.overrideCategoryId===undefined)delete transaction.overrideCategoryId;else transaction.overrideCategoryId=prior.overrideCategoryId;undone++;}});
        return response({ok:true,revision:saved.revision,undone,skipped:batch.changes.length-undone});
      }
      if(path==='/api/import-preview'&&request.method==='POST'){
        const input=await body(request),preview=await prepareCsvImport(input,state);
        return response({account:preview.name,revision:preview.revision,headers:preview.headers,rows:preview.rows.length,alreadyImported:!!preview.existingBatch,unknownCategories:preview.unknownCategories,overlapCount:preview.overlaps.length,overlaps:preview.overlaps.slice(0,20),sample:preview.rows.slice(0,10).map(({date,merchant,amount,category,unknownCategory})=>({date,merchant,amount,category,unknownCategory:unknownCategory||null}))});
      }
      if(path==='/api/import'&&request.method==='POST'){
        const input=await body(request),preview=await prepareCsvImport(input,state);
        if(!Number.isSafeInteger(input.revision))throw apiError('Reload the import preview before committing.',409);
        checkRevision(state,input);
        if(preview.existingBatch)return response({imported:0,skipped:preview.rows.length,batchId:preview.fileId,alreadyImported:true,revision:state.revision});
        if(preview.unknownCategories.length)throw apiError('Map unknown categories to an existing bucket or create that bucket before importing.');
        if(preview.overlaps.length&&input.confirmOverlaps!==true)throw apiError('Review matching transactions and explicitly confirm whether to keep these rows.',409);
        let imported=0,skipped=0;
        const saved=await mutate(env,s=>{
          checkRevision(s,input);s.owner=user;s.importBatches||=[];
          if(s.importBatches.some(batch=>batch.id===preview.fileId)){skipped=preview.rows.length;return;}
          if(!s.accounts.some(a=>a.id===preview.accountId))s.accounts.push({id:preview.accountId,itemId:null,name:preview.name,mask:null,type:'manual',subtype:'CSV import',balance:null,currency:'USD',source:'csv'});
          const ids=new Set(s.transactions.map(t=>t.id)),transactionIds=[];
          preview.rows.forEach((row,index)=>{const id='csv:'+preview.fileId+':'+index;if(ids.has(id)){skipped++;return;}const {unknownCategory,sourceRow,...transaction}=row;s.transactions.push({...transaction,...(sourceRow?{sourceRow}:{}),id,accountId:preview.accountId,itemId:null,source:'csv',importBatchId:preview.fileId});transactionIds.push(id);imported++;});
          s.importBatches.push({id:preview.fileId,accountId:preview.accountId,createdAt:new Date().toISOString(),transactionIds,imported,skipped});
        });
        return response({imported,skipped,batchId:preview.fileId,revision:saved.revision,month:preview.rows.map(t=>t.date.slice(0,7)).sort().at(-1)});
      }
      if(path==='/api/import-undo'&&request.method==='POST'){
        const input=await body(request),batch=state.importBatches?.find(value=>value.id===input.batchId);
        if(!batch)throw apiError('Import batch not found.',404);
        const saved=await mutate(env,s=>{checkRevision(s,input);const index=s.importBatches.findIndex(value=>value.id===input.batchId);if(index<0)throw apiError('Import batch not found.',404);const [removed]=s.importBatches.splice(index,1),ids=new Set(removed.transactionIds);s.transactions=s.transactions.filter(t=>!ids.has(t.id));});
        return response({ok:true,revision:saved.revision,undone:batch.transactionIds.length});
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
      if (path === '/api/disconnect' && request.method === 'POST') {
        const input = await body(request), item = state.items.find(i => i.id === input.itemId);
        if (!item) throw apiError('Bank connection not found.', 404);
        if (state.syncJob?.status === 'running') throw apiError('Wait for the current sync to finish before disconnecting.', 409);
        if(item.lifecycle!=='unlinked'&&item.token){if(!item.environment||item.environment!==env.PLAID_ENV)throw apiError('Saved connection environment must be verified before unlinking; no token was sent.');await plaid(env, '/item/remove', { access_token: await decryptToken(env, item.token) });}
        const saved=await mutate(env, s => { const link=s.items.find(i=>i.id===item.id); if(!link)return; link.token=null;link.lifecycle='unlinked';link.error=null;link.unlinkedAt=new Date().toISOString(); });
        return response({ ok: true, historyRetained:true, revision:saved.revision });
      }
      if (path === '/api/delete-history' && request.method === 'POST') {
        const input=await body(request),item=state.items.find(i=>i.id===input.itemId);
        if(!item)throw apiError('Connection history not found.',404);
        if(state.syncJob?.status==='running')throw apiError('Wait for the current sync to finish before deleting history.',409);
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
