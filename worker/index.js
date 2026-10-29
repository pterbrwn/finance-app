// The loopback-only Node server supplies the local owner's identity.
import { CATEGORIES, transactionMatchesCategory } from '../shared/categories.mjs';
import { budgetMonthKey, resolveBudget, resolveIncomePlan, validMonth } from '../shared/budgets.mjs';
import { canonicalOperationPayload, operationPayloadDigest } from '../shared/operation-identity.mjs';
import { monthlyBudgetAmount, validateBudgetSchedule } from '../shared/budget-frequency.mjs';
import { reportingDate } from '../shared/dates.mjs';
import { cents } from '../shared/money.mjs';
import { accountRecord, investmentHoldings, providerAccountKey } from '../shared/investments.mjs';
import { addSafeCents, categoryFor, fromPlaid, totals } from '../shared/reporting.mjs';
import { applyChanges, applySyncPages } from '../shared/reconciliation.mjs';
import { eligibleCashAccounts, summarizeGoals } from '../shared/goals.mjs';
import { amortizeFixedRate, compareAmortization, summarizeProperties } from '../shared/mortgages.mjs';
import { calculateHomeScenario, SCENARIO_CALCULATION_VERSION, validateScenarioInput } from '../shared/scenarios.mjs';
import { makeBalanceSheetSnapshot, summarizeBalanceSheet } from '../shared/net-worth.mjs';
import { calculateStatementReconciliation, statementTransactionFingerprint } from '../shared/statement-reconciliation.mjs';
import { validateTransactionSplit, transactionReportingRows } from '../shared/transaction-splits.mjs';
import { commitmentForecast, confirmCommitmentMatch, enumerateCommitmentDates, validateCommitment } from '../shared/commitments.mjs';
import { BUILD_ID, UI_ASSETS } from './generated.mjs';
import { repositoryFor } from '../server/repository.mjs';
import { handleBudgetMutationRoute, handleBudgetSummaryRoute } from './budget-routes.mjs';

export { categoryFor, fromPlaid, totals, applyChanges, applySyncPages, investmentHoldings, eligibleCashAccounts, summarizeGoals, amortizeFixedRate, compareAmortization, summarizeProperties, calculateHomeScenario, validateScenarioInput, summarizeBalanceSheet, makeBalanceSheetSnapshot, budgetActuals, budgetRollovers };
export { canonicalOperationPayload, operationPayloadDigest };

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
function reimbursementReview(state,link){
  if(link.status==='unlinked')return'unlinked';
  const refund=(state.transactions||[]).find(row=>row.id===link.transactionId),purchase=(state.transactions||[]).find(row=>row.id===link.reimbursesTransactionId);
  if(!refund||!purchase||refund.pending||purchase.pending||refund.amount>=0||purchase.amount<=0||refund.currency!=='USD'||purchase.currency!=='USD'||!link.observedRefund||!link.observedPurchase)return'needs-review';
  for(const [transaction,observed] of [[refund,link.observedRefund],[purchase,link.observedPurchase]])if(transaction.amount!==observed.amount||transaction.date!==observed.date||transaction.accountId!==observed.accountId||transaction.currency!==observed.currency)return'needs-review';
  return link.amount<=Math.min(-refund.amount,purchase.amount)?'user-confirmed':'needs-review';
}
function dateInReportingZone(date = new Date()) { return reportingDate(date); }
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
async function mutateBudget(env, update) {
  const repository=repositoryFor(env);
  if(typeof repository.mutateBudgetState==='function')return repository.mutateBudgetState(async state=>{await update(state);state.revision=(Number.isSafeInteger(state.revision)?state.revision:0)+1;});
  return mutate(env,update);
}
async function mutateOwner(env, update) {
  const repository=repositoryFor(env);
  if(typeof repository.mutateOwnerState==='function')return repository.mutateOwnerState(async state=>{await update(state);state.revision=(Number.isSafeInteger(state.revision)?state.revision:0)+1;});
  return mutate(env,update);
}
async function mutateTransactions(env, ids, update) {
  const repository=repositoryFor(env);
  if(typeof repository.mutateTransactionSubset==='function')return repository.mutateTransactionSubset(ids,async state=>{await update(state);});
  return mutate(env,update);
}
class OperationReplay extends Error { constructor(){super('Stored operation result replay.');this.operationReplay=true;} }
const BUDGET_HISTORY_SCOPES=new Set(['budget','budget-reset','income-plan','income-plan-reset','budget-outlook','category-create','budget-history-revert','budget-stop-future']);
function budgetHistorySnapshot(state){
  const keyed=(rows,keyOf,valueOf)=>Object.fromEntries((rows||[]).map(row=>[keyOf(row),valueOf(row)]));
  return{budgets:keyed(state.budgetTemplates,row=>`${row.categoryId}:${row.effectiveFrom}`,row=>({amount:row.amount,schedule:state.budgetTemplateSchedules?.[`${row.categoryId}:${row.effectiveFrom}`]||null})),monthBudgets:Object.fromEntries(Object.entries(state.monthlyBudgets||{}).map(([key,amount])=>[key,{amount,schedule:state.monthlyBudgetSchedules?.[key]||null}])),incomeTemplates:keyed(state.incomePlanTemplates,row=>row.effectiveFrom,row=>row.amount),incomeMonths:{...(state.monthlyIncomePlans||{})},outlooks:{...(state.monthlyBudgetOutlooks||{})}};
}
function budgetHistoryEntries(before,after,{scope,operationId,revision,createdAt}){
  if(!BUDGET_HISTORY_SCOPES.has(scope))return[];
  const entries=[];
  const compare=(recordType,left,right,parseKey)=>{for(const key of new Set([...Object.keys(left),...Object.keys(right)])){const previous=left[key]??null,next=right[key]??null;if(JSON.stringify(previous)===JSON.stringify(next))continue;const parts=parseKey(key);entries.push({id:crypto.randomUUID(),recordType,categoryId:parts.categoryId||null,month:parts.month||null,scope:parts.scope||null,action:scope,before:previous,after:next,revision,operationId:operationId||null,createdAt});}};
  compare('budget',before.budgets,after.budgets,key=>{const index=key.lastIndexOf(':');return{categoryId:key.slice(0,index),month:key.slice(index+1),scope:'recurring'};});
  compare('budget',before.monthBudgets,after.monthBudgets,key=>({categoryId:key.slice(8),month:key.slice(0,7),scope:'month'}));
  compare('income',before.incomeTemplates,after.incomeTemplates,key=>({month:key,scope:'recurring'}));
  compare('income',before.incomeMonths,after.incomeMonths,key=>({month:key,scope:'month'}));
  compare('outlook',before.outlooks,after.outlooks,key=>({month:key,scope:'month'}));
  return entries;
}
async function operationFingerprint(scope,input){
  const operationId=input?.clientOperationId;
  if(operationId===undefined)return null;
  if(typeof operationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId))throw apiError('Invalid save operation identifier.');
  const payload={...input};delete payload.clientOperationId;
  return{operationId,payloadDigest:await operationPayloadDigest(scope,payload)};
}
async function findOperationReplay(env,state,scope,input){
  const operation=await operationFingerprint(scope,input);if(!operation)return{found:false};
  const repository=repositoryFor(env),existing=await repository.readOperationResult?.(operation.operationId)||(state.operationResults||[]).find(record=>record.id===operation.operationId);
  if(!existing)return{found:false};
  const digest=existing.payloadDigest??(typeof existing.fingerprint==='string'?await crypto.subtle.digest('SHA-256',new TextEncoder().encode(existing.fingerprint)).then(bytes=>[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('')):null);
  if(existing.scope!==undefined&&existing.scope!==scope||digest!==operation.payloadDigest)throw apiError('This save identifier was already used for different values. Start a new save.',409);
  return{found:true,response:existing.response};
}
async function mutateWithReplay(env,scope,input,update,buildResult,transactionIds=null,strategy='default'){
  const operation=await operationFingerprint(scope,input),repository=repositoryFor(env);let result;
  const trackedUpdate=async state=>{const before=BUDGET_HISTORY_SCOPES.has(scope)?budgetHistorySnapshot(state):null;await update(state);if(before){const revision=(Number.isSafeInteger(state.revision)?state.revision:0)+1,createdAt=new Date().toISOString();state._pendingBudgetHistory=budgetHistoryEntries(before,budgetHistorySnapshot(state),{scope,operationId:operation?.operationId,revision,createdAt});}};
  if(!operation){const state=strategy==='owner'?await mutateOwner(env,trackedUpdate):strategy==='budget'?await mutateBudget(env,trackedUpdate):transactionIds?await mutateTransactions(env,transactionIds,trackedUpdate):await mutate(env,trackedUpdate);return{state,result:buildResult(state,state.revision),replayed:false};}
  const{operationId,payloadDigest}=operation;
  const apply=async state=>{
    const before=BUDGET_HISTORY_SCOPES.has(scope)?budgetHistorySnapshot(state):null;await update(state);
    const revision=(Number.isSafeInteger(state.revision)?state.revision:0)+1;
    state.revision=revision;
    if(before)state._pendingBudgetHistory=budgetHistoryEntries(before,budgetHistorySnapshot(state),{scope,operationId,revision,createdAt:new Date().toISOString()});
    result=buildResult(state,revision);
  };
  const outcome=await repository.mutateWithOperation({id:operationId,scope,payloadDigest},async state=>{await apply(state);return{id:operationId,scope,payloadDigest,response:result,revision:state.revision,createdAt:new Date().toISOString()};},{strategy:transactionIds?'transactions':strategy,transactionIds:transactionIds||[]});
  return{state:outcome.state,result:outcome.result,replayed:outcome.replayed};
}
function checkRevision(state,input) { const revision=Number.isSafeInteger(state.revision)?state.revision:0;if(!Number.isSafeInteger(input?.revision)||input.revision<0)throw apiError('Refresh this dashboard before saving changes.',409);if(input.revision!==revision)throw apiError('This data changed in another tab. Reload it and try again.',409); }
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
  const mapping={date:names.date,merchant:names.merchant||names.description,amount:names.amount,category:names.category,currency:names.currency,status:names.status,account:names.account||names['account name'],...(options.columnMapping||{})};
  for(const field of ['date','merchant','amount'])if(!mapping[field]||!header.includes(mapping[field]))throw apiError('Select a CSV column for '+field+'.');
  for(const field of ['category','currency','status','account'])if(mapping[field]&&!header.includes(mapping[field]))throw apiError('Select a valid CSV column for '+field+'.');
  const selectedColumns=Object.values(mapping).filter(Boolean);if(new Set(selectedColumns).size!==selectedColumns.length)throw apiError('Each selected CSV field needs a separate column.');
  const dateFormat=options.dateFormat||'YYYY-MM-DD',amountMode=options.amountMode||'positive-spending',categoryMapping=options.categoryMapping||{};
  if(!['YYYY-MM-DD','MM/DD/YYYY','DD/MM/YYYY'].includes(dateFormat))throw apiError('Choose a supported date format.');
  if(!['positive-spending','negative-spending'].includes(amountMode))throw apiError('Choose a supported amount sign convention.');
  return rows.map(({values,line:rowNumber})=>{
    if(values.length!==header.length)throw apiError('CSV row '+rowNumber+' has '+values.length+' fields; expected '+header.length+'.');
    const get=key=>mapping[key]?(values[header.indexOf(mapping[key])]||'').trim():'';
    let date=get('date');
    if(dateFormat==='MM/DD/YYYY'&&/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)){const [m,d,y]=date.split('/');date=`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;}
    if(dateFormat==='DD/MM/YYYY'&&/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)){const [d,m,y]=date.split('/');date=`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;}
    const merchant=get('merchant'),amount=get('amount'),sourceCategory=get('category')||'Other',accountName=get('account');
    if(!validDateOnly(date))throw apiError('Invalid date at CSV row '+rowNumber+'.');
    if(!merchant||merchant.length>300)throw apiError('Invalid merchant at CSV row '+rowNumber+'.');
    if(mapping.account&&(!accountName||accountName.length>100))throw apiError('Enter an account name in the Account column at CSV row '+rowNumber+'.');
    if(!/^-?\d{1,9}(\.\d{1,2})?$/.test(amount))throw apiError('Use a plain amount with up to two decimal places at CSV row '+rowNumber+'.');
    let category=sourceCategory,unknownCategory=null,storedSourceCategory=null;
    if(!allowedCategories.includes(category)){if(categoryMapping[category]&&allowedCategories.includes(categoryMapping[category])){storedSourceCategory=category;category=categoryMapping[category];}else if(options.allowUnknownCategories){unknownCategory=category;category='Other';}else throw apiError('Unknown category at CSV row '+rowNumber+': '+category+'. Map it to an existing bucket or create that bucket first.');}
    const currency=get('currency');if(currency&&currency!=='USD')throw apiError('CSV import currently supports USD only.');
    const status=get('status').toLowerCase();if(status&&!['pending','posted'].includes(status))throw apiError('Use Posted or Pending status at CSV row '+rowNumber+'.');
    const centsAmount=Math.round(Number(amount)*100)*(amountMode==='negative-spending'?-1:1);
    return{date,merchant,amount:centsAmount,category,pending:status==='pending',currency:'USD',...(accountName?{accountName}:{}),...(unknownCategory?{unknownCategory}:{}),...(storedSourceCategory?{sourceCategory:storedSourceCategory}:{}),sourceRow:rowNumber};
  });
}
async function hash(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2,'0')).join(''); }
function transactionFingerprint(row){return [row.date,String(row.merchant||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US'),row.amount,row.currency||'USD'].join('|');}
async function prepareCsvImport(input,state){
  const accountColumn=typeof input.columnMapping?.account==='string'&&input.columnMapping.account.length>0,providedName=typeof input.account==='string'?input.account.trim():'';
  if(typeof input.csv!=='string'||input.csv.length>1_000_000||providedName.length>100||!accountColumn&&!providedName)throw apiError('Choose a CSV under 1 MB and enter a default account name, or map an Account column.');
  const name=providedName,accountId=name?'csv:'+await hash(name.normalize('NFKC').toLocaleLowerCase('en-US')):null,fileId=await hash((accountColumn?'csv-account-column':'csv:'+accountId)+'\n'+input.csv);
  const options={columnMapping:input.columnMapping||{},dateFormat:input.dateFormat||'YYYY-MM-DD',amountMode:input.amountMode||'positive-spending',categoryMapping:input.categoryMapping||{},allowUnknownCategories:true};
  const importCategories=categoryCatalog(state).filter(category=>['expense','income','transfer'].includes(category.kind)&&state.budgetItemSettings?.[category.id]?.itemType!=='allocation').map(category=>category.name);
  const parsedRows=parseCSV(input.csv,importCategories,options),accountCache=new Map(),accounts=[];
  const rows=await Promise.all(parsedRows.map(async row=>{
    const accountName=row.accountName||name,key=accountName.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');
    if(!key)throw apiError('Choose a default account or map a non-empty Account column.');
    if(!accountCache.has(key)){
      const matches=(state.accounts||[]).filter(account=>String(account.name||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US')===key);
      if(matches.length>1)throw apiError('More than one saved account is named “'+accountName+'”. Rename the accounts before importing this file.');
      const id=matches[0]?.id||'csv:'+await hash(key),resolved={id,name:matches[0]?.name||accountName};accountCache.set(key,resolved);if(!matches.length)accounts.push({id:resolved.id,name:resolved.name});
    }
    return{...row,accountName,accountId:accountCache.get(key).id};
  }));
  const unknownCategories=[...new Set(rows.map(row=>row.unknownCategory).filter(Boolean))];
  const existingBatch=(state.importBatches||[]).find(batch=>batch.id===fileId);
  const fingerprints=new Map();for(const transaction of state.transactions){const key=transactionFingerprint(transaction);if(!fingerprints.has(key))fingerprints.set(key,[]);fingerprints.get(key).push(transaction);}
  const overlaps=existingBatch?[]:rows.flatMap((row,index)=>{const candidates=fingerprints.get(transactionFingerprint(row))||[];return candidates.length?[{row:index+1,date:row.date,merchant:row.merchant,amount:row.amount,existingIds:candidates.slice(0,3).map(t=>t.id)}]:[];});
  const firstRecord=input.csv.replace(/^\uFEFF/,'').split(/\r?\n/,1)[0],headers=[...firstRecord.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map(match=>(match[1]??match[2]??'').replaceAll('""','"').trim()).filter((_,index)=>index===0||true);
  return{name:name||`${accountCache.size} accounts`,accountId,fileId,accounts:[...accountCache.values()],newAccounts:accounts,rows,unknownCategories,existingBatch,overlaps,revision:Number.isSafeInteger(state.revision)?state.revision:0,headers};
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
        const affectedIds=[...new Set(result.pages.flatMap(page=>[
          ...(page.added||[]).flatMap(transaction=>[transaction.transaction_id,transaction.pending_transaction_id].filter(Boolean)),
          ...(page.modified||[]).flatMap(transaction=>[transaction.transaction_id,transaction.pending_transaction_id].filter(Boolean)),
          ...(page.removed||[]).map(transaction=>transaction.transaction_id).filter(Boolean)
        ]))];
        await mutateTransactions(env,affectedIds,s=>{
          assertSyncOwner(s,jobId);
          const liveItem=s.items.find(i=>i.id===item.id);if(!liveItem||liveItem.lifecycle==='unlinked')return;
          applySyncPages(s,item.id,result.pages);liveItem.cursor=result.cursor;liveItem.lastSync=new Date().toISOString();liveItem.lastSuccess=liveItem.lastSync;liveItem.error=null;
          const oldAccountIds=s.accounts.filter(account=>account.itemId===item.id).map(account=>account.id);
          const providerToLocal=replaceProviderAccounts(s,item.id,accountData.accounts);remapProviderAccountReferences(s,item.id,providerToLocal);
          const remainingAccountIds=new Set(s.accounts.filter(account=>account.itemId===item.id).map(account=>account.id));s._deleteAccountIds=oldAccountIds.filter(id=>!remainingAccountIds.has(id));
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
  if(env.shutdownRequested)throw apiError('The local server is shutting down. Try again after it restarts.',503);
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
async function drainSync(env,timeoutMs=10_000){env.shutdownRequested=true;const active=syncRunners.get(env);if(!active)return true;let timer;const finished=await Promise.race([active.promise.then(()=>true,()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(0,timeoutMs));})]);clearTimeout(timer);return finished&&!syncRunners.has(env);}

async function publicState(state, env) {
  const currentBudgetMonth = monthInReportingZone();
  const templates = budgetTemplates(state), overrides = state.monthlyBudgets || {};
  const budgets = Object.fromEntries(categoryCatalog(state).filter(c=>c.kind==='expense'&&!c.archivedAt&&state.budgetItemSettings?.[c.id]?.itemType!=='allocation').map(c=>[c.name,resolveBudget(templates,overrides,c.id,currentBudgetMonth).amount]).filter(([,amount])=>amount!==null));
  const goalSummary=summarizeGoals(state.goals||[],state.goalAllocations||[],state.accounts,state.items,new Date());
  const propertySummary=summarizeProperties(state.properties||[],state.mortgages||[],state.accounts,state.items||[]);
  const balanceSheet=summarizeBalanceSheet(state.accounts,state.items,propertySummary,new Date());
  const {operationResults,budgetChangeHistory,...privateSafeState}=state;return { ...privateSafeState, revision:Number.isSafeInteger(state.revision)?state.revision:0, budgets, budgetTemplates: templates, monthlyBudgets: overrides, monthlyBudgetSchedules:state.monthlyBudgetSchedules||{}, budgetTemplateSchedules:state.budgetTemplateSchedules||{}, incomePlanTemplates:state.incomePlanTemplates||[], monthlyIncomePlans:state.monthlyIncomePlans||{}, monthlyBudgetOutlooks:state.monthlyBudgetOutlooks||{}, budgetHistoryUnavailableBefore: state.budgetHistoryUnavailableBefore || currentBudgetMonth, categories: categories(state), categoryCatalog: categoryCatalog(state), holdings: state.holdings || [], goalSummary, propertySummary, balanceSheet, owner: undefined, lease: undefined, items: state.items.map(({ token, cursor, ...i }) => i), setup: { localOnly: !!env.LOCAL_ONLY, configured: ready(env), environment: env.PLAID_ENV || 'not configured', syncTimer: typeof env.getSyncTimerStatus==='function'?await env.getSyncTimerStatus():{state:'unavailable',enabled:null,active:null}, backup: typeof env.getBackupStatus==='function'?await env.getBackupStatus():{state:'unavailable',timer:{state:'unavailable',enabled:null,active:null}} } };
}
function budgetActuals(state,month){
  const aliases=new Map(Object.entries(state.budgetCategoryIds||{}).map(([id,name])=>[name,id]));
  const allocationIds=new Set(categoryCatalog(state).filter(category=>category.kind==='allocation').map(category=>category.id));
  let income=0;const categories={},activity={};
  for(const original of state.transactions||[])for(const row of transactionReportingRows(state,original)){if(!row.date?.startsWith(month)||row.pending||row.currency!=='USD')continue;const overridden=typeof row.override==='string'&&row.override.length>0,name=overridden?row.override:row.category,id=(overridden?row.overrideCategoryId:row.categoryId)||aliases.get(name);activity[id||name]=(activity[id||name]||0)+1;
    if(id&&(state.budgetItemSettings?.[id]?.itemType==='allocation'||allocationIds.has(id)))continue;
    if(name==='Income'){income=addSafeCents(income,-row.amount,'Monthly income');continue;}if(name==='Transfers')continue;const key=id||name;categories[key]=addSafeCents(categories[key]||0,row.amount,'Monthly category spending');
  }
  return{income,categories,activity};
}
function budgetActualsFromRows(state,rows){
  const aliases=new Map(Object.entries(state.budgetCategoryIds||{}).map(([id,name])=>[name,id]));
  const allocationIds=new Set(categoryCatalog(state).filter(category=>category.kind==='allocation').map(category=>category.id));
  let income=0;const categories={},activity={};
  for(const row of rows){const name=row.category,id=row.categoryId||aliases.get(name),key=id||name;activity[key]=(activity[key]||0)+row.activity;
    if(id&&(state.budgetItemSettings?.[id]?.itemType==='allocation'||allocationIds.has(id)))continue;
    if(name==='Income'){income=addSafeCents(income,-row.amount,'Monthly income');continue;}if(name==='Transfers')continue;categories[key]=addSafeCents(categories[key]||0,row.amount,'Monthly category spending');
  }
  return{income,categories,activity};
}
function budgetRollovers(state,month){
  const boundary=state.budgetHistoryUnavailableBefore, start=validMonth(boundary)&&boundary<=month?boundary:month;
  const months=[];for(let cursor=start;;){months.push(cursor);if(cursor===month)break;const[year,number]=cursor.split('-').map(Number);cursor=number===12?`${String(year+1).padStart(4,'0')}-01`:`${String(year).padStart(4,'0')}-${String(number+1).padStart(2,'0')}`;}
  const aliases=new Map(Object.entries(state.budgetCategoryIds||{}).map(([id,name])=>[name,id])),actuals=new Map();
  for(const original of state.transactions||[])for(const row of transactionReportingRows(state,original)){const rowMonth=row.date?.slice(0,7);if(!validMonth(rowMonth)||rowMonth<start||rowMonth>=month||row.pending||row.currency!=='USD')continue;const overridden=typeof row.override==='string'&&row.override.length>0,name=overridden?row.override:row.category;if(name==='Income'||name==='Transfers')continue;const id=(overridden?row.overrideCategoryId:row.categoryId)||aliases.get(name);if(!id)continue;const groupedIds=Object.entries(state.budgetItemSettings||{}).filter(([,settings])=>settings.itemType!=='allocation'&&(settings.actualCategoryIds||[]).includes(id)).map(([bucketId])=>bucketId);for(const bucketId of new Set([id,...groupedIds])){const key=`${rowMonth}:${bucketId}`,amount=(actuals.get(key)||0)+row.amount;if(!Number.isSafeInteger(amount))throw new TypeError('Historical bucket spending exceeds the safe integer-cent range.');actuals.set(key,amount);}}
  const templates=budgetTemplates(state),overrides=state.monthlyBudgets||{},result={};
  for(const category of categoryCatalog(state).filter(row=>row.kind==='expense')){let balance=0;for(const historicalMonth of months){const plan=resolveBudget(templates,overrides,category.id,historicalMonth).amount;if(plan===null){balance=0;continue;}if(historicalMonth===month){result[category.id]=balance;break;}const assigned=plan+balance;if(!Number.isSafeInteger(assigned))throw new TypeError('Bucket rollover exceeds the safe integer-cent range.');balance=assigned-(actuals.get(`${historicalMonth}:${category.id}`)||0);if(!Number.isSafeInteger(balance))throw new TypeError('Bucket rollover exceeds the safe integer-cent range.');}}
  return result;
}
function budgetRolloversFromRows(state,month,rows){
  const boundary=state.budgetHistoryUnavailableBefore,start=validMonth(boundary)&&boundary<=month?boundary:month;
  const months=[];for(let cursor=start;;){months.push(cursor);if(cursor===month)break;const[year,number]=cursor.split('-').map(Number);cursor=number===12?`${String(year+1).padStart(4,'0')}-01`:`${String(year).padStart(4,'0')}-${String(number+1).padStart(2,'0')}`;}
  const aliases=new Map(Object.entries(state.budgetCategoryIds||{}).map(([id,name])=>[name,id])),actuals=new Map();
  for(const row of rows){const rowMonth=row.month,name=row.category;if(!validMonth(rowMonth)||rowMonth<start||rowMonth>=month||name==='Income'||name==='Transfers')continue;const id=row.categoryId||aliases.get(name);if(!id)continue;const groupedIds=Object.entries(state.budgetItemSettings||{}).filter(([,settings])=>settings.itemType!=='allocation'&&(settings.actualCategoryIds||[]).includes(id)).map(([bucketId])=>bucketId);for(const bucketId of new Set([id,...groupedIds])){const key=`${rowMonth}:${bucketId}`,amount=addSafeCents(actuals.get(key)||0,row.amount,'Historical bucket spending');actuals.set(key,amount);}}
  const templates=budgetTemplates(state),overrides=state.monthlyBudgets||{},result={};
  for(const category of categoryCatalog(state).filter(row=>row.kind==='expense')){let balance=0;for(const historicalMonth of months){const plan=resolveBudget(templates,overrides,category.id,historicalMonth).amount;if(plan===null){balance=0;continue;}if(historicalMonth===month){result[category.id]=balance;break;}const assigned=addSafeCents(plan,balance,'Bucket rollover');balance=addSafeCents(assigned,-(actuals.get(`${historicalMonth}:${category.id}`)||0),'Bucket rollover');}}
  return result;
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
  drain: drainSync,
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
      if(path==='/api/statement-reconciliation'&&request.method==='GET'){
        const identity=typeof repository.readIdentity==='function'?await repository.readIdentity():(await repository.read()).state;
        if(identity.owner&&identity.owner!==user)return response({error:'This dashboard belongs to another account.'},403);
        const accountId=url.searchParams.get('accountId'),state=(await repository.read()).state;
        if(!accountId)throw apiError('Choose an account.');
        const account=state.accounts.find(row=>row.id===accountId);if(!account)throw apiError('Account not found.',404);
        const records=(state.statementReconciliations||[]).filter(row=>row.accountId===accountId).sort((a,b)=>b.reviewedAt.localeCompare(a.reviewedAt));
        const latest=records[0]||null;
        if(!latest)return response({accountId,review:null,status:'not-reviewed'});
        const current=statementTransactionFingerprint(state.transactions||[],accountId,latest.opening.date,latest.closing.date);
        return response({accountId,review:latest,status:current!==latest.transactionFingerprint?'needs-review':latest.result.complete?'current':'incomplete'});
      }
      if(path==='/api/statement-reconciliation'&&request.method==='POST'){
        const input=await body(request),state=(await repository.read()).state;if(!Number.isSafeInteger(input.revision))throw apiError('Refresh the dashboard before reconciling an account.',409);
        const account=state.accounts.find(row=>row.id===input.accountId);if(!account)throw apiError('Account not found.',404);
        if(!input.opening||!input.closing||!Number.isSafeInteger(input.opening.balance)||!Number.isSafeInteger(input.closing.balance)||!validDateOnly(input.opening.date)||!validDateOnly(input.closing.date))throw apiError('Enter valid statement dates and balances.');
        const result=calculateStatementReconciliation({account,opening:input.opening,closing:input.closing,transactions:state.transactions||[],historyComplete:input.historyComplete===true});
        if(!result.supported)throw apiError(result.reason||'This account cannot be reconciled with this workflow.');
        const transactionFingerprint=statementTransactionFingerprint(state.transactions||[],input.accountId,input.opening.date,input.closing.date),record={id:crypto.randomUUID(),accountId:input.accountId,opening:result.opening,closing:result.closing,result,transactionFingerprint,transactionRevision:Number.isSafeInteger(state.revision)?state.revision:0,calculationVersion:result.calculationVersion,reviewedAt:new Date().toISOString()};
        const mutation=await mutateWithReplay(env,'statement-reconciliation',input,s=>{checkRevision(s,input);s.statementReconciliations||=[];s.statementReconciliations.push(record);s.owner=user;},(s,revision)=>({ok:true,revision,review:record}),null,'owner');return response(mutation.result);
      }
      if(path==='/api/budget-history'&&request.method==='GET'){
        const identity=typeof repository.readIdentity==='function'?await repository.readIdentity():(await repository.read()).state;
        if(identity.owner&&identity.owner!==user)return response({error:'This dashboard belongs to another account.'},403);
        const query=url.searchParams,month=query.get('month')||'',categoryId=query.get('categoryId')||'',limit=Number(query.get('limit')||100);if(month&&!validMonth(month)||!Number.isSafeInteger(limit)||limit<1||limit>500)throw apiError('Choose a valid budget history filter.');
        const entries=typeof repository.readBudgetHistory==='function'?await repository.readBudgetHistory({month:month||undefined,categoryId:categoryId||undefined,limit}):(await repository.read()).state.budgetChangeHistory||[];
        return response({entries:month||categoryId?entries.filter(row=>(!month||row.month===month)&&(!categoryId||row.categoryId===categoryId)):entries.slice(0,limit)});
      }
      if(path==='/api/operation-status'&&request.method==='GET'){
        const operationId=url.searchParams.get('operationId');if(!operationId||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId))throw apiError('Choose a valid operation identifier.');
        const identity=typeof repository.readIdentity==='function'?await repository.readIdentity():(await repository.read()).state;
        if(identity.owner&&identity.owner!==user)return response({error:'This dashboard belongs to another account.'},403);
        const record=await repository.readOperationResult?.(operationId)||(await repository.read()).state.operationResults?.find(row=>row.id===operationId);
        return response(record?{status:'committed',operationId,revision:record.revision??record.response?.revision??null,result:record.response}:{status:'unknown',operationId});
      }
      const budgetSummaryResponse=await handleBudgetSummaryRoute({request,path,url,repository,user,response,apiError,monthInReportingZone,validMonth,budgetActualsFromRows,budgetActuals,budgetRolloversFromRows,budgetRollovers,categoryCatalog,budgetTemplates});
      if(budgetSummaryResponse)return budgetSummaryResponse;
      if(request.method==='GET'&&typeof repository.readDashboard==='function'&&['/api/health','/api/state','/api/transactions','/api/month-summary','/api/scenarios','/api/sync-status'].includes(path)){
        const state=path==='/api/state'?(await repository.readDashboard()).state:await repository.readIdentity();
        if(state.owner&&state.owner!==user)return response({error:'This dashboard belongs to another account.'},403);
        if(path==='/api/health')return response({codeVersion:typeof BUILD_ID==='string'?BUILD_ID:'unversioned',schemaVersion:Number.isInteger(repository.schemaVersion)?repository.schemaVersion:Number.isInteger(state.version)?state.version:null,configurationReady:ready(env),localOnly:!!env.LOCAL_ONLY,lastSync:state.lastSync||null});
        if(path==='/api/state')return response(await publicState(state,env));
        if(path==='/api/transactions'){
          const query=url.searchParams,page=Number(query.get('page')||1),limit=Math.min(100,Math.max(1,Number(query.get('limit')||50))),search=(query.get('search')||'').slice(0,120),category=query.get('category')||'',accountId=query.get('account')||'',from=query.get('from')||'',to=query.get('to')||'',review=query.get('review')==='true';
          if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||from&&!validDateOnly(from)||to&&!validDateOnly(to))throw apiError('Choose a valid transaction page and date range.');if(from&&to&&from>to)throw apiError('Start date must be on or before end date.');
          return response(await repository.queryTransactions({page,limit,search,category,accountId,from,to,review}));
        }
        if(path==='/api/month-summary'){
          const month=url.searchParams.get('month')||monthInReportingZone();if(!validMonth(month))throw apiError('Choose a valid reporting month.');
          return response(await repository.queryMonthSummary(month));
        }
        if(path==='/api/sync-status')return response({job:await syncStatus(env)});
        return response({scenarios:await repository.readScenarios()});
      }
      const budgetEdit=['/api/budget','/api/budget-reset','/api/income-plan','/api/income-plan-reset','/api/budget-outlook','/api/category-create','/api/category-update','/api/budget-history-revert','/api/budget-stop-future'].includes(path)&&request.method==='POST'&&typeof repository.readBudgetState==='function',ownerEdit=['/api/manual-account','/api/account-update','/api/goal','/api/goal-projection','/api/goal-allocations','/api/goal-allocation-undo','/api/scenario-calculate','/api/scenario','/api/scenario-goal','/api/scenario-budget','/api/property','/api/mortgage','/api/mortgage-projection','/api/balance-snapshot'].includes(path)&&typeof repository.readOwnerState==='function';
      const { state, storageSchemaVersion } = budgetEdit?{state:(await repository.readBudgetState()).state,storageSchemaVersion:repository.schemaVersion}:ownerEdit?{state:(await repository.readOwnerState()).state,storageSchemaVersion:repository.schemaVersion}:await readState(env);
      if (state.owner && state.owner !== user) return response({ error: 'This dashboard belongs to another account.' }, 403);
      if (path === '/api/health' && request.method === 'GET') return response({ codeVersion: typeof BUILD_ID === 'string' ? BUILD_ID : 'unversioned', schemaVersion: Number.isInteger(storageSchemaVersion) ? storageSchemaVersion : Number.isInteger(state.version) ? state.version : null, configurationReady: ready(env), localOnly: !!env.LOCAL_ONLY, lastSync: state.lastSync || null });
      if (['/api/link-token', '/api/exchange-token', '/api/sync', '/api/scheduled-sync', '/api/sync-status', '/api/disconnect', '/api/delete-history'].includes(path) && !ready(env)) return response({ error: 'Bank connections are disabled. Import CSV files for local-only operation.' }, 503);
      const budgetMutationResponse=await handleBudgetMutationRoute({request,path,env,user,state,repository,response,apiError,body,categoryCatalog,budgetTemplates,monthInReportingZone,budgetActualsFromRows,budgetActuals,mutateBudget,mutateTransactions,mutateWithReplay,findOperationReplay,checkRevision,budgetMonthKey,resolveBudget,resolveIncomePlan,validMonth,validateBudgetSchedule,monthlyBudgetAmount,normalizeCategory,CATEGORIES});
      if(budgetMutationResponse)return budgetMutationResponse;
      if(path==='/api/transaction-split'&&request.method==='GET'){
        const transactionId=url.searchParams.get('transactionId'),parent=state.transactions.find(row=>row.id===transactionId);if(!parent)throw apiError('Transaction not found.',404);
        const split=(state.transactionSplits||[]).find(row=>row.transactionId===transactionId)||null,history=[...(state.transactionSplitHistory||[])].reverse().find(row=>row.transactionId===transactionId)||null;return response({transactionId,split,history,status:split&&(split.parentAmount!==parent.amount||split.parentDate!==parent.date||split.parentAccountId!==parent.accountId||split.parentCurrency!==parent.currency)?'needs-review':split?'current':'unsplit'});
      }
      if(path==='/api/transaction-split'&&request.method==='POST'){
        const input=await body(request),replay=await findOperationReplay(env,state,'transaction-split',input);if(replay.found)return response(replay.response);
        const parent=state.transactions.find(row=>row.id===input.transactionId);if(!parent)throw apiError('Transaction not found.',404);
        const existing=(state.transactionSplits||[]).find(row=>row.transactionId===parent.id)||null;let next=null;
        if(input.action==='undo'){
          const history=(state.transactionSplitHistory||[]).find(row=>row.id===input.historyId&&row.transactionId===parent.id);if(!history)throw apiError('Split history entry not found.',404);
          if(JSON.stringify(existing)!==JSON.stringify(history.after))throw apiError('This split changed after that edit. Review the current split before undoing it.',409);next=history.before;
        }else{
          if(parent.pending)throw apiError('Wait until this transaction is posted before splitting it.');
          try{next={id:crypto.randomUUID(),transactionId:parent.id,parentAmount:parent.amount,parentDate:parent.date,parentAccountId:parent.accountId,parentCurrency:parent.currency,allocations:validateTransactionSplit(parent,input.allocations,categoryCatalog(state).filter(row=>['expense','income','transfer'].includes(row.kind))),updatedAt:new Date().toISOString(),needsReview:false};}catch(error){throw apiError(error.message);}
        }
        const mutation=await mutateWithReplay(env,'transaction-split',input,s=>{checkRevision(s,input);s.transactionSplits||=[];s.transactionSplitHistory||=[];const current=s.transactionSplits.findIndex(row=>row.transactionId===parent.id),before=current>=0?structuredClone(s.transactionSplits[current]):null;if(current>=0)s.transactionSplits.splice(current,1);if(next)s.transactionSplits.push(next);s.transactionSplitHistory.push({id:crypto.randomUUID(),transactionId:parent.id,before,after:next?structuredClone(next):null,revision:(s.revision||0)+1,createdAt:new Date().toISOString()});s.owner=user;},(s,revision)=>({ok:true,revision,split:next}),null,'owner');return response(mutation.result);
      }
      if(path==='/api/transaction-reimbursement-candidates'&&request.method==='GET'){
        const purchase=state.transactions.find(row=>row.id===url.searchParams.get('purchaseId'));if(!purchase||purchase.pending||purchase.amount<=0||purchase.currency!=='USD')throw apiError('Choose a posted USD purchase.',404);
        const search=String(url.searchParams.get('search')||'').trim().toLocaleLowerCase('en-US').slice(0,100),page=Number(url.searchParams.get('page')||1);if(!Number.isSafeInteger(page)||page<1||page>10000)throw apiError('Choose a valid reimbursement page.');
        const rows=state.transactions.filter(row=>row.id!==purchase.id&&!row.pending&&row.currency==='USD'&&row.amount<0&&(!search||String(row.merchant||'').toLocaleLowerCase('en-US').includes(search)||String(row.date||'').includes(search))).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
        return response({transactions:rows.slice((page-1)*50,page*50).map(row=>({id:row.id,merchant:row.merchant,date:row.date,amount:row.amount})),total:rows.length,page,limit:50});
      }
      if(path==='/api/transaction-reimbursement'&&request.method==='GET'){
        const purchaseId=url.searchParams.get('purchaseId');if(!purchaseId)throw apiError('Choose a purchase.');
        const links=(state.transactionReimbursements||[]).filter(row=>row.reimbursesTransactionId===purchaseId).map(row=>{const refund=state.transactions.find(value=>value.id===row.transactionId);return{...row,status:reimbursementReview(state,row),refund:refund?{merchant:refund.merchant,date:refund.date,amount:refund.amount}:null};});return response({links});
      }
      if(path==='/api/transaction-reimbursement'&&request.method==='POST'){
        const input=await body(request),replay=await findOperationReplay(env,state,'transaction-reimbursement',input);if(replay.found)return response(replay.response);
        if(input.action==='unlink'){
          if(input.confirmed!==true||typeof input.id!=='string')throw apiError('Confirm the reimbursement link to remove.');
          const mutation=await mutateWithReplay(env,'transaction-reimbursement',input,s=>{checkRevision(s,input);const link=(s.transactionReimbursements||[]).find(row=>row.id===input.id&&row.status!=='unlinked');if(!link)throw apiError('Active reimbursement link not found.',404);link.status='unlinked';link.unlinkedAt=new Date().toISOString();s.owner=user;},(s,revision)=>({ok:true,revision,unlinked:input.id}),null,'owner');return response(mutation.result);
        }
        const refund=state.transactions.find(row=>row.id===input.transactionId),purchase=state.transactions.find(row=>row.id===input.reimbursesTransactionId);if(!refund||!purchase||refund.id===purchase.id||refund.pending||purchase.pending||input.confirmed!==true||!Number.isSafeInteger(input.amount)||input.amount<=0||refund.amount>=0||purchase.amount<=0||refund.currency!=='USD'||purchase.currency!=='USD')throw apiError('Choose and confirm a posted negative USD reimbursement and positive USD purchase.');
        const observed=row=>({amount:row.amount,date:row.date,accountId:row.accountId,currency:row.currency});
        const relation={id:crypto.randomUUID(),transactionId:refund.id,reimbursesTransactionId:purchase.id,amount:input.amount,observedRefund:observed(refund),observedPurchase:observed(purchase),confirmedAt:new Date().toISOString(),status:'user-confirmed'};
        const mutation=await mutateWithReplay(env,'transaction-reimbursement',input,s=>{checkRevision(s,input);s.transactionReimbursements||=[];const active=s.transactionReimbursements.filter(row=>row.status!=='unlinked');if(active.some(row=>row.transactionId===refund.id&&row.reimbursesTransactionId===purchase.id))throw apiError('This reimbursement is already linked to that purchase.',409);const refundUsed=active.filter(row=>row.transactionId===refund.id).reduce((sum,row)=>sum+row.amount,0),purchaseUsed=active.filter(row=>row.reimbursesTransactionId===purchase.id).reduce((sum,row)=>sum+row.amount,0);if(input.amount>Math.min(-refund.amount-refundUsed,purchase.amount-purchaseUsed))throw apiError('The reimbursement amount exceeds the unlinked balance of the refund or purchase.',409);s.transactionReimbursements.push(relation);s.owner=user;},(s,revision)=>({ok:true,revision,reimbursement:relation}),null,'owner');return response(mutation.result);
      }
      if(path==='/api/commitments'&&request.method==='GET'){
        const from=url.searchParams.get('from')||new Date().toISOString().slice(0,10),to=url.searchParams.get('to')||new Date(Date.now()+90*86400000).toISOString().slice(0,10);if(!validDateOnly(from)||!validDateOnly(to)||from>to)throw apiError('Choose a valid commitment calendar range.');
        return response({commitments:state.commitments||[],forecast:commitmentForecast(state.commitments||[],from,to,state.commitmentMatches||[],state.transactions||[]),matches:state.commitmentMatches||[],from,to,revision:state.revision||0});
      }
      if(path==='/api/commitments'&&request.method==='POST'){
        const input=await body(request),replay=await findOperationReplay(env,state,'commitments',input);if(replay.found)return response(replay.response);let saved;
        if(input.action==='cancel'){
          if(typeof input.id!=='string')throw apiError('Choose a commitment to cancel.');
        }else{try{saved=validateCommitment(input.commitment);}catch(error){throw apiError(error.message);}if(saved.accountId&&!state.accounts.some(row=>row.id===saved.accountId))throw apiError('Choose an existing account or leave the account unassigned.');}
        const mutation=await mutateWithReplay(env,'commitments',input,s=>{checkRevision(s,input);s.commitments||=[];if(input.action==='cancel'){const row=s.commitments.find(value=>value.id===input.id);if(!row)throw apiError('Commitment not found.',404);if(row.status==='cancelled')throw apiError('This commitment is already cancelled.',409);row.status='cancelled';row.cancelledAt=new Date().toISOString();row.cancelledFrom=dateInReportingZone();saved=row;}else{const index=s.commitments.findIndex(row=>row.id===input.commitment?.id);if(input.commitment?.id&&index<0)throw apiError('Commitment not found.',404);saved={...saved,id:input.commitment.id||crypto.randomUUID(),createdAt:input.commitment.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),status:'active'};if(index>=0)s.commitments[index]=saved;else s.commitments.push(saved);}s.owner=user;},(s,revision)=>({ok:true,revision,commitment:saved}),null,'owner');return response(mutation.result);
      }
      if(path==='/api/commitment-match'&&request.method==='POST'){
        const input=await body(request),replay=await findOperationReplay(env,state,'commitment-match',input);if(replay.found)return response(replay.response);
        const commitment=(state.commitments||[]).find(row=>row.id===input.commitmentId&&row.status==='active'),transaction=state.transactions.find(row=>row.id===input.transactionId);if(!commitment)throw apiError('Active commitment not found.',404);let match;try{match=confirmCommitmentMatch(commitment,transaction,{confirmed:input.confirmed===true,dueDate:input.dueDate});}catch(error){throw apiError(error.message);}
        const mutation=await mutateWithReplay(env,'commitment-match',input,s=>{checkRevision(s,input);s.commitmentMatches||=[];if(s.commitmentMatches.some(row=>row.commitmentId===match.commitmentId&&row.dueDate===match.dueDate||row.transactionId===match.transactionId))throw apiError('This payment or commitment date is already matched. Review the existing match first.',409);s.commitmentMatches.push(match);s.owner=user;},(s,revision)=>({ok:true,revision,match}),null,'owner');return response(mutation.result);
      }
      if (path === '/api/state' && request.method === 'GET') return response(await publicState(state, env));
      if(path==='/api/sync-status'&&request.method==='GET')return response({job:await syncStatus(env)});
      if(path==='/api/transactions'&&request.method==='GET'){
        const query=url.searchParams,page=Number(query.get('page')||1),limit=Math.min(100,Math.max(1,Number(query.get('limit')||50))),search=(query.get('search')||'').slice(0,120).toLocaleLowerCase('en-US'),category=query.get('category')||'',accountId=query.get('account')||'',from=query.get('from')||'',to=query.get('to')||'',review=query.get('review')==='true';
        if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||from&&!validDateOnly(from)||to&&!validDateOnly(to))throw apiError('Choose a valid transaction page and date range.');if(from&&to&&from>to)throw apiError('Start date must be on or before end date.');
        const matches=state.transactions.filter(t=>(!search||String(t.merchant||'').toLocaleLowerCase('en-US').includes(search))&&(!category||transactionMatchesCategory(t,category))&&(!accountId||t.accountId===accountId)&&(!from||t.date>=from)&&(!to||t.date<=to)&&(!review||t.review===true||t.confidence!==undefined&&t.confidence<0.5||(t.override||t.category)==='Other')).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
        return response({page,limit,total:matches.length,transactions:matches.slice((page-1)*limit,page*limit),revision:state.revision});
      }
      if(path==='/api/balance-snapshot'&&request.method==='POST'){
        const input=await body(request),date=dateInReportingZone(new Date());if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before recording a balance snapshot.',409);
        const existing=(state.balanceSheetSnapshots||[]).find(snapshot=>snapshot.date===date);if(existing)return response({ok:true,existing:true,snapshot:existing,revision:state.revision||0});
        const summary=summarizeBalanceSheet(state.accounts,state.items,summarizeProperties(state.properties||[],state.mortgages||[],state.accounts,state.items||[]),new Date()),snapshot=makeBalanceSheetSnapshot(summary,date);
        const saved=await mutateOwner(env,s=>{checkRevision(s,input);s.balanceSheetSnapshots||=[];if(!s.balanceSheetSnapshots.some(row=>row.date===date))s.balanceSheetSnapshots.push(snapshot);});return response({ok:true,existing:false,snapshot,revision:saved.revision});
      }
      if(path==='/api/scenario-calculate'&&request.method==='POST'){
        const input=await body(request),scenarioInput=input.input||{},linkedGoalId=input.linkedGoalId||scenarioInput.linkedGoalId||null,asOf=new Date(),{snapshot}=scenarioFunding(state,linkedGoalId,asOf),result=calculateHomeScenario(scenarioInput,snapshot);
        if(!result.available)throw apiError(result.error||'Scenario inputs are incomplete.');return response({result,calculationVersion:SCENARIO_CALCULATION_VERSION});
      }
      if(path==='/api/scenario'&&request.method==='POST'){
        const input=await body(request);if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before saving a scenario.',409);
        if(input.action==='archive'||input.action==='restore'||input.action==='rename'||input.action==='duplicate'){
          let scenario;const mutation=await mutateWithReplay(env,'scenario',input,s=>{checkRevision(s,input);s.scenarios||=[];const existing=s.scenarios.find(row=>row.id===input.id);if(!existing)throw apiError('Scenario not found.',404);if(input.action==='rename'){const name=typeof input.name==='string'?input.name.trim():'';if(!name||name.length>100)throw apiError('Enter a scenario name up to 100 characters.');existing.name=name;existing.updatedAt=new Date().toISOString();scenario=existing;}else if(input.action==='archive'||input.action==='restore'){existing.archivedAt=input.action==='archive'?existing.archivedAt||new Date().toISOString():null;existing.updatedAt=new Date().toISOString();scenario=existing;}else{scenario={...existing,id:crypto.randomUUID(),name:(typeof input.name==='string'&&input.name.trim()?input.name.trim():existing.name+' copy').slice(0,100),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1,versions:[],archivedAt:null};s.scenarios.push(scenario);}},(s,revision)=>({ok:true,revision,scenario}),null,'owner');return response(mutation.result);
        }
        const scenarioInput=input.input||{},validation=validateScenarioInput(scenarioInput);if(validation)throw apiError(validation);const goalId=input.linkedGoalId||scenarioInput.linkedGoalId||null,asOf=new Date(),{snapshot:fundingSnapshot}=scenarioFunding(state,goalId,asOf),result=calculateHomeScenario(scenarioInput,fundingSnapshot);if(!result.available)throw apiError(result.error||'Scenario inputs are incomplete.');
        let savedScenario;const mutation=await mutateWithReplay(env,'scenario',input,s=>{checkRevision(s,input);s.scenarios||=[];const existing=input.id?s.scenarios.find(row=>row.id===input.id):null;if(input.id&&!existing)throw apiError('Scenario not found.',404);const now=new Date().toISOString(),versions=[...(existing?.versions||[])];if(existing)versions.push({version:existing.version||1,inputs:existing.inputs,fundingSnapshot:existing.fundingSnapshot,result:existing.result,calculationVersion:existing.calculationVersion,savedAt:existing.updatedAt});savedScenario={...(existing||{}),id:existing?.id||crypto.randomUUID(),name:scenarioInput.name.trim(),inputs:{...scenarioInput,linkedGoalId:goalId},linkedGoalId:goalId,fundingSnapshot,result,inputVersion:1,version:(existing?.version||0)+1,versions,calculationVersion:SCENARIO_CALCULATION_VERSION,createdAt:existing?.createdAt||now,updatedAt:now,archivedAt:null};if(existing)Object.assign(existing,savedScenario);else s.scenarios.push(savedScenario);s.owner=user;},(s,revision)=>({ok:true,revision,scenario:savedScenario}),null,'owner');return response(mutation.result);
      }
      if(path==='/api/scenario-goal'&&request.method==='POST'){
        const input=await body(request);if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before linking a goal.',409);const scenario=(state.scenarios||[]).find(row=>row.id===input.scenarioId&&!row.archivedAt);if(!scenario)throw apiError('Scenario not found.',404);
        requireCompleteSavedScenario(scenario);
        if(!validDateOnly(scenario.inputs.targetDate))throw apiError('Add a target date to the scenario before creating a savings goal.');if(!Number.isSafeInteger(scenario.result.allInAcquisitionFunding)||scenario.result.allInAcquisitionFunding>100_000_000_000)throw apiError('The scenario target is above the supported savings-goal limit.');let goalId;
        const mutation=await mutateWithReplay(env,'scenario-goal',input,s=>{checkRevision(s,input);const live=s.scenarios.find(row=>row.id===scenario.id&&!row.archivedAt);if(!live)throw apiError('Scenario is no longer active.',409);s.goals||=[];const goal=live.linkedGoalId?s.goals.find(row=>row.id===live.linkedGoalId&&!row.archivedAt):null;if(input.action==='update'){if(!goal)throw apiError('This scenario has no active linked goal.',409);goal.target=live.result.allInAcquisitionFunding;goal.targetDate=live.inputs.targetDate;goal.updatedAt=new Date().toISOString();goalId=goal.id;}else{if(goal)throw apiError('This scenario already has a linked goal. Use update to propose its new target.',409);const now=new Date().toISOString();const created={id:crypto.randomUUID(),name:(live.name+' down payment').slice(0,100),target:live.result.allInAcquisitionFunding,targetDate:live.inputs.targetDate,priority:100,monthlyContribution:0,apyBps:0,apyAsOf:null,createdAt:now,updatedAt:now,archivedAt:null};s.goals.push(created);live.linkedGoalId=created.id;live.inputs.linkedGoalId=created.id;goalId=created.id;}live.updatedAt=new Date().toISOString();},(s,revision)=>({ok:true,revision,goalId}),null,'owner');return response(mutation.result);
      }
      if(path==='/api/scenario-budget'&&request.method==='POST'){
        const input=await body(request);if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before creating a budget.',409);const scenario=(state.scenarios||[]).find(row=>row.id===input.scenarioId&&!row.archivedAt);if(!scenario)throw apiError('Scenario not found.',404);requireCompleteSavedScenario(scenario);const amount=scenario.result.ownershipOutflow;if(!Number.isSafeInteger(amount)||amount<0||amount>100_000_000)throw apiError('The projected housing outflow is outside the monthly budget limit.');const month=monthInReportingZone(),housing=categoryCatalog(state).find(category=>category.name==='Housing'&&category.kind==='expense'&&!category.archivedAt);if(!housing)throw apiError('Housing budget category is unavailable.');const mutation=await mutateWithReplay(env,'scenario-budget',input,s=>{checkRevision(s,input);s.budgetTemplates=budgetTemplates(s);const index=s.budgetTemplates.findIndex(entry=>entry.categoryId===housing.id&&entry.effectiveFrom===month),template={categoryId:housing.id,amount,effectiveFrom:month};if(index>=0)s.budgetTemplates[index]=template;else s.budgetTemplates.push(template);s.budgets={...(s.budgets||{}),Housing:amount};},(s,revision)=>({ok:true,revision,amount,month}),null,'budget');return response(mutation.result);
      }
      if(path==='/api/property'&&request.method==='POST'){
        const input=await body(request);if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before saving a property.',409);
        if(input.action==='archive'||input.action==='restore'){
          const mutation=await mutateWithReplay(env,'property',input,s=>{checkRevision(s,input);const property=s.properties?.find(row=>row.id===input.id);if(!property)throw apiError('Property not found.',404);property.archivedAt=input.action==='archive'?property.archivedAt||new Date().toISOString():null;property.updatedAt=new Date().toISOString();},(s,revision)=>({ok:true,revision}),null,'owner');
          return response(mutation.result);
        }
        const name=typeof input.name==='string'?input.name.trim():'';
        if(!name||name.length>100||input.address!==undefined&&(typeof input.address!=='string'||input.address.length>300)||input.ownershipBps!==undefined&&(!Number.isSafeInteger(input.ownershipBps)||input.ownershipBps<1||input.ownershipBps>10000)||input.valuation!==null&&input.valuation!==undefined&&(!Number.isSafeInteger(input.valuation)||input.valuation<0||input.valuation>100_000_000_000_000)||input.valuation!==null&&input.valuation!==undefined&&(!validDateOnly(input.valuationAsOf)||input.valuationAsOf>dateInReportingZone())||input.valuationSource!==undefined&&!['owner_estimate','appraisal','statement','other'].includes(input.valuationSource))throw apiError('Enter a valid property name, ownership share, and observed valuation.');
        let property;const mutation=await mutateWithReplay(env,'property',input,s=>{checkRevision(s,input);s.properties||=[];const existing=input.id?s.properties.find(row=>row.id===input.id):null;if(input.id&&!existing)throw apiError('Property not found.',404);const now=new Date().toISOString();property={...(existing||{}),id:existing?.id||crypto.randomUUID(),name,address:input.address?.trim()||'',ownershipBps:input.ownershipBps??10000,valuation:input.valuation??null,valuationAsOf:input.valuation==null?null:input.valuationAsOf,valuationSource:input.valuation==null?null:input.valuationSource||'owner_estimate',createdAt:existing?.createdAt||now,updatedAt:now,archivedAt:null};if(existing)Object.assign(existing,property);else s.properties.push(property);s.owner=user;},(s,revision)=>({ok:true,revision,property}),null,'owner');return response(mutation.result);
      }
      if(path==='/api/mortgage'&&request.method==='POST'){
        const input=await body(request);if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before saving a mortgage.',409);
        if(input.action==='archive'||input.action==='restore'){
          const mutation=await mutateWithReplay(env,'mortgage',input,s=>{checkRevision(s,input);const mortgage=s.mortgages?.find(row=>row.id===input.id);if(!mortgage)throw apiError('Mortgage not found.',404);mortgage.archivedAt=input.action==='archive'?mortgage.archivedAt||new Date().toISOString():null;mortgage.updatedAt=new Date().toISOString();},(s,revision)=>({ok:true,revision}),null,'owner');return response(mutation.result);
        }
        const property=(state.properties||[]).find(row=>row.id===input.propertyId&&!row.archivedAt),loanTypes=['fixed','adjustable','interest_only','balloon','heloc','other'],loanType=input.loanType||'fixed',lender=typeof input.lender==='string'?input.lender.trim():'';
        const rate=String(input.annualRatePercent??'');const components=input.components||{};const componentNames=['principalInterest','propertyTax','homeownersInsurance','mortgageInsurance','hoa','otherRequired','extraPrincipal'];
        if(!property||lender.length>100||!loanTypes.includes(loanType)||input.statementBalance!==null&&input.statementBalance!==undefined&&(!Number.isSafeInteger(input.statementBalance)||input.statementBalance<0||input.statementBalance>100_000_000_000_000)||input.statementBalance!==null&&input.statementBalance!==undefined&&(!validDateOnly(input.balanceAsOf)||input.balanceAsOf>dateInReportingZone())||input.originalPrincipal!==null&&input.originalPrincipal!==undefined&&(!Number.isSafeInteger(input.originalPrincipal)||input.originalPrincipal<=0)||input.originationDate!==null&&input.originationDate!==undefined&&!validDateOnly(input.originationDate)||rate.length>16||rate!==''&&(!/^\d{1,3}(?:\.\d{1,8})?$/.test(rate)||Number(rate)>100)||input.termMonths!==null&&input.termMonths!==undefined&&(!Number.isSafeInteger(input.termMonths)||input.termMonths<1||input.termMonths>1200)||componentNames.some(key=>components[key]!==undefined&&components[key]!==null&&(!Number.isSafeInteger(components[key])||components[key]<0))||input.linkedAccountId!==null&&input.linkedAccountId!==undefined&&!state.accounts.some(account=>account.id===input.linkedAccountId&&!account.archivedAt&&['credit','loan','liability','mortgage'].includes(String(account.type||'').toLowerCase()))||input.ownerDebtShareBps!==null&&input.ownerDebtShareBps!==undefined&&(!Number.isSafeInteger(input.ownerDebtShareBps)||input.ownerDebtShareBps<0||input.ownerDebtShareBps>10000))throw apiError('Enter a valid property, loan type, observed balance, terms, payment components, and liability link.');
        if(property.ownershipBps<10000&&input.ownerDebtShareBps==null)throw apiError('For a partially owned property, enter your explicit share of this loan.');
        if(input.linkedAccountId&&(state.mortgages||[]).some(mortgage=>mortgage.id!==input.id&&!mortgage.archivedAt&&mortgage.linkedAccountId===input.linkedAccountId))throw apiError('That liability is already linked to another mortgage record.');
        let mortgage,statementChanged=false;const now=new Date().toISOString();const mutation=await mutateWithReplay(env,'mortgage',input,s=>{checkRevision(s,input);s.mortgages||=[];s.mortgageSnapshots||=[];const existing=input.id?s.mortgages.find(row=>row.id===input.id):null;if(input.id&&!existing)throw apiError('Mortgage not found.',404);statementChanged=!existing||existing.statementBalance!==(input.statementBalance??null)||existing.balanceAsOf!==(input.statementBalance==null?null:input.balanceAsOf);mortgage={...(existing||{}),id:existing?.id||crypto.randomUUID(),propertyId:property.id,lender,loanType,linkedAccountId:input.linkedAccountId||null,ownerDebtShareBps:input.ownerDebtShareBps??(property.ownershipBps===10000?10000:null),statementBalance:input.statementBalance??null,balanceAsOf:input.statementBalance==null?null:input.balanceAsOf,originalPrincipal:input.originalPrincipal??null,originationDate:input.originationDate||null,annualRatePercent:rate||null,termMonths:input.termMonths??null,components:Object.fromEntries(componentNames.map(key=>[key,components[key]??null])),taxInsuranceEscrowed:input.taxInsuranceEscrowed===true,createdAt:existing?.createdAt||now,updatedAt:now,archivedAt:null};if(existing)Object.assign(existing,mortgage);else s.mortgages.push(mortgage);if(mortgage.statementBalance!==null&&statementChanged)s.mortgageSnapshots.push({id:crypto.randomUUID(),mortgageId:mortgage.id,balance:mortgage.statementBalance,asOf:mortgage.balanceAsOf,recordedAt:now,source:'manual'});s.owner=user;},(s,revision)=>({ok:true,revision,mortgage}),null,'owner');return response(mutation.result);
      }
      if(path==='/api/mortgage-projection'&&request.method==='POST'){
        const input=await body(request),mortgage=(state.mortgages||[]).find(row=>row.id===input.id&&!row.archivedAt);if(!mortgage)throw apiError('Mortgage not found.',404);
        const base=mortgage.loanType==='fixed'&&mortgage.originalPrincipal!==null&&mortgage.annualRatePercent!==null&&mortgage.termMonths!==null?compareAmortization({principal:mortgage.originalPrincipal,annualRatePercent:mortgage.annualRatePercent,termMonths:mortgage.termMonths,extraPrincipal:input.extraPrincipal??mortgage.components?.extraPrincipal??0}):{available:false,reason:'Projection unavailable for this loan type or incomplete original terms.'};
        const mortgageSummary=summarizeProperties(state.properties||[],state.mortgages||[],state.accounts,state.items||[]).properties.find(property=>property.id===mortgage.propertyId)?.mortgages.find(row=>row.id===mortgage.id);return response({projection:base,statementBalance:mortgage.statementBalance,balanceAsOf:mortgage.balanceAsOf,projectedBalanceAtStatement:mortgageSummary?.projectedBalanceAtStatement??null,balanceVariance:mortgageSummary?.balanceVariance??null,calculationVersion:'fixed-monthly-v1'});
      }
      if(path==='/api/goal'&&request.method==='POST'){
        const input=await body(request),name=typeof input.name==='string'?input.name.trim():'';
        if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before saving a goal.',409);
        if(input.action==='archive'){
          const mutation=await mutateWithReplay(env,'goal',input,s=>{checkRevision(s,input);const goal=s.goals?.find(value=>value.id===input.id);if(!goal)throw apiError('Savings goal not found.',404);goal.archivedAt=goal.archivedAt||new Date().toISOString();goal.updatedAt=goal.archivedAt;for(const allocation of s.goalAllocations||[])if(allocation.goalId===goal.id&&allocation.active!==false)allocation.active=false;},(s,revision)=>({ok:true,revision}),null,'owner');
          return response(mutation.result);
        }
        const target=input.target,priority=input.priority??100,monthlyContribution=input.monthlyContribution??0,apyBps=input.apyBps??0;
        if(!name||name.length>100||Object.hasOwn(Object.prototype,name)||!Number.isSafeInteger(target)||target<0||target>100_000_000_000||!validDateOnly(input.targetDate)||!Number.isSafeInteger(priority)||priority<0||priority>1000||!Number.isSafeInteger(monthlyContribution)||monthlyContribution<0||monthlyContribution>100_000_000||!Number.isSafeInteger(apyBps)||apyBps<0||apyBps>3000||apyBps>0&&!validDateOnly(input.apyAsOf))throw apiError('Enter a goal name, target, target date, priority, and valid projection assumptions.');
        let savedGoal;
        const mutation=await mutateWithReplay(env,'goal',input,s=>{checkRevision(s,input);s.goals||=[];const existing=input.id?s.goals.find(goal=>goal.id===input.id):null;if(input.id&&!existing)throw apiError('Savings goal not found.',404);const now=new Date().toISOString();savedGoal={...(existing||{}),id:existing?.id||crypto.randomUUID(),name,target,targetDate:input.targetDate,priority,monthlyContribution,apyBps,apyAsOf:apyBps?input.apyAsOf:null,createdAt:existing?.createdAt||now,updatedAt:now,archivedAt:null};if(existing)Object.assign(existing,savedGoal);else s.goals.push(savedGoal);s.owner=user;},(s,revision)=>({ok:true,revision,goal:savedGoal,summary:summarizeGoals(s.goals||[],s.goalAllocations||[],s.accounts,s.items,new Date()).goals.find(goal=>goal.id===savedGoal.id)}),null,'owner');
        return response(mutation.result);
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
        const mutation=await mutateWithReplay(env,'goal-allocations',input,s=>{checkRevision(s,input);const live=s.goals.find(value=>value.id===goal.id&&!value.archivedAt);if(!live)throw apiError('Savings goal is no longer active.',409);s.goalAllocations||=[];s.goalAllocationLedger||=[];const before=s.goalAllocations.filter(value=>value.goalId===goal.id&&value.active!==false).map(value=>({...value}));for(const value of s.goalAllocations)if(value.goalId===goal.id&&value.active!==false)value.active=false;const after=requested.map(row=>({id:crypto.randomUUID(),goalId:goal.id,accountId:row.accountId,amount:row.amount,createdAt:now,active:true}));s.goalAllocations.push(...after);newIds=after.map(value=>value.id);s.goalAllocationLedger.push({id:batchId,goalId:goal.id,createdAt:now,before,afterIds:newIds,undoneAt:null});},(s,revision)=>({ok:true,batchId,revision,summary:summarizeGoals(s.goals||[],s.goalAllocations||[],s.accounts,s.items,new Date()).goals.find(value=>value.id===goal.id)}),null,'owner');
        return response(mutation.result);
      }
      if(path==='/api/goal-allocation-undo'&&request.method==='POST'){
        const input=await body(request),replay=await findOperationReplay(env,state,'goal-allocation-undo',input);if(replay.found)return response(replay.response);
        const batch=state.goalAllocationLedger?.find(value=>value.id===input.batchId&&!value.undoneAt);
        if(!Number.isSafeInteger(input.revision))throw apiError('Refresh this dashboard before undoing goal allocations.',409);if(!batch)throw apiError('Goal allocation undo record not found.',404);
        const current=(state.goalAllocations||[]).filter(value=>value.goalId===batch.goalId&&value.active!==false).map(value=>value.id).sort(),expected=[...batch.afterIds].sort();if(JSON.stringify(current)!==JSON.stringify(expected))throw apiError('This goal’s allocations changed after that edit. Review the current allocations before changing them.',409);
        const eligible=new Map(eligibleCashAccounts(state.accounts,state.items,new Date()).filter(account=>account.eligible).map(account=>[account.accountId,account.balance])),other=new Map();for(const allocation of state.goalAllocations||[])if(allocation.active!==false&&allocation.goalId!==batch.goalId)other.set(allocation.accountId,(other.get(allocation.accountId)||0)+allocation.amount);
        for(const allocation of batch.before){if(!eligible.has(allocation.accountId)||allocation.amount>eligible.get(allocation.accountId)-(other.get(allocation.accountId)||0))throw apiError('The previous allocation no longer fits verified cash balances. Refresh the accounts before undoing.',409);}
        const saved=await mutateWithReplay(env,'goal-allocation-undo',input,s=>{checkRevision(s,input);for(const allocation of s.goalAllocations)if(batch.afterIds.includes(allocation.id))allocation.active=false;for(const prior of batch.before){const live=s.goalAllocations.find(value=>value.id===prior.id);if(live)live.active=true;else s.goalAllocations.push({...prior,active:true});}const entry=s.goalAllocationLedger.find(value=>value.id===batch.id);entry.undoneAt=new Date().toISOString();},(s,revision)=>({ok:true,revision,undone:batch.afterIds.length}),null,'owner');
        return response(saved.result);
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
        if(state.owner&&state.owner!==user)throw apiError('Access denied.',403);
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
        if (!category || !['expense','income','transfer'].includes(category.kind) || state.budgetItemSettings?.[category.id]?.itemType === 'allocation') throw apiError('Choose a valid transaction category.');
        const saved = await mutateWithReplay(env,'category',input,s => { checkRevision(s,input); const t = s.transactions.find(t => t.id === input.id); if (!t) throw apiError('Transaction not found.', 404); const live = categoryCatalog(s).find(c => c.id === category.id && !c.archivedAt); if (!live) throw apiError('That category is no longer available.', 409); t.override = live.name; t.overrideCategoryId = live.id;t.categoryEditVersion=(Number.isSafeInteger(t.categoryEditVersion)?t.categoryEditVersion:0)+1; },(s,revision)=>({ok:true,revision}),[input.id]);
        return response(saved.result);
      }
      if(path==='/api/category-bulk'&&request.method==='POST'){
        const input=await body(request),ids=Array.isArray(input.ids)?[...new Set(input.ids)]:[],category=categoryCatalog(state).find(c=>c.id===input.categoryId&&!c.archivedAt);
        if(!ids.length||ids.length>100||ids.some(id=>typeof id!=='string')||!category||!['expense','income','transfer'].includes(category.kind)||state.budgetItemSettings?.[category.id]?.itemType==='allocation')throw apiError('Choose up to 100 transactions and a valid transaction category.');
        const id=crypto.randomUUID(),mutation=await mutateWithReplay(env,'category-bulk',input,s=>{checkRevision(s,input);const selected=s.transactions.filter(t=>ids.includes(t.id));if(selected.length!==ids.length)throw apiError('One or more selected transactions are no longer available.',409);s.categoryEditBatches||=[];const changes=selected.map(t=>({id:t.id,override:t.override,overrideCategoryId:t.overrideCategoryId}));for(const [index,t] of selected.entries()){t.override=category.name;t.overrideCategoryId=category.id;t.categoryEditVersion=(Number.isSafeInteger(t.categoryEditVersion)?t.categoryEditVersion:0)+1;changes[index].afterVersion=t.categoryEditVersion;}s.categoryEditBatches.push({id,categoryId:category.id,createdAt:new Date().toISOString(),changes});},(s,revision)=>({ok:true,batchId:id,count:ids.length,revision}),ids);
        return response(mutation.result);
      }
      if(path==='/api/category-bulk-undo'&&request.method==='POST'){
        const input=await body(request),replay=await findOperationReplay(env,state,'category-bulk-undo',input);if(replay.found)return response(replay.response);
        const batch=state.categoryEditBatches?.find(item=>item.id===input.batchId);if(!batch)throw apiError('Bulk edit undo record not found.',404);
        let undone=0;const saved=await mutateWithReplay(env,'category-bulk-undo',input,s=>{checkRevision(s,input);const index=s.categoryEditBatches.findIndex(item=>item.id===input.batchId);if(index<0)throw apiError('Bulk edit undo record not found.',404);const [record]=s.categoryEditBatches.splice(index,1);for(const prior of record.changes){const transaction=s.transactions.find(t=>t.id===prior.id);if(!transaction||transaction.overrideCategoryId!==record.categoryId||prior.afterVersion!==undefined&&transaction.categoryEditVersion!==prior.afterVersion)continue;if(prior.override===undefined)delete transaction.override;else transaction.override=prior.override;if(prior.overrideCategoryId===undefined)delete transaction.overrideCategoryId;else transaction.overrideCategoryId=prior.overrideCategoryId;transaction.categoryEditVersion=(Number.isSafeInteger(transaction.categoryEditVersion)?transaction.categoryEditVersion:0)+1;undone++;}},(s,revision)=>({ok:true,revision,undone,skipped:batch.changes.length-undone}),batch.changes.map(change=>change.id));
        return response(saved.result);
      }
      if(path==='/api/import-preview'&&request.method==='POST'){
        const input=await body(request),preview=await prepareCsvImport(input,state);
        return response({account:preview.name,accounts:preview.accounts.map(account=>account.name),revision:preview.revision,headers:preview.headers,rows:preview.rows.length,alreadyImported:!!preview.existingBatch,unknownCategories:preview.unknownCategories,overlapCount:preview.overlaps.length,overlaps:preview.overlaps.slice(0,20),sample:preview.rows.slice(0,10).map(({date,merchant,amount,category,accountName,unknownCategory})=>({date,merchant,amount,category,accountName,unknownCategory:unknownCategory||null}))});
      }
      if(path==='/api/import'&&request.method==='POST'){
        const input=await body(request),replay=await findOperationReplay(env,state,'import',input);if(replay.found)return response(replay.response);
        const preview=await prepareCsvImport(input,state);
        if(!Number.isSafeInteger(input.revision))throw apiError('Reload the import preview before committing.',409);
        checkRevision(state,input);
        if(preview.existingBatch)return response({imported:0,skipped:preview.rows.length,batchId:preview.fileId,alreadyImported:true,revision:state.revision});
        if(preview.unknownCategories.length)throw apiError('Map unknown categories to an existing bucket or create that bucket before importing.');
        if(preview.overlaps.length&&input.confirmOverlaps!==true)throw apiError('Review matching transactions and explicitly confirm whether to keep these rows.',409);
        let imported=0,skipped=0;
        const plannedIds=preview.rows.map((row,index)=>'csv:'+preview.fileId+':'+index);
        const saved=await mutateWithReplay(env,'import',input,s=>{
          checkRevision(s,input);s.owner=user;s.importBatches||=[];
          if(s.importBatches.some(batch=>batch.id===preview.fileId)){skipped=preview.rows.length;return;}
          for(const account of preview.newAccounts)if(!s.accounts.some(a=>a.id===account.id))s.accounts.push({id:account.id,itemId:null,name:account.name,mask:null,type:'manual',subtype:'CSV import',balance:null,currency:'USD',source:'csv'});
          const ids=new Set(s.transactions.map(t=>t.id)),transactionIds=[];
          preview.rows.forEach((row,index)=>{const id='csv:'+preview.fileId+':'+index;if(ids.has(id)){skipped++;return;}const {unknownCategory,sourceRow,accountName,...transaction}=row;s.transactions.push({...transaction,...(sourceRow?{sourceRow}:{}),id,accountId:row.accountId,itemId:null,source:'csv',importBatchId:preview.fileId});transactionIds.push(id);imported++;});
          s.importBatches.push({id:preview.fileId,accountId:preview.accountId,accountIds:[...new Set(preview.rows.map(row=>row.accountId))],createdAt:new Date().toISOString(),transactionIds,imported,skipped});
        },(s,revision)=>({imported,skipped,batchId:preview.fileId,revision,month:preview.rows.map(t=>t.date.slice(0,7)).sort().at(-1)}),plannedIds);
        return response(saved.result);
      }
      if(path==='/api/import-undo'&&request.method==='POST'){
        const input=await body(request),replay=await findOperationReplay(env,state,'import-undo',input);if(replay.found)return response(replay.response);
        const batch=state.importBatches?.find(value=>value.id===input.batchId);
        if(!batch)throw apiError('Import batch not found.',404);
        const saved=await mutateWithReplay(env,'import-undo',input,s=>{checkRevision(s,input);const index=s.importBatches.findIndex(value=>value.id===input.batchId);if(index<0)throw apiError('Import batch not found.',404);s.importBatches.splice(index,1);const ids=new Set(batch.transactionIds);s.transactions=s.transactions.filter(t=>!ids.has(t.id));},(s,revision)=>({ok:true,revision,undone:batch.transactionIds.length}),batch.transactionIds);
        return response(saved.result);
      }
      if (path === '/api/manual-account' && request.method === 'POST') {
        const input=await body(request),name=typeof input.name==='string'?input.name.trim():'';
        if(input.action==='archive'||input.action==='restore'||input.action==='include'){
          if(input.action==='include'&&typeof input.value!=='boolean')throw apiError('Choose whether to include this account in reports.');
          const mutation=await mutateWithReplay(env,'manual-account',input,s=>{checkRevision(s,input);const account=s.accounts.find(a=>a.id===input.id&&a.manual);if(!account)throw apiError('Manual account not found.',404);if(input.action==='include')account.includeInReporting=input.value;else account.archivedAt=input.action==='archive'?new Date().toISOString():null;account.updatedAt=new Date().toISOString();},(s,revision)=>({ok:true,revision}),null,'owner');
          return response(mutation.result);
        }
        const allowedTypes=['depository','credit','investment','retirement','hsa','asset','liability','other'];
        const currency=typeof input.currency==='string'?input.currency.toUpperCase():'USD';
        if(!name||name.length>100||typeof input.type!=='string'||!allowedTypes.includes(input.type)||!/^[A-Z]{3}$/.test(currency)||input.balance!==null&&(!Number.isSafeInteger(input.balance)||Math.abs(input.balance)>1_000_000_000_000)||input.balance!==null&&(!validDateOnly(input.asOf)||input.asOf>dateInReportingZone())||input.institution!==undefined&&(typeof input.institution!=='string'||input.institution.length>100)||input.notes!==undefined&&(typeof input.notes!=='string'||input.notes.length>500)||input.subtype!==undefined&&typeof input.subtype!=='string'||input.includeInReporting!==undefined&&typeof input.includeInReporting!=='boolean')throw apiError('Enter a valid manual account name, type, currency, and observed balance.');
        let savedAccount;
        const mutation=await mutateWithReplay(env,'manual-account',input,s=>{
          checkRevision(s,input);
          const existing=input.id?s.accounts.find(a=>a.id===input.id&&a.manual):null;
          if(input.id&&!existing)throw apiError('Manual account not found.',404);
          const now=new Date().toISOString();
          savedAccount={...(existing||{}),id:existing?.id||crypto.randomUUID(),itemId:null,connectionId:null,source:'manual',manual:true,name,institution:input.institution===undefined?existing?.institution||null:input.institution.trim()||null,type:input.type,subtype:input.subtype===undefined?existing?.subtype||null:input.subtype.trim().slice(0,60)||null,balance:input.balance,currency,balanceAsOf:input.balance===null?null:input.asOf,balanceSource:input.balance===null?null:'manual',includeInReporting:input.includeInReporting===undefined?existing?.includeInReporting!==false:input.includeInReporting,notes:input.notes===undefined?existing?.notes||'':input.notes.trim(),createdAt:existing?.createdAt||now,updatedAt:now,archivedAt:existing?.archivedAt||null};
          if(existing)Object.assign(existing,savedAccount);else s.accounts.push(savedAccount);
          s.owner=user;
        },(s,revision)=>({ok:true,revision,account:savedAccount}),null,'owner');
        return response(mutation.result);
      }
      if (path === '/api/account-update' && request.method === 'POST') {
        const input=await body(request);
        const replay=await findOperationReplay(env,state,'account-update',input);if(replay.found)return response(replay.response);
        if(input.action==='include'&&typeof input.value!=='boolean')throw apiError('Choose whether to include this account in reports.');
        const saved=await mutateWithReplay(env,'account-update',input,s=>{
          checkRevision(s,input);
          const account=s.accounts.find(a=>a.id===input.id&&!a.manual);
          if(!account)throw apiError('Connected account not found.',404);
          if(input.action==='archive')account.archivedAt=account.archivedAt||new Date().toISOString();
          else if(input.action==='restore')account.archivedAt=null;
          else if(input.action==='include')account.includeInReporting=input.value===true;
          else throw apiError('Choose archive, restore, or include.');
        },(s,revision)=>({ok:true,revision}),null,'owner');
        return response(saved.result);
      }
      if (path === '/api/disconnect' && request.method === 'POST') {
        const input = await body(request),item=state.items.find(i=>i.id===input.itemId);checkRevision(state,input);if(!item)throw apiError('Bank connection not found.',404);if(state.syncJob?.status==='running')throw apiError('Wait for the current sync to finish before disconnecting.',409);
        if(item.lifecycle!=='unlinked'&&item.token){if(!item.environment||item.environment!==env.PLAID_ENV)throw apiError('Saved connection environment must be verified before unlinking; no token was sent.');await plaid(env,'/item/remove',{access_token:await decryptToken(env,item.token)});}
        const saved=await mutate(env,s=>{const link=s.items.find(i=>i.id===item.id),sameToken=JSON.stringify(link?.token??null)===JSON.stringify(item.token??null);if(!link||!sameToken||link.lifecycle!==item.lifecycle)throw apiError('This connection changed while unlinking. Refresh and check its status.',409);if(s.syncJob?.status==='running')throw apiError('Wait for the current sync to finish before disconnecting.',409);link.token=null;link.lifecycle='unlinked';link.error=null;link.unlinkedAt=new Date().toISOString();});
        return response({ ok: true, historyRetained:true, revision:saved.revision });
      }
      if (path === '/api/delete-history' && request.method === 'POST') {
        const input=await body(request),item=state.items.find(i=>i.id===input.itemId);checkRevision(state,input);if(!item)throw apiError('Connection history not found.',404);if(state.syncJob?.status==='running')throw apiError('Wait for the current sync to finish before deleting history.',409);if(item.lifecycle!=='unlinked'&&item.token){if(!item.environment||item.environment!==env.PLAID_ENV)throw apiError('Saved connection environment must be verified before deleting history; no token was sent.');await plaid(env,'/item/remove',{access_token:await decryptToken(env,item.token)});}
        const saved=await mutate(env,s=>{const link=s.items.find(i=>i.id===item.id),sameToken=JSON.stringify(link?.token??null)===JSON.stringify(item.token??null);if(!link||!sameToken||link.lifecycle!==item.lifecycle)throw apiError('This connection changed while deleting history. Refresh and check its status.',409);if(s.syncJob?.status==='running')throw apiError('Wait for the current sync to finish before deleting history.',409);s.items=s.items.filter(i=>i.id!==item.id);s.accounts=s.accounts.filter(a=>a.itemId!==item.id);s.transactions=s.transactions.filter(t=>t.itemId!==item.id);s.holdings=(s.holdings||[]).filter(h=>h.itemId!==item.id);});
        return response({ok:true,historyDeleted:true,revision:saved.revision});
      }
      return response({ error: 'Not found' }, 404);
    } catch (e) {
      if(!e.status&&typeof env.logError==='function'){
        const requestId=request.headers.get('x-request-id'),rawRoute=new URL(request.url).pathname,route=/^\/api\/[a-z0-9-]+$/i.test(rawRoute)?rawRoute:'other',errorClass=String(e?.name||'Error').slice(0,64),rawCode=String(e?.code||'');
        env.logError({requestId,method:request.method,route,errorClass,...(/^[A-Z0-9_]{1,64}$/.test(rawCode)?{errorCode:rawCode}:{})});
      }
      return response({ error: e.status ? e.message : 'Something went wrong. Please try again.' }, e.status || 500);
    }
  }
};

function page() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Your spending, beautifully in focus. A private personal finance dashboard."><title>Ledger · Personal finance</title><link rel="stylesheet" href="/assets/styles.css"></head><body><div id="app"></div><div id="toast" role="status" aria-live="polite"></div><script type="module" src="/assets/app.js"></script></body></html>';
}
