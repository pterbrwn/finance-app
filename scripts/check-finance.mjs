import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const { default: worker, totals, fromPlaid, categoryFor, applyChanges, applySyncPages, parseCSV, canonicalOperationPayload, operationPayloadDigest } = await import('../dist/server/index.js');
const { accountRecord, investmentHoldings } = await import('../dist/shared/investments.mjs');
const { budgetMonthKey, calculateBudgetPlan, mapBudgetRolloversByName, resolveBudget, resolveIncomePlan } = await import('../dist/shared/budgets.mjs');
const { normalizeBudgetRecord, budgetRecordsFromProjections, budgetRecordProjections } = await import('../dist/shared/budget-records.mjs');
const { eligibleCashAccounts, goalProjection, summarizeGoals } = await import('../dist/shared/goals.mjs');
const { amortizeFixedRate, compareAmortization, summarizeProperties } = await import('../dist/shared/mortgages.mjs');
const { calculateHomeScenario, validateScenarioInput } = await import('../dist/shared/scenarios.mjs');
const { makeBalanceSheetSnapshot, summarizeBalanceSheet } = await import('../dist/shared/net-worth.mjs');
const { createStateRepository } = await import('../server/repository.mjs');
const { createApiClient, PENDING_OPERATIONS_KEY, readPendingOperations } = await import('../ui/requests.mjs');
const { readViewState, writeViewState } = await import('../ui/view-state.mjs');
const { commitmentForecast } = await import('../shared/commitments.mjs');
globalThis.crypto ||= webcrypto;
const operationPayload={revision:7,name:'Synthetic account',amount:0};
assert.equal(canonicalOperationPayload({b:[2,1],a:true}),'{"a":true,"b":[2,1]}','operation payload serialization sorts object keys and preserves array order');
assert.equal(await operationPayloadDigest('manual-account',operationPayload),'4f138eecf9e4238a800a82df01f8b541d58e7f59d963f5825e95992f3c236775','operation SHA-256 uses scope and canonical JSON bytes');
assert.equal(await operationPayloadDigest('manual-account',{amount:0,name:'Synthetic account',revision:7}),await operationPayloadDigest('manual-account',operationPayload),'reordered JSON object keys have the same operation digest');
assert.notEqual(await operationPayloadDigest('budget',operationPayload),await operationPayloadDigest('manual-account',operationPayload),'operation digest is separated by mutation scope');
assert.throws(()=>canonicalOperationPayload({value:undefined}),/JSON values/,'operation identity rejects non-JSON values instead of silently omitting them');
assert.deepEqual(normalizeBudgetRecord({categoryId:'system:groceries',effectiveMonth:'2026-10',scope:'recurring',monthlyCents:4000,sourceCents:1000,frequency:'weekly',dueMonth:null}),{categoryId:'system:groceries',effectiveMonth:'2026-10',scope:'recurring',monthlyCents:4000,sourceCents:1000,frequency:'weekly',dueMonth:null},'complete budget records retain source and weekly monthly cents together');
assert.deepEqual(budgetRecordProjections(budgetRecordsFromProjections({budgetTemplates:[{categoryId:'system:annual',effectiveFrom:'2026-10',amount:10000}],budgetTemplateSchedules:{'system:annual:2026-10':{frequency:'annual',dueMonth:11,sourceAmount:120000}},monthlyBudgets:{'2026-10:system:zero':0}})).budgetTemplateSchedules['system:annual:2026-10'],{frequency:'annual',dueMonth:11,sourceAmount:120000},'legacy amount and schedule projections round-trip to one complete model');
assert.throws(()=>normalizeBudgetRecord({categoryId:'system:bad',effectiveMonth:'2026-10',scope:'month',monthlyCents:101,sourceCents:1200,frequency:'annual',dueMonth:11}),/inconsistent/,'budget model rejects a source amount that does not produce its saved monthly amount');
let operationJson=null,operationEtag=0;const operationJsonRepository=createStateRepository({get:async()=>operationJson===null?null:{etag:String(operationEtag),json:async()=>JSON.parse(operationJson)},put:async(_key,value,{onlyIf})=>{if(onlyIf.etagMatches!==undefined&&onlyIf.etagMatches!==String(operationEtag)||onlyIf.etagDoesNotMatch!==undefined&&operationJson!==null)return null;operationJson=value;operationEtag++;return{etag:String(operationEtag)};}});
const jsonOperation={id:'synthetic-json-operation',scope:'budget',payloadDigest:await operationPayloadDigest('budget',{revision:0,amount:0})};
const jsonCommit=await operationJsonRepository.mutateWithOperation(jsonOperation,async state=>{state.revision=1;state.budgets={Housing:0};return{...jsonOperation,response:{ok:true,revision:1},revision:1,createdAt:'2026-10-29T12:00:00.000Z'};});
const jsonReplay=await operationJsonRepository.mutateWithOperation(jsonOperation,async()=>{throw new Error('JSON operation replay must skip the domain mutation');});
assert.deepEqual(jsonReplay.result,jsonCommit.result);assert.equal(jsonReplay.replayed,true);assert.equal(JSON.stringify(JSON.parse(operationJson)).includes('Synthetic account'),false,'JSON replay storage contains no raw operation payload');
const viewState={view:'transactions',month:'2025-04',search:'coffee & tea',filter:'Groceries',accountFilter:'acct-1',fromDate:'2025-04-01',toDate:'2025-04-30',reviewOnly:true,transactionPageNumber:3};assert.deepEqual(readViewState('https://ledger.test/ledger?page=transactions&month=2025-04&search=coffee%20%26%20tea&category=Groceries&account=acct-1&from=2025-04-01&to=2025-04-30&review=true&txpage=3','2026-10',['overview','transactions']),viewState,'view-state parsing retains each supported filter and page value');assert.equal(writeViewState('/ledger',viewState,'2026-10'),'/ledger?page=transactions&month=2025-04&search=coffee+%26+tea&category=Groceries&account=acct-1&from=2025-04-01&to=2025-04-30&review=true&txpage=3','view-state serialization keeps deterministic URL state');
const replayCalls=[];let firstReplay=true;const replayClient=createApiClient({createOperationId:()=> 'synthetic-operation-id',fetcher:async(url,options)=>{replayCalls.push({url,options});if(firstReplay){firstReplay=false;return new Response(JSON.stringify({error:'Synthetic gateway'}),{status:502});}return new Response(JSON.stringify({ok:true,revision:1}),{status:200});}});
assert.deepEqual(await replayClient('manual-account',{name:'Synthetic replay'}),{ok:true,revision:1});assert.equal(replayCalls.length,2,'replay-safe requests retry one ambiguous server failure');assert.deepEqual(JSON.parse(replayCalls[0].options.body),JSON.parse(replayCalls[1].options.body),'the API client retries the exact same request body');assert.equal(JSON.parse(replayCalls[0].options.body).clientOperationId,'synthetic-operation-id');
const importRetryCalls=[];let firstImportRetry=true;const importRetryClient=createApiClient({createOperationId:()=> '00000000-0000-4000-8000-000000000001',fetcher:async(url,options)=>{importRetryCalls.push({url,options});if(firstImportRetry){firstImportRetry=false;return new Response(JSON.stringify({error:'Synthetic gateway'}),{status:502});}return new Response(JSON.stringify({imported:1,revision:2}),{status:200});}});assert.deepEqual(await importRetryClient('import',{csv:'Synthetic retry row'}),{imported:1,revision:2});assert.equal(importRetryCalls.length,2,'CSV imports retry one ambiguous server failure');assert.deepEqual(JSON.parse(importRetryCalls[0].options.body),JSON.parse(importRetryCalls[1].options.body),'CSV import retry preserves its exact operation payload');assert.equal(JSON.parse(importRetryCalls[0].options.body).clientOperationId,'00000000-0000-4000-8000-000000000001','CSV import requests carry a stable operation ID');
const sessionValues=new Map(),sessionStore={getItem:key=>sessionValues.get(key)||null,setItem:(key,value)=>sessionValues.set(key,value),removeItem:key=>sessionValues.delete(key)};let droppedAttempts=0;const uncertainClient=createApiClient({sessionStore,createOperationId:()=> '00000000-0000-4000-8000-000000000099',fetcher:async()=>{droppedAttempts++;throw new Error('synthetic lost response');}});
await assert.rejects(uncertainClient('manual-account',{name:'Secret account label',balance:123456,revision:12}),/Could not reach Ledger/);
assert.ok(sessionValues.has(PENDING_OPERATIONS_KEY));const storedPending=readPendingOperations(sessionStore);assert.deepEqual(Object.keys(storedPending[0]).sort(),['baseRevision','operationId','scope','startedAt']);assert.equal(storedPending[0].baseRevision,12);assert.equal(JSON.stringify(storedPending).includes('Secret account label'),false);assert.equal(JSON.stringify(storedPending).includes('123456'),false);assert.equal(droppedAttempts,2,'an uncertain write retains a small same-tab recovery reference across retries');
const resumedClient=createApiClient({sessionStore,createOperationId:()=> '00000000-0000-4000-8000-000000000100',fetcher:async(_url,options)=>{const body=JSON.parse(options.body);assert.equal(body.clientOperationId,storedPending[0].operationId,'same-scope re-entry reuses the unresolved operation ID');assert.equal(body.revision,12,'re-entry retains the original base revision even after current state refreshes');return new Response(JSON.stringify({error:'Changed payload conflict'}),{status:409});}});
await assert.rejects(resumedClient('manual-account',{name:'Changed account label',balance:777,revision:99}),/Changed payload conflict/);assert.equal(readPendingOperations(sessionStore).length,1,'a conflict keeps the unresolved reference until confirmation or explicit review');
const conflictValues=new Map();let conflictId=0;const conflictStore={getItem:key=>conflictValues.get(key)||null,setItem:(key,value)=>conflictValues.set(key,value),removeItem:key=>conflictValues.delete(key)},conflictCalls=[];const staleRevisionClient=createApiClient({sessionStore:conflictStore,createOperationId:()=>`00000000-0000-4000-8000-${String(++conflictId).padStart(12,'0')}`,fetcher:async(url,options)=>{if(url.startsWith('/api/operation-status'))return new Response(JSON.stringify({status:'unknown'}),{status:200});conflictCalls.push(JSON.parse(options.body));return conflictCalls.length===1?new Response(JSON.stringify({error:'Stale revision.'}),{status:409}):new Response(JSON.stringify({ok:true}),{status:200});}});await assert.rejects(staleRevisionClient('budget',{revision:1,amount:100}),/Stale revision/);assert.equal(readPendingOperations(conflictStore).length,0,'a 409 confirmed as unknown clears a stale retry reference');assert.deepEqual(await staleRevisionClient('budget',{revision:2,amount:100}),{ok:true});assert.notEqual(conflictCalls[0].clientOperationId,conflictCalls[1].clientOperationId,'a refreshed edit receives a new operation ID after a confirmed stale-revision rejection');
for(const[path,index]of[['account-update',2],['category-update',3],['import-undo',4],['category-bulk-undo',5],['goal-allocation-undo',6],['budget',7],['budget-reset',8],['income-plan',9],['income-plan-reset',10],['budget-outlook',11]]){const calls=[];let first=true;const client=createApiClient({createOperationId:()=>`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,fetcher:async(url,options)=>{calls.push({url,options});if(first){first=false;return new Response(JSON.stringify({error:'Synthetic gateway'}),{status:502});}return new Response(JSON.stringify({ok:true,revision:2}),{status:200});}});assert.deepEqual(await client(path,{batchId:'synthetic-batch',revision:1}),{ok:true,revision:2},path+' retries a synthetic server failure');assert.equal(calls.length,2,path+' submits exactly two attempts');assert.deepEqual(JSON.parse(calls[0].options.body),JSON.parse(calls[1].options.body),path+' retries the same operation payload');}
let releaseConcurrent;const concurrentGate=new Promise(resolve=>releaseConcurrent=resolve);let concurrentCalls=0;const concurrentClient=createApiClient({createOperationId:()=> 'synthetic-concurrent-operation',fetcher:async()=>{concurrentCalls++;await concurrentGate;return new Response(JSON.stringify({ok:true}),{status:200});}});const concurrentPayload={name:'Synthetic concurrent save'},concurrentFirst=concurrentClient('category-create',concurrentPayload),concurrentSecond=concurrentClient('category-create',concurrentPayload);releaseConcurrent();assert.deepEqual(await Promise.all([concurrentFirst,concurrentSecond]),[{ok:true},{ok:true}]);assert.equal(concurrentCalls,1,'duplicate in-flight writes share one request');
const reportingDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const nextReportingDate=(()=>{const date=new Date(reportingDate+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+1);return date.toISOString().slice(0,10);})();

const effectiveCategoryRows=[
  {id:'source-groceries',date:'2026-10-23',merchant:'Synthetic unchanged groceries',category:'Groceries',categoryId:'system:groceries'},
  {id:'override-dining',date:'2026-10-25',merchant:'Synthetic overridden dining',category:'Groceries',categoryId:'system:groceries',override:'Dining',overrideCategoryId:'system:dining'},
  {id:'legacy-dining',date:'2026-10-24',merchant:'Synthetic legacy dining',category:'Groceries',override:'Dining'},
  {id:'empty-override',date:'2026-10-22',merchant:'Synthetic empty override',category:'Groceries',categoryId:'system:groceries',override:'',overrideCategoryId:'system:dining'}
];
const repositoryState={version:1,owner:null,items:[],accounts:[],transactions:effectiveCategoryRows};
const categoryRepository=createStateRepository({get:async()=>({etag:'synthetic',json:async()=>repositoryState}),put:async()=>({etag:'synthetic'})});
for(const [category,expected] of [['Groceries',['source-groceries','empty-override']],['system:groceries',['source-groceries','empty-override']],['Dining',['override-dining','legacy-dining']],['system:dining',['override-dining']]])
  assert.deepEqual((await categoryRepository.queryTransactions({category})).transactions.map(row=>row.id),expected,`JSON state repository filters by effective category ${category}`);
const fallbackWorker=await worker.fetch(new Request('https://ledger.test/api/transactions?category=Dining',{headers:{'oai-authenticated-user-id':'owner'}}),{REPOSITORY:{read:async()=>({state:repositoryState})}});
assert.deepEqual((await fallbackWorker.json()).transactions.map(row=>row.id),['override-dining','legacy-dining'],'worker full-state fallback filters by the effective displayed category');
const allocationRepository=createStateRepository({get:async()=>({etag:'synthetic-allocation',json:async()=>({version:1,owner:null,items:[],accounts:[],transactions:[{id:'expense',date:'2026-10-10',category:'Dining',amount:2500,currency:'USD'},{id:'allocation',date:'2026-10-11',category:'Savings',categoryId:'custom:savings',amount:90000,currency:'USD'}],categoryRecords:[{id:'custom:savings',name:'Savings',kind:'allocation'}],budgetItemSettings:{'custom:savings':{itemType:'allocation'}}})}),put:async()=>({etag:'synthetic-allocation'})});
const allocationMonth=(await allocationRepository.queryMonthSummary('2026-10')).current;
assert.equal(allocationMonth.spend,2500,'JSON monthly summary excludes explicitly classified allocation transactions from spending');
assert.deepEqual(allocationMonth.categories,{Dining:2500});assert.equal(allocationMonth.purchases,1,'allocation transfers do not count as purchases');

const goalAccounts=[
  {id:'cash',name:'Checking',type:'depository',balance:10000,availableBalance:8000,currency:'USD',itemId:'bank',includeInReporting:true},
  {id:'retirement',type:'retirement',balance:50000,currency:'USD',itemId:'bank'},
  {id:'brokerage',type:'investment',balance:50000,currency:'USD',itemId:'bank'},
  {id:'credit',type:'credit',balance:2000,currency:'USD',itemId:'bank'},
  {id:'stale',type:'depository',balance:3000,currency:'USD',itemId:'old'},
  {id:'cad',type:'depository',balance:3000,currency:'CAD',itemId:'bank'}
];
const cashEligibility=eligibleCashAccounts(goalAccounts,[{id:'bank',lastSuccess:'2026-10-25T10:00:00.000Z'},{id:'old',lastSuccess:'2026-10-20T10:00:00.000Z'}],new Date('2026-10-25T12:00:00.000Z'));
assert.deepEqual(cashEligibility.filter(account=>account.eligible).map(account=>[account.accountId,account.balance]),[['cash',8000]],'available USD depository cash is capped and restrictions are excluded');
assert.equal(cashEligibility.find(account=>account.accountId==='stale').provisional,true);
const cappedCash=eligibleCashAccounts([
  {id:'negative-available',type:'depository',balance:10000,availableBalance:-1,currency:'USD',itemId:'bank'},
  {id:'missing-available',type:'depository',balance:7000,availableBalance:null,currency:'USD',itemId:'bank'},
  {id:'liability-cash',type:'liability',subtype:'cash',balance:50000,currency:'USD',itemId:'bank'},
  {id:'manual-cash',type:'asset',subtype:'cash',balance:3000,currency:'USD',manual:true,balanceAsOf:'2026-10-25'}
],[{id:'bank',lastSuccess:'2026-10-25T10:00:00.000Z'}],new Date('2026-10-25T12:00:00.000Z'));
assert.deepEqual(cappedCash.map(account=>[account.accountId,account.balance,account.eligible]),[['negative-available',0,true],['missing-available',7000,true],['liability-cash',0,false],['manual-cash',3000,true]],'negative available balances cap backing at zero, while absent values fall back to current USD cash');
const futureCash=eligibleCashAccounts([{id:'future-cash',name:'Future cash',type:'depository',balance:9000,currency:'USD',manual:true,balanceAsOf:'2099-01-01'}],[],new Date('2026-10-25T12:00:00.000Z'))[0];
assert.equal(futureCash.eligible,false,'a future observation cannot fund a present goal');assert.equal(futureCash.stale,true);
const goalRows=[{id:'g1',target:10000,targetDate:'2026-12-31',priority:1,createdAt:'2026-01-01'},{id:'g2',target:10000,targetDate:'2026-12-31',priority:2,createdAt:'2026-01-02'}];
const allocations=[{id:'a1',goalId:'g1',accountId:'cash',amount:7000},{id:'a2',goalId:'g2',accountId:'cash',amount:7000}];
const goalsSummary=summarizeGoals(goalRows,allocations,goalAccounts,[{id:'bank',lastSuccess:'2026-10-25T10:00:00.000Z'},{id:'old',lastSuccess:'2026-10-20T10:00:00.000Z'}],new Date('2026-10-25T12:00:00.000Z'));
assert.equal(goalsSummary.goals[0].backed,7000);assert.equal(goalsSummary.goals[0].funded,7000);assert.equal(goalsSummary.goals[0].shortfall,3000);assert.equal(goalsSummary.goals[1].backed,1000);assert.equal(goalsSummary.goals[1].accountShortfall,6000);
assert.equal(goalsSummary.unallocatedTotal,0);assert.equal(allocations[0].active,undefined,'summaries do not mutate allocation history');
const octoberDeadline=goalProjection({target:10000,funded:0,targetDate:'2026-10-31',asOf:'2026-10-25'});
assert.equal(octoberDeadline.contributionDates,1,'a remaining current-month end is an eligible contribution date');assert.deepEqual(octoberDeadline.scheduledDates,['2026-10-31']);assert.equal(octoberDeadline.requiredMonthly,10000);assert.equal(octoberDeadline.overdue,false);
const januaryDeadline=goalProjection({target:10000,funded:5000,targetDate:'2027-01-31',asOf:'2026-10-25'});
assert.equal(januaryDeadline.contributionDates,4,'contributions include every future month end, including the current month end');assert.deepEqual(januaryDeadline.scheduledDates,['2026-10-31','2026-11-30','2026-12-31','2027-01-31']);
assert.equal(januaryDeadline.projectedAtTarget,5000,'zero return and zero contribution are the default');
assert.deepEqual(goalProjection({target:10000,funded:5000,targetDate:'2026-11-30',asOf:'2026-10-31'}).scheduledDates,['2026-11-30'],'month-end as-of dates begin scheduling in the next month');
assert.deepEqual(goalProjection({target:10000,funded:5000,targetDate:'2026-11-01',asOf:'2026-10-25'}).scheduledDates,['2026-10-31'],'an early-month deadline still includes the preceding month end');
const futureWithoutContribution=goalProjection({target:10000,funded:5000,targetDate:'2026-10-26',asOf:'2026-10-25'});assert.equal(futureWithoutContribution.contributionDates,0);assert.equal(futureWithoutContribution.overdue,false,'a future date before the next contribution date is not overdue');
assert.equal(goalProjection({target:10000,funded:0,targetDate:'2026-10-24',asOf:'2026-10-25'}).overdue,true,'a past deadline with a shortfall is overdue');
assert.deepEqual(goalProjection({target:10000,funded:0,targetDate:'2024-02-29',asOf:'2024-02-01'}).scheduledDates,['2024-02-29'],'leap-year month end is preserved');
assert.equal(goalProjection({target:10000,funded:5000,targetDate:'2026-10-31',asOf:new Date('2026-10-26T00:30:00Z')}).contributionDates,1,'instant timestamps use the Chicago reporting date');
const apyGoal=goalProjection({target:1000000,funded:500000,targetDate:'2026-10-31',asOf:'2026-10-25',monthlyContribution:10000,apyBps:1200});assert.equal(apyGoal.projectedAtTarget,510915,'dated 12% APY uses six remaining days of first-month growth, rounds cents, then applies the month-end contribution');
const oversizedGoalProjection=goalProjection({target:Number.MAX_SAFE_INTEGER,funded:Number.MAX_SAFE_INTEGER,targetDate:'2036-12-31',asOf:'2026-10-25',monthlyContribution:0,apyBps:3000});assert.equal(oversizedGoalProjection.growthAvailable,false,'goal projections outside the safe-cent range are marked unavailable');assert.equal(oversizedGoalProjection.projectedAtTarget,null);
assert.throws(()=>summarizeGoals([],[],[{id:'large-cash-a',type:'depository',balance:Number.MAX_SAFE_INTEGER,currency:'USD',manual:true,balanceAsOf:'2026-10-25'},{id:'large-cash-b',type:'depository',balance:1,currency:'USD',manual:true,balanceAsOf:'2026-10-25'}],[],new Date('2026-10-25T12:00:00.000Z')),/safe integer-cent range/,'goal cash aggregation rejects unsafe totals');
const fixedLoan=amortizeFixedRate({principal:32000000,annualRatePercent:'6.5',termMonths:360});
assert.equal(fixedLoan.payment,202262,'fixed-rate payment follows half-up cent convention');assert.equal(fixedLoan.schedule.at(-1).closingBalance,0,'final payment is capped at the remaining principal');const roundedFinal=amortizeFixedRate({principal:31000000,annualRatePercent:'6.5',termMonths:360});assert.equal(roundedFinal.available,true,'rounding residue is cleared by the final payment');assert.equal(roundedFinal.schedule.at(-1).closingBalance,0);
assert.equal(amortizeFixedRate({principal:12000000,annualRatePercent:'0',termMonths:120}).payment,100000,'zero-rate terms divide principal evenly');
const balloonSchedule=amortizeFixedRate({principal:100000,annualRatePercent:'0',termMonths:12,scheduledPayment:500});assert.equal(balloonSchedule.available,false,'a principal-reducing payment that leaves a maturity balloon is not presented as fully amortizing');assert.match(balloonSchedule.reason,/balloon at maturity/);
const extraLoan=compareAmortization({principal:32000000,annualRatePercent:'6.5',termMonths:360,extraPrincipal:50000});assert.equal(extraLoan.available,true);assert.ok(extraLoan.interestSaved>0&&extraLoan.monthsSaved>0);
assert.equal(amortizeFixedRate({principal:100000,annualRatePercent:'12',termMonths:120,scheduledPayment:1}).available,false,'non-amortizing inputs are rejected');
const unsafeLoanProjection=amortizeFixedRate({principal:Number.MAX_SAFE_INTEGER,annualRatePercent:'10',termMonths:1200});assert.equal(unsafeLoanProjection.available,false,'loan projections whose cumulative interest exceeds safe integer cents are unavailable');assert.match(unsafeLoanProjection.reason,/safe integer-cent range/);
const propertySummaryFixture=summarizeProperties([{id:'home',name:'Home',ownershipBps:10000,valuation:40000000}], [{id:'first',propertyId:'home',statementBalance:30000000},{id:'heloc',propertyId:'home',statementBalance:2000000}],[]);
assert.equal(propertySummaryFixture.properties[0].wholePropertyEquity,8000000,'equity includes all liens');
const negativeEquity=summarizeProperties([{id:'underwater',ownershipBps:10000,valuation:10000000}],[{id:'loan',propertyId:'underwater',statementBalance:12000000}],[]);assert.equal(negativeEquity.properties[0].ownerEquity,-2000000);
const missingValue=summarizeProperties([{id:'missing',ownershipBps:10000,valuation:null}],[],[]);assert.equal(missingValue.properties[0].ownerEquity,null,'missing valuation is unavailable, not zero');
const partialOwnership=summarizeProperties([{id:'shared',ownershipBps:5000,valuation:10000000}],[{id:'shared-loan',propertyId:'shared',statementBalance:6000000,ownerDebtShareBps:2500}],[]);assert.equal(partialOwnership.properties[0].ownerEquity,3500000);
const duplicateLink=summarizeProperties([{id:'linked',ownershipBps:10000,valuation:10000000}],[{id:'m1',propertyId:'linked',linkedAccountId:'debt',statementBalance:500000},{id:'m2',propertyId:'linked',linkedAccountId:'debt',statementBalance:500000}],[]);assert.equal(duplicateLink.properties[0].debtComplete,false,'duplicate liability references make equity incomplete');
const goldenScenario={name:'Synthetic purchase',targetDate:'2027-10-25',purchasePrice:40000000,downPayment:8000000,financedFees:0,termMonths:360,noteRatePercent:'6.5',pmiExplicitNone:true,propertyTaxMonthly:50000,homeownersInsuranceMonthly:15000,supplementaryInsuranceMonthly:0,hoaMonthly:7500,maintenanceReserveMonthly:30000,subordinateDebtMonthly:0,taxEscrowed:false,insuranceEscrowed:false,closingCosts:1200000,prepaids:400000,credits:300000,earnestPaid:500000,movingCosts:0,initialRepairs:0,retainedReserve:0,otherDebtPayments:0,currentNonHousingCommitments:0,currentHousingCost:0,plannedSavings:0,safetyMargin:0,pointsCents:0,netMonthlyIncome:null,grossMonthlyIncome:null,replaceCurrentHousing:true,rateSource:'Manual',rateAsOf:'2026-10-25',quoteType:'estimate'};
const purchaseCalc=calculateHomeScenario(goldenScenario,{eligibleCash:20000000,allocatedGoalFunds:0,asOf:'2026-10-25'});
assert.equal(purchaseCalc.available,true);assert.equal(purchaseCalc.principalAndInterest,202262);assert.equal(purchaseCalc.ownershipOutflow,304762,'tax, insurance and HOA are counted once; maintenance is included in cash flow only');
assert.equal(purchaseCalc.remainingCashToClose,8800000,'credits and earnest reduce remaining cash to close without cash back');assert.equal(purchaseCalc.allInAcquisitionFunding,8800000);assert.equal(purchaseCalc.alreadyPaid,500000);assert.equal(purchaseCalc.cashAfterClosing,11200000);assert.equal(purchaseCalc.dtiPercent,null);assert.equal(purchaseCalc.cashFlowSurplus,null);
assert.equal(purchaseCalc.excessCashOffsets,0);
assert.equal(validateScenarioInput({...goldenScenario,propertyTaxMonthly:null}),'Enter monthly property tax in USD; enter 0 if none.','unknown ownership costs cannot silently become zero');
assert.equal(calculateHomeScenario({...goldenScenario,propertyTaxMonthly:null}).available,false);
assert.equal(validateScenarioInput({...goldenScenario,netMonthlyIncome:800000,currentNonHousingCommitments:null}),'Enter current non-housing commitments in USD; enter 0 if none.','cash-flow fit requires explicit current commitments when income is supplied');
assert.equal(validateScenarioInput({...goldenScenario,grossMonthlyIncome:1000000,otherDebtPayments:null}),'Enter other monthly debt payments in USD; enter 0 if none.','DTI requires explicit other debt payments when gross income is supplied');
const excessOffsets=calculateHomeScenario({...goldenScenario,credits:20000000,earnestPaid:5000000});assert.equal(excessOffsets.remainingCashToClose,0);assert.equal(excessOffsets.excessCashOffsets,15400000,'excess credits and earnest are visible without negative cash back');
const escrowedScenario=calculateHomeScenario({...goldenScenario,taxEscrowed:true,insuranceEscrowed:true,retainedReserve:1000000,netMonthlyIncome:800000,grossMonthlyIncome:1000000,currentHousingCost:100000,replaceCurrentHousing:false},{eligibleCash:9000000,allocatedGoalFunds:1000000});assert.equal(escrowedScenario.ownershipOutflow,304762,'escrow does not double count tax and insurance');assert.equal(escrowedScenario.allInAcquisitionFunding,9800000);assert.equal(escrowedScenario.fundingShortfall,0);assert.equal(escrowedScenario.cashFlowSurplus,800000-100000-304762,'keeping current housing and safety commitments remain explicit');assert.ok(escrowedScenario.dtiPercent>0);assert.equal(escrowedScenario.rateSensitivity.length,5);assert.equal(escrowedScenario.taxInsuranceSensitivity.length,2);assert.equal(escrowedScenario.incomeSensitivity.length,2);
assert.equal(validateScenarioInput({...goldenScenario,targetDate:'2026-02-30'}),'Enter a valid target date.');
assert.equal(calculateHomeScenario({...goldenScenario,pmiExplicitNone:false,pmiMonthly:null}).available,false,'PMI must be estimated or explicitly marked none');
const balanceSummary=summarizeBalanceSheet([
  {id:'cash',name:'Checking',type:'depository',balance:10000,currency:'USD',itemId:'bank'},
  {id:'invest',name:'Brokerage',type:'investment',balance:25000,currency:'USD',itemId:'bank'},
  {id:'card',name:'Card',type:'credit',balance:-5000,currency:'USD',itemId:'bank'},
  {id:'mortgage-liability',name:'Mortgage',type:'liability',balance:-30000000,currency:'USD',itemId:'bank'},
  {id:'foreign',name:'Foreign',type:'depository',balance:400,currency:'CAD',itemId:'bank'},
  {id:'unknown',name:'Unknown',type:'depository',balance:null,currency:'USD',itemId:'bank'},
  {id:'other-asset',name:'Other asset',type:'asset',balance:2000,currency:'USD',manual:true,balanceAsOf:'2026-10-25'}
],[{id:'bank',lastSuccess:'2026-10-25T10:00:00.000Z'}],{properties:[{id:'home',name:'Home',ownerValue:40000000,ownerDebt:32000000,ownerEquity:8000000,valuationAsOf:'2026-10-25',debtComplete:true,mortgages:[{id:'loan',linkedAccountId:'mortgage-liability',statementBalance:32000000,balanceAsOf:'2026-10-25'}]}]},new Date('2026-10-25T12:00:00.000Z'));
assert.equal(balanceSummary.totals.cash,10000);assert.equal(balanceSummary.totals.investments,25000,'holdings are not added to their investment account');assert.equal(balanceSummary.totals.property,40000000);assert.equal(balanceSummary.totals.liabilities,32005000,'linked mortgage liability is counted once');assert.equal(balanceSummary.totals.netWorth,8032000);assert.equal(balanceSummary.incomplete,true);assert.equal(balanceSummary.coverage.nonUsdAccounts,1);assert.equal(balanceSummary.coverage.unknownBalanceAccounts,1);
assert.throws(()=>summarizeBalanceSheet([{id:'large-cash-a',type:'depository',balance:Number.MAX_SAFE_INTEGER,currency:'USD',manual:true,balanceAsOf:'2026-10-25'},{id:'large-cash-b',type:'depository',balance:1,currency:'USD',manual:true,balanceAsOf:'2026-10-25'}],[],{properties:[]},new Date('2026-10-25T12:00:00.000Z')),/safe integer-cent range/,'balance-sheet totals reject unsafe account aggregation');
assert.throws(()=>summarizeProperties([{id:'large-debt-home',ownershipBps:10000,valuation:10000000}],[{id:'large-debt-a',propertyId:'large-debt-home',statementBalance:Number.MAX_SAFE_INTEGER},{id:'large-debt-b',propertyId:'large-debt-home',statementBalance:1}],[]),/safe integer-cent range/,'property debt aggregation rejects unsafe mortgage totals');
const foreignMortgageFallback=summarizeProperties([{id:'foreign-home',ownershipBps:10000,valuation:1000000}],[{id:'foreign-loan',propertyId:'foreign-home',linkedAccountId:'cad-liability',ownerDebtShareBps:10000}],[{id:'cad-liability',type:'liability',balance:-200000,currency:'CAD',balanceAsOf:'2026-10-25'}]);
assert.equal(foreignMortgageFallback.properties[0].ownerDebt,null,'a linked CAD liability is not relabeled as USD mortgage debt');assert.equal(foreignMortgageFallback.properties[0].debtComplete,false);
const foreignMortgageSheet=summarizeBalanceSheet([{id:'cad-liability',type:'liability',balance:-200000,currency:'CAD',balanceAsOf:'2026-10-25'}],[],foreignMortgageFallback,new Date('2026-10-25T12:00:00.000Z'));
assert.equal(foreignMortgageSheet.coverage.missingMortgageBalances,1);assert.equal(foreignMortgageSheet.incomplete,true);
const staleMortgageFallback=summarizeProperties([{id:'stale-home',ownershipBps:10000,valuation:1000000}],[{id:'stale-loan',propertyId:'stale-home',linkedAccountId:'stale-debt',ownerDebtShareBps:10000}],[{id:'stale-debt',type:'liability',balance:-200000,currency:'USD',balanceAsOf:'2026-08-01'}],[],new Date('2026-10-28T12:00:00.000Z'));
assert.equal(staleMortgageFallback.properties[0].ownerDebt,null,'a stale linked balance does not become a current mortgage observation');assert.equal(staleMortgageFallback.properties[0].debtComplete,false);
const missingDateMortgageFallback=summarizeProperties([{id:'undated-home',ownershipBps:10000,valuation:1000000}],[{id:'undated-loan',propertyId:'undated-home',linkedAccountId:'undated-debt',ownerDebtShareBps:10000}],[{id:'undated-debt',type:'liability',balance:-200000,currency:'USD'}],[],new Date('2026-10-28T12:00:00.000Z'));
assert.equal(missingDateMortgageFallback.properties[0].ownerDebt,null,'a linked balance without observation date is unavailable');
const liabilityAsCash=summarizeBalanceSheet([{id:'liability-cash',name:'Synthetic liability',type:'liability',subtype:'cash',balance:10000,currency:'USD',manual:true,balanceAsOf:'2026-10-25'}],[],{properties:[]},new Date('2026-10-25T12:00:00.000Z'));
assert.deepEqual(liabilityAsCash.totals,{cash:0,investments:0,otherAssets:0,property:0,debts:10000,assets:0,liabilities:10000,netWorth:-10000},'a cash subtype cannot turn a liability into an asset');
const conflictingAccountSubtypes=summarizeBalanceSheet([
  {id:'depository-brokerage',type:'depository',subtype:'brokerage',balance:30000,currency:'USD',manual:true,balanceAsOf:'2026-10-25'},
  {id:'asset-cash',type:'asset',subtype:'cash',balance:40000,currency:'USD',manual:true,balanceAsOf:'2026-10-25'},
  {id:'investment-cash',type:'investment',subtype:'cash',balance:60000,currency:'USD',manual:true,balanceAsOf:'2026-10-25'},
  {id:'other-brokerage',type:'other',subtype:'brokerage',balance:50000,currency:'USD',manual:true,balanceAsOf:'2026-10-25'},
  {id:'credit-brokerage',type:'credit',subtype:'brokerage',balance:-20000,currency:'USD',manual:true,balanceAsOf:'2026-10-25'}
],[],{properties:[]},new Date('2026-10-25T12:00:00.000Z'));
assert.equal(conflictingAccountSubtypes.totals.cash,70000,'depository type remains cash while compatible asset cash remains cash');assert.equal(conflictingAccountSubtypes.totals.investments,110000,'investment type and compatible other brokerage subtype remain investments');assert.equal(conflictingAccountSubtypes.totals.liabilities,20000,'credit type remains debt despite its brokerage subtype');

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
assert.throws(()=>fromPlaid({amount:Number.MAX_SAFE_INTEGER,transaction_id:'unsafe-provider'},'i'),/safe integer-cent range/,'provider amounts outside safe integer cents are rejected');
assert.throws(()=>totals([{amount:Number.MAX_SAFE_INTEGER,category:'Dining',currency:'USD'},{amount:1,category:'Dining',currency:'USD'}]),/safe integer-cent range/,'spending totals reject unsafe integer overflow');
const providerAccount={account_id:'same-account',name:'Brokerage',type:'investment',balances:{current:1000,iso_currency_code:'USD'}};
assert.notEqual(accountRecord(providerAccount,'item-a').id,accountRecord(providerAccount,'item-b').id,'provider account IDs are scoped to their connection');
assert.equal(fromPlaid({amount:1,transaction_id:'scoped-tx',account_id:'same-account'},'item-a').accountId,accountRecord(providerAccount,'item-a').id);
assert.equal(investmentHoldings({securities:[{security_id:'security-1',name:'Fund',ticker_symbol:'FND'}],holdings:[{account_id:'same-account',security_id:'security-1',quantity:2,institution_value:40,iso_currency_code:'CAD',institution_price_as_of:'2026-10-01'}]},'item-a')[0].accountId,accountRecord(providerAccount,'item-a').id);
const pending = {id:'pending',override:'Travel',overrideCategoryId:'custom-travel-id',categoryEditVersion:7,category:'Other',currency:'USD',amount:1000,pending:true};
pending.overrideCategoryId='custom-travel-id';
const state={transactions:[pending,{id:'gone',amount:1}]};
const posted={transaction_id:'posted',pending_transaction_id:'pending',amount:12.34,date:'2026-10-01',name:'Hotel',iso_currency_code:'USD'};
applyChanges(state,'item',[posted],[],[{transaction_id:'pending'},{transaction_id:'gone'}]);
assert.equal(state.transactions.length,1);assert.equal(state.transactions[0].override,'Travel');
assert.equal(state.transactions[0].overrideCategoryId,'custom-travel-id','pending-to-posted sync preserves stable category identity');
assert.equal(state.transactions[0].categoryEditVersion,7,'provider reconciliation preserves category edit versions used by undo');
for (const pages of [
  [{added:[],modified:[],removed:[{transaction_id:'pending'}]},{added:[posted],modified:[],removed:[]}],
  [{added:[posted],modified:[],removed:[]},{added:[],modified:[],removed:[{transaction_id:'pending'}]}]
]) {
  const paged={transactions:[{...pending}]};
  applySyncPages(paged,'item',pages);
  assert.equal(paged.transactions.length,1);
  assert.equal(paged.transactions[0].override,'Travel');
  assert.equal(paged.transactions[0].overrideCategoryId,'custom-travel-id');
  assert.equal(paged.transactions[0].categoryEditVersion,7);
}
applyChanges(state,'item',[posted],[{...posted,amount:15}],[]);
assert.equal(state.transactions.length,1);assert.equal(state.transactions[0].amount,1500);
assert.equal(state.transactions[0].overrideCategoryId,'custom-travel-id','modified provider rows preserve the full local category override');
assert.equal(parseCSV('Date,Merchant,Amount,Category\r\n2026-10-01,"Store, \"\"Main\"\"",12.34,Shopping\r\n')[0].merchant,'Store, "Main"');
assert.throws(()=>parseCSV('Date,Merchant,Amount\n2026-02-30,Store,1.00'),/Invalid/);
assert.throws(()=>parseCSV('Date,Merchant,Amount\n2026-10-01,Store,1.00,Extra'),/fields/);
assert.throws(()=>parseCSV('Date,Merchant,Amount\n2026-10-01,Store,1"2'),/quote/i);
const mappedCSV=parseCSV('Posted On,Payee,Debit,Category\n10/25/2026,Vendor,12.50,NewTag',['Travel'],{columnMapping:{date:'Posted On',merchant:'Payee',amount:'Debit',category:'Category'},dateFormat:'MM/DD/YYYY',amountMode:'negative-spending',categoryMapping:{NewTag:'Travel'}})[0];
assert.equal(mappedCSV.date,'2026-10-25');assert.equal(mappedCSV.amount,-1250);assert.equal(mappedCSV.category,'Travel');assert.equal(mappedCSV.sourceCategory,'NewTag');
const accountMappedRows=parseCSV('Date,Merchant,Amount,Category,Account\n2026-10-01,First,1.00,Shopping,Everyday Checking\n2026-10-02,Second,2.00,Groceries,Rewards Credit',['Shopping','Groceries'],{columnMapping:{account:'Account'}});assert.deepEqual(accountMappedRows.map(row=>row.accountName),['Everyday Checking','Rewards Credit'],'CSV parsing retains a separate account on each transaction');assert.throws(()=>parseCSV('Date,Merchant,Amount,Account\n2026-10-01,Missing account,1.00,',['Shopping'],{columnMapping:{account:'Account'}}),/account name/i,'blank per-row account attribution is rejected');
assert.throws(()=>parseCSV('Date,Merchant,Amount\n2026-10-01,Store,NaN'),/amount/);
const largeSyntheticCSV='Date,Merchant,Amount,Category\n'+Array.from({length:5000},(_,index)=>'2026-10-01,Synthetic Merchant '+index+',1.00,Shopping').join('\n');assert.equal(parseCSV(largeSyntheticCSV).length,5000,'the maximum supported import size validates with synthetic records');

assert.throws(()=>parseCSV('Date,Merchant,Amount,Currency\n2026-10-01,Store,1.00,CAD'),/USD/);

class Bucket {
  value = null; version = 0;
  async get(){return this.value===null?null:{etag:String(this.version),json:async()=>JSON.parse(this.value)};}
  async put(key,value,options){const condition=options.onlyIf;if(condition.etagMatches && condition.etagMatches!==String(this.version))return null;if(condition.etagDoesNotMatch==='*'&&this.value!==null)return null;this.value=value;this.version++;return {etag:String(this.version)};}
}
const env={BUCKET:new Bucket(),getSyncTimerStatus:async()=>({state:'available',enabled:false,active:false,enabledState:'disabled',activeState:'inactive'}),PLAID_ENV:'sandbox',PLAID_CLIENT_ID:'test-client',PLAID_SECRET:'test-secret',TOKEN_ENCRYPTION_KEY:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')};
const call=(path,input,user='owner',origin)=>worker.fetch(new Request('https://ledger.test/api/'+path,{method:input===undefined?'GET':'POST',headers:{...(user?{'oai-authenticated-user-id':user}:{}),...(origin?{Origin:origin}:{}),...(input!==undefined?{'Content-Type':'application/json'}:{})},body:input===undefined?undefined:JSON.stringify(input)}),env);
const stateSnapshot=async()=>{const bounded=await(await call('state')).json(),stored=JSON.parse(env.BUCKET.value||'{}');return{...bounded,...stored,owner:undefined,lease:undefined,items:bounded.items,setup:bounded.setup};};
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
  const boundedDashboard=await(await call('state')).json();assert.equal(boundedDashboard.transactions,undefined,'routine dashboard payload excludes transaction history');assert.equal(boundedDashboard.scenarios,undefined,'routine dashboard payload excludes full scenario histories');assert.equal(boundedDashboard.transactionCount,1);
  let publicData=await stateSnapshot();
  const monthSummary=(await(await call('month-summary?month=2026-10')).json()).current,expectedMonth=totals(publicData.transactions.filter(row=>row.date.startsWith('2026-10')));assert.equal(monthSummary.spend,expectedMonth.spend);assert.equal(monthSummary.income,expectedMonth.income);assert.deepEqual(monthSummary.categories,expectedMonth.categories,'bounded summary reconciles to every matching transaction');
  const boundedPage=await(await call('transactions?month=2026-10&limit=100&page=1')).json();assert.equal(boundedPage.transactions.length,1);assert.equal(boundedPage.transactions[0].id,publicData.transactions[0].id);
  assert.equal((await(await call('transactions?limit=1000&page=1')).json()).limit,100,'transaction APIs cap every requested page at 100 rows');
  assert.equal(publicData.transactions.length,1);assert.equal(publicData.items[0].name,'Chase');assert.equal(publicData.setup.syncTimer.enabled,false);
  assert.ok(!JSON.stringify(publicData).includes('never-expose'));
  assert.ok(!env.BUCKET.value.includes('never-expose'));
  assert.equal(publicData.items[0].token,undefined);assert.equal(publicData.items[0].cursor,undefined);
  const savedAccount=publicData.accounts.find(a=>a.itemId==='item-1');
  assert.ok(savedAccount);assert.equal(rateLimitAccountsOnce,false,'a transient provider rate limit is retried with backoff');
  const accountUpdatePayload={id:savedAccount.id,action:'include',value:false,revision:publicData.revision,clientOperationId:'00000000-0000-4000-8000-000000000006'};
  const includeResult=await call('account-update',accountUpdatePayload);
  assert.equal(includeResult.status,200);
  publicData=await stateSnapshot();
  assert.equal(publicData.accounts.find(a=>a.id===savedAccount.id).includeInReporting,false);
  const accountUpdateRevision=publicData.revision,includeReplay=await call('account-update',accountUpdatePayload);assert.equal(includeReplay.status,200);assert.deepEqual(await includeReplay.json(),await includeResult.clone().json(),'a connected-account update replays its original result after the revision changes');assert.equal((await stateSnapshot()).revision,accountUpdateRevision,'replaying a connected-account update does not advance the revision twice');
  assert.equal((await call('account-update',{...accountUpdatePayload,value:true})).status,409,'a connected-account operation ID cannot be reused for different values');assert.equal((await stateSnapshot()).revision,accountUpdateRevision,'a changed connected-account replay leaves the revision unchanged');
  assert.equal((await call('link-token',{itemId:'item-1',product:'investments'})).status,409,'update mode cannot silently change the saved product');
  assert.equal((await call('account-update',{id:savedAccount.id,action:'archive',revision:publicData.revision})).status,200);
  assert.ok((await stateSnapshot()).accounts.find(a=>a.id===savedAccount.id).archivedAt);
  assert.equal((await call('state',undefined,'other-owner')).status,403);
  publicData=await stateSnapshot();
  assert.equal((await call('category',{id:'posted',category:'Travel',revision:publicData.revision})).status,200);
  publicData=await stateSnapshot();assert.equal((await call('category',{id:'posted',categoryId:'system:income',revision:publicData.revision})).status,200,'a transaction can be corrected to Income');
  publicData=await stateSnapshot();assert.equal((await call('category',{id:'posted',categoryId:'system:transfers',revision:publicData.revision})).status,200,'a transaction can be corrected to Transfers');
  publicData=await stateSnapshot();assert.equal((await call('category',{id:'posted',category:'Travel',revision:publicData.revision})).status,200);
  const firstManualSync=await call('sync',{});assert.equal(firstManualSync.status,200);assert.equal((await waitJob(await firstManualSync.json())).status,'succeeded');
  publicData=await stateSnapshot();
  assert.equal(publicData.transactions.length,1);assert.equal(publicData.transactions[0].override,'Travel');
  assert.equal(seen.filter(x=>x.url.endsWith('/transactions/sync')).at(-1).input.cursor,'cursor-1');
  holdTransactionSync=true;releaseTransactionSync=null;const overlapStart=await(await call('sync',{})).json();for(let i=0;i<100&&!releaseTransactionSync;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(releaseTransactionSync,'sync runner reaches the held provider request');const overlapping=await(await call('scheduled-sync',{})).json();assert.equal(overlapping.joined,true,'a second trigger joins the active job');assert.equal(overlapping.job.id,overlapStart.job.id);holdTransactionSync=false;releaseTransactionSync();releaseTransactionSync=null;assert.equal((await waitJob(overlapStart)).status,'succeeded');
  publicData=await stateSnapshot();
  assert.equal((await call('budget',{category:'Travel',amount:-100})).status,400);
  const missingRevisionState=await stateSnapshot();assert.equal((await call('budget',{category:'Travel',amount:49000})).status,409,'a budget edit without an expected revision is rejected');assert.equal((await stateSnapshot()).revision,missingRevisionState.revision,'missing revision rejects the write before changing state');
  const firstTravelBudget=await call('budget',{category:'Travel',amount:50000,revision:publicData.revision});assert.equal(firstTravelBudget.status,200,await firstTravelBudget.text());
  publicData=await stateSnapshot();
  const budgetRevision=publicData.revision;
  assert.equal((await call('budget',{category:'Travel',amount:51000,revision:budgetRevision})).status,200);
  assert.equal((await call('budget',{category:'Travel',amount:52000,revision:budgetRevision})).status,409,'stale budget edits require a reload');
  publicData=await stateSnapshot();
  const currentBudgetMonth=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit'}).formatToParts(new Date());
  const currentMonth=currentBudgetMonth.find(x=>x.type==='year').value+'-'+currentBudgetMonth.find(x=>x.type==='month').value;
  const nextMonthDate=new Date(currentMonth+'-01T12:00:00Z');nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth()+1);const nextMonth=nextMonthDate.toISOString().slice(0,7);
  assert.equal((await call('budget',{category:'Travel',categoryId:'system:travel',amount:25000,mode:'month',month:currentMonth,revision:publicData.revision})).status,200);
  publicData=await stateSnapshot();
  assert.equal(resolveBudget(publicData.budgetTemplates,publicData.monthlyBudgets,'system:travel',currentMonth).amount,25000);
  assert.equal(resolveBudget(publicData.budgetTemplates,publicData.monthlyBudgets,'system:travel',nextMonth).amount,51000);
  assert.equal((await call('budget',{category:'Travel',categoryId:'system:travel',amount:0,mode:'template',month:nextMonth,revision:publicData.revision})).status,200);
  publicData=await stateSnapshot();
  assert.equal(resolveBudget(publicData.budgetTemplates,publicData.monthlyBudgets,'system:travel',currentMonth).amount,25000,'future template edits leave earlier month overrides intact');
  assert.equal(resolveBudget(publicData.budgetTemplates,publicData.monthlyBudgets,'system:travel',nextMonth).amount,0,'zero is an intentional zero-dollar limit');
  assert.equal((await call('budget-reset',{categoryId:'system:travel',month:currentMonth,revision:publicData.revision})).status,200);
  publicData=await stateSnapshot();
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
  const previousMonthDate=new Date(currentMonth+'-01T12:00:00Z');previousMonthDate.setUTCMonth(previousMonthDate.getUTCMonth()-1);const previousMonth=previousMonthDate.toISOString().slice(0,7);
  const categoryBudgetFixture=JSON.parse(env.BUCKET.value),legacyBudgetCategory={id:'custom:legacy-history',name:'Legacy Existing',normalizedName:'legacy existing',kind:'expense',system:false,order:30,archivedAt:null};categoryBudgetFixture.budgetHistoryUnavailableBefore=previousMonth;categoryBudgetFixture.categoryRecords=[...(categoryBudgetFixture.categoryRecords||[]),legacyBudgetCategory];categoryBudgetFixture.customCategories=[...(categoryBudgetFixture.customCategories||[]),legacyBudgetCategory.name];categoryBudgetFixture.budgets={...(categoryBudgetFixture.budgets||{}),'Legacy Existing':31000,Travel:51000};categoryBudgetFixture.monthlyBudgets={...(categoryBudgetFixture.monthlyBudgets||{}),[previousMonth+':system:travel']:27000};env.BUCKET.value=JSON.stringify(categoryBudgetFixture);
  publicData=await stateSnapshot();
  const categoryCreateOperationId=crypto.randomUUID(),categoryCreateInput={name:'Gifts & Giving',amount:10000,revision:publicData.revision,clientOperationId:categoryCreateOperationId};
  const createdCategoryResponse=await call('category-create',categoryCreateInput);
  assert.equal(createdCategoryResponse.status,200);
  const createdCategory=await createdCategoryResponse.json(),categoryId=createdCategory.category.id;
  assert.ok(categoryId);assert.equal(createdCategory.category.kind,'expense');
  const categoryRevisionAfterCreate=(await stateSnapshot()).revision,categoryCreateReplay=await call('category-create',categoryCreateInput);
  assert.equal(categoryCreateReplay.status,200,'a retried create replays its committed result despite the now-stale request revision');
  assert.deepEqual(await categoryCreateReplay.json(),createdCategory,'replayed operation returns the exact original result and stable record ID');
  const operationStatus=await call('operation-status?operationId='+encodeURIComponent(categoryCreateOperationId));assert.equal(operationStatus.status,200);assert.deepEqual((await operationStatus.json()).result,createdCategory,'authenticated operation lookup returns the exact committed result after a reload');
  assert.equal((await call('operation-status?operationId='+encodeURIComponent(categoryCreateOperationId),undefined,'other-owner')).status,403,'operation status does not disclose another owner’s saved result');
  assert.equal((await stateSnapshot()).revision,categoryRevisionAfterCreate,'an idempotent replay does not advance the revision');
  assert.equal((await call('category-create',{...categoryCreateInput,name:'Different payload'})).status,409,'an operation ID cannot be reused for a different payload');
  const publicAfterReplay=await(await call('state')).json();assert.equal(publicAfterReplay.operationResults,undefined,'private operation replay records are excluded from public state');
  publicData=await stateSnapshot();
  const allocationCreate=await call('category-create',{name:'Savings Allocation',itemType:'allocation',amount:5000,revision:publicData.revision});assert.equal(allocationCreate.status,200);
  const allocationCategory=(await allocationCreate.json()).category;
  const allocationPreview=await call('import-preview',{csv:'Date,Merchant,Amount,Category\n2026-10-20,Synthetic allocation row,10.00,Savings Allocation\n',account:'Synthetic allocation CSV',columnMapping:{date:'Date',merchant:'Merchant',amount:'Amount',category:'Category'}});
  assert.deepEqual((await allocationPreview.json()).unknownCategories,['Savings Allocation'],'CSV mapping cannot assign transactions to allocation-only buckets');
  publicData=await stateSnapshot();
  const categoryBudgetState=await(await call('state')).json(),createdBudgetTemplate=categoryBudgetState.budgetTemplates.find(entry=>entry.categoryId===categoryId);
  assert.deepEqual(createdBudgetTemplate,{categoryId,amount:10000,effectiveFrom:currentMonth},'new category budget starts in the current reporting month');
  assert.equal(resolveBudget(categoryBudgetState.budgetTemplates,categoryBudgetState.monthlyBudgets,categoryId,previousMonth).amount,null,'initial budget does not apply before category creation month');
  assert.equal(categoryBudgetState.budgetHistoryUnavailableBefore,previousMonth,'creating a category does not move the global legacy boundary');
  assert.equal(publicData.budgets.Travel,51000,'existing legacy budget remains unchanged');
  assert.equal(publicData.monthlyBudgets[previousMonth+':system:travel'],27000,'existing month override remains unchanged');
  assert.ok(categoryBudgetState.budgetTemplates.some(entry=>entry.categoryId==='custom:legacy-history'&&entry.amount===31000&&entry.effectiveFrom===previousMonth),'legacy budgets are materialized before adding a category budget');
  assert.equal(publicData.budgets['Legacy Existing'],31000,'existing legacy budget remains unchanged when materialized');
  const zeroCategoryResponse=await call('category-create',{name:'Explicit zero category',amount:0,revision:publicData.revision});assert.equal(zeroCategoryResponse.status,200);const zeroCategory=(await zeroCategoryResponse.json()).category;publicData=await stateSnapshot();
  assert.deepEqual(publicData.budgetTemplates.find(entry=>entry.categoryId===zeroCategory.id),{categoryId:zeroCategory.id,amount:0,effectiveFrom:currentMonth},'zero is persisted as an explicit current-month budget');
  const noBudgetResponse=await call('category-create',{name:'No initial budget',revision:publicData.revision});assert.equal(noBudgetResponse.status,200);const noBudgetCategory=(await noBudgetResponse.json()).category;publicData=await stateSnapshot();
  assert.equal(publicData.budgetTemplates.some(entry=>entry.categoryId===noBudgetCategory.id),false,'an omitted initial amount does not invent a budget template');
  assert.equal((await call('category-create',{name:' gifts & giving ',revision:publicData.revision})).status,409);
  const assigned=await call('category',{id:'posted',category:'Gifts & Giving',categoryId,revision:publicData.revision});
  assert.equal(assigned.status,200);
  const afterAssignment=await assigned.json();
  assert.equal((await call('category-update',{id:categoryId,action:'rename',name:'Generosity & Gifts',revision:publicData.revision})).status,409,'stale category writes fail instead of overwriting newer changes');
  publicData=await stateSnapshot();
  const categoryRenamePayload={id:categoryId,action:'rename',name:'Generosity & Gifts',revision:publicData.revision,clientOperationId:'00000000-0000-4000-8000-000000000007'};
  const renamedResponse=await call('category-update',categoryRenamePayload);
  assert.equal(renamedResponse.status,200);
  const renamedResult=await renamedResponse.json();assert.equal(renamedResult.category.id,categoryId,'category identity survives rename');
  publicData=await stateSnapshot();
  const renamedRevision=publicData.revision,renameReplay=await call('category-update',categoryRenamePayload);assert.equal(renameReplay.status,200);assert.deepEqual(await renameReplay.json(),renamedResult,'a category rename retry replays the original result');assert.equal((await stateSnapshot()).revision,renamedRevision,'category rename replay does not advance the revision twice');
  assert.equal((await call('category-update',{...categoryRenamePayload,name:'Different category'})).status,409,'a category operation ID cannot be reused for a different name');assert.equal((await stateSnapshot()).revision,renamedRevision,'a changed category replay leaves the saved revision unchanged');
  publicData=await stateSnapshot();
  assert.equal(publicData.transactions[0].override,'Generosity & Gifts');
  assert.equal(publicData.transactions[0].overrideCategoryId,categoryId);
  assert.deepEqual(publicData.budgetTemplates.find(entry=>entry.categoryId===categoryId),{categoryId,amount:10000,effectiveFrom:currentMonth},'category rename preserves its explicit budget template and start month');
  assert.equal(publicData.budgets['Generosity & Gifts'],10000);
  const beforeArchiveRevision=publicData.revision,archived=await call('category-update',{id:categoryId,action:'archive',revision:beforeArchiveRevision});
  assert.equal(archived.status,200);
  publicData=await stateSnapshot();
  assert.ok(!publicData.categories.includes('Generosity & Gifts'));
  assert.equal(publicData.categoryCatalog.find(c=>c.id===categoryId).archivedAt!==null,true);
  assert.equal(publicData.transactions[0].override,'Generosity & Gifts');
  const archivedTemplate=publicData.budgetTemplates.find(entry=>entry.categoryId===categoryId);
  const repeatArchive=await call('category-update',{id:categoryId,action:'archive',revision:publicData.revision});
  assert.equal(repeatArchive.status,409,'repeating archive is rejected without changing the saved category');
  const staleRestore=await call('category-update',{id:categoryId,action:'restore',revision:beforeArchiveRevision});
  assert.equal(staleRestore.status,409,'restoring with a stale revision cannot overwrite a newer archive');
  publicData=await stateSnapshot();
  const restoredResponse=await call('category-update',{id:categoryId,action:'restore',revision:publicData.revision});
  assert.equal(restoredResponse.status,200);
  const restoredCategory=(await restoredResponse.json()).category;
  assert.equal(restoredCategory.id,categoryId,'restore preserves stable category identity');
  assert.equal(restoredCategory.archivedAt,null,'restore makes the existing category active');
  publicData=await stateSnapshot();
  assert.ok(publicData.categories.includes('Generosity & Gifts'));
  assert.equal(publicData.transactions[0].override,'Generosity & Gifts','restore keeps historical assignments unchanged');
  assert.deepEqual(publicData.budgetTemplates.find(entry=>entry.categoryId===categoryId),archivedTemplate,'restore preserves recurring budget history');
  assert.equal((await call('category-update',{id:categoryId,action:'restore',revision:publicData.revision})).status,409,'repeating restore is rejected without changing the active category');
  const zeroCategoryState=await stateSnapshot(),zeroCategoryArchived=await call('category-update',{id:zeroCategory.id,action:'archive',revision:zeroCategoryState.revision});
  assert.equal(zeroCategoryArchived.status,200);
  publicData=await stateSnapshot();
  const zeroCategoryRestored=await call('category-update',{id:zeroCategory.id,action:'restore',revision:publicData.revision});
  assert.equal(zeroCategoryRestored.status,200,'a second independent custom category can be restored');
  assert.equal((await zeroCategoryRestored.json()).category.id,zeroCategory.id);
  publicData=await stateSnapshot();
  const manualOneResponse=await call('manual-account',{name:'Shared Name',institution:'Local Bank',type:'depository',subtype:'cash',includeInReporting:false,notes:'preserve this note',balance:123456,currency:'USD',asOf:reportingDate,revision:publicData.revision});
  assert.equal(manualOneResponse.status,200);
  assert.equal((await call('manual-account',{name:'Future observation',type:'depository',balance:1000,currency:'USD',asOf:'2099-01-01',revision:(await stateSnapshot()).revision})).status,400,'future-dated manual observations are rejected');
  const manualOne=(await manualOneResponse.json()).account;
  publicData=await stateSnapshot();
  const manualTwoResponse=await call('manual-account',{name:'Shared Name',type:'credit',balance:35000,currency:'USD',asOf:reportingDate,revision:publicData.revision});
  assert.equal(manualTwoResponse.status,200);
  const manualTwo=(await manualTwoResponse.json()).account;
  assert.notEqual(manualOne.id,manualTwo.id,'same-named manual accounts have independent IDs');
  publicData=await stateSnapshot();
  const updatedManual=await call('manual-account',{id:manualOne.id,name:'Renamed Savings',type:'depository',balance:null,currency:'USD',revision:publicData.revision});
  assert.equal(updatedManual.status,200);
  assert.equal((await updatedManual.json()).account.id,manualOne.id,'editing retains the account ID');
  publicData=await stateSnapshot();
  assert.equal(publicData.accounts.find(a=>a.id===manualOne.id).balance,null,'unknown manual balances remain unavailable');
  assert.equal(publicData.accounts.find(a=>a.id===manualOne.id).includeInReporting,false,'omitting the reporting flag cannot include an excluded account');
  assert.equal(publicData.accounts.find(a=>a.id===manualOne.id).subtype,'cash','editing preserves fields the form did not submit');
  assert.equal(publicData.accounts.find(a=>a.id===manualOne.id).institution,'Local Bank');
  assert.equal(publicData.accounts.find(a=>a.id===manualOne.id).notes,'preserve this note');
  assert.equal((await call('manual-account',{id:manualTwo.id,action:'archive',revision:publicData.revision})).status,200);
  assert.ok((await stateSnapshot()).accounts.find(a=>a.id===manualTwo.id).archivedAt);
  publicData=await stateSnapshot();
  const freshCash=(await call('manual-account',{name:'Goal Cash',type:'depository',balance:123456,currency:'USD',asOf:reportingDate,revision:publicData.revision}));assert.equal(freshCash.status,200);
  const cashAccount=(await freshCash.json()).account;publicData=await stateSnapshot();
  const missingGoalRevision=await call('goal',{name:'No revision',target:10000,targetDate:'2027-12-31'});assert.equal(missingGoalRevision.status,409,'goal writes require an optimistic revision');
  const createdGoal=await call('goal',{name:'Emergency fund',target:200000,targetDate:'2027-12-31',priority:1,monthlyContribution:10000,revision:publicData.revision});assert.equal(createdGoal.status,200);
  const goal=(await createdGoal.json()).goal;publicData=await stateSnapshot();
  const staleAllocation=await call('goal-allocations',{goalId:goal.id,allocations:[],revision:publicData.revision-1});assert.equal(staleAllocation.status,409,'stale allocation edits are rejected');
  const allocated=await call('goal-allocations',{goalId:goal.id,allocations:[{accountId:cashAccount.id,amount:100000}],revision:publicData.revision});assert.equal(allocated.status,200);
  const allocationResult=await allocated.json();assert.equal(allocationResult.summary.backed,100000);publicData=await stateSnapshot();
  const secondGoal=(await(await call('goal',{name:'Travel',target:50000,targetDate:'2027-12-31',priority:2,revision:publicData.revision})).json()).goal;publicData=await stateSnapshot();
  const overspend=await call('goal-allocations',{goalId:secondGoal.id,allocations:[{accountId:cashAccount.id,amount:30000}],revision:publicData.revision});assert.equal(overspend.status,409,'cash already reserved by another goal cannot be allocated twice');
  const undone=await call('goal-allocation-undo',{batchId:allocationResult.batchId,revision:publicData.revision});assert.equal(undone.status,200);
  publicData=await stateSnapshot();const reallocated=await call('goal-allocations',{goalId:goal.id,allocations:[{accountId:cashAccount.id,amount:100000}],revision:publicData.revision});assert.equal(reallocated.status,200);
  publicData=await stateSnapshot();assert.equal((await call('goal',{action:'archive',id:goal.id,revision:publicData.revision})).status,200);
  publicData=await stateSnapshot();
  const secondGoalAllocation=await call('goal-allocations',{goalId:secondGoal.id,allocations:[{accountId:cashAccount.id,amount:50000}],revision:publicData.revision});assert.equal(secondGoalAllocation.status,200,'selected savings goal receives verified backing');publicData=await stateSnapshot();
  const linkedPreview=await call('scenario-calculate',{input:goldenScenario,linkedGoalId:secondGoal.id});assert.equal(linkedPreview.status,200);const linkedPreviewResult=(await linkedPreview.json()).result;assert.equal(linkedPreviewResult.eligibleCash,73456);assert.equal(linkedPreviewResult.allocatedGoalFunds,50000);assert.equal(linkedPreviewResult.availableFunds,123456);
  const linkedSaved=await call('scenario',{input:goldenScenario,linkedGoalId:secondGoal.id,revision:publicData.revision});assert.equal(linkedSaved.status,200);const linkedScenario=(await linkedSaved.json()).scenario;assert.deepEqual({eligibleCash:linkedScenario.fundingSnapshot.eligibleCash,allocatedGoalFunds:linkedScenario.fundingSnapshot.allocatedGoalFunds,availableFunds:linkedScenario.result.availableFunds},{eligibleCash:linkedPreviewResult.eligibleCash,allocatedGoalFunds:linkedPreviewResult.allocatedGoalFunds,availableFunds:linkedPreviewResult.availableFunds},'saved and preview funding use the same computed goal backing snapshot');
  publicData=await stateSnapshot();assert.equal((await call('scenario',{id:linkedScenario.id,action:'archive',revision:publicData.revision})).status,200);
  publicData=await stateSnapshot();
  const futureProperty=await call('property',{name:'Future valuation',valuation:10000000,valuationAsOf:nextReportingDate,valuationSource:'owner_estimate',revision:publicData.revision});assert.equal(futureProperty.status,400,'future property valuations are rejected');assert.equal((await stateSnapshot()).revision,publicData.revision,'rejected future valuations do not advance the revision');
  const homeResponse=await call('property',{name:'Test Duplex',address:'Synthetic address',ownershipBps:10000,valuation:10000000,valuationAsOf:reportingDate,valuationSource:'owner_estimate',revision:publicData.revision});assert.equal(homeResponse.status,200);const home=(await homeResponse.json()).property;
  publicData=await stateSnapshot();const beforeManualLiability=publicData.balanceSheet;const liabilityResponse=await call('manual-account',{name:'Mortgage Liability',type:'liability',subtype:'cash',balance:-8000000,currency:'USD',asOf:reportingDate,revision:publicData.revision});assert.equal(liabilityResponse.status,200);const liability=(await liabilityResponse.json()).account;
  publicData=await stateSnapshot();const manualLiability=publicData.balanceSheet.includedAccounts.find(account=>account.id===liability.id);assert.equal(manualLiability.kind,'debts');assert.equal(manualLiability.amount,8000000);assert.equal(publicData.balanceSheet.totals.cash,beforeManualLiability.totals.cash,'manual liability subtype cash does not increase assets');assert.equal(publicData.balanceSheet.totals.liabilities,beforeManualLiability.totals.liabilities+8000000,'manual liability contributes its absolute observed balance to debt');
  const futureStatement=await call('mortgage',{propertyId:home.id,lender:'Future statement',loanType:'fixed',statementBalance:11000000,balanceAsOf:nextReportingDate,revision:publicData.revision});assert.equal(futureStatement.status,400,'future mortgage statement balances are rejected');assert.equal((await stateSnapshot()).revision,publicData.revision,'rejected future statements do not advance the revision');
  const loanResponse=await call('mortgage',{propertyId:home.id,lender:'Local Servicer',loanType:'fixed',linkedAccountId:liability.id,statementBalance:11000000,balanceAsOf:reportingDate,originalPrincipal:12000000,originationDate:'2020-10-25',annualRatePercent:'0',termMonths:120,ownerDebtShareBps:10000,components:{principalInterest:100000,extraPrincipal:0},revision:publicData.revision});assert.equal(loanResponse.status,200);const loan=(await loanResponse.json()).mortgage;
  publicData=await stateSnapshot();const duplicateLien=await call('mortgage',{propertyId:home.id,lender:'Duplicate',loanType:'heloc',linkedAccountId:liability.id,statementBalance:500000,balanceAsOf:reportingDate,ownerDebtShareBps:10000,revision:publicData.revision});assert.equal(duplicateLien.status,400,'one provider liability cannot be linked to multiple mortgage records');
  publicData=await stateSnapshot();const statementUpdate=await call('mortgage',{...loan,statementBalance:10900000,balanceAsOf:reportingDate,revision:publicData.revision});assert.equal(statementUpdate.status,200);publicData=await stateSnapshot();assert.equal(publicData.mortgageSnapshots.filter(snapshot=>snapshot.mortgageId===loan.id).length,2,'observed statement changes append a historical snapshot');
  const projection=await(await call('mortgage-projection',{id:loan.id})).json();assert.equal(projection.projection.base.payment,100000);assert.equal(projection.statementBalance,10900000,'projection does not replace the observed statement balance');assert.equal(projection.projectedBalanceAtStatement,4800000,'statement comparison uses modeled elapsed monthly payments');
  publicData=await stateSnapshot();const secondLien=await call('mortgage',{propertyId:home.id,lender:'Second Lien',loanType:'heloc',statementBalance:500000,balanceAsOf:reportingDate,ownerDebtShareBps:10000,revision:publicData.revision});assert.equal(secondLien.status,200);
  publicData=await stateSnapshot();const homeSummary=publicData.propertySummary.properties.find(property=>property.id===home.id);assert.equal(homeSummary.wholePropertyEquity,-1400000,'API equity includes every linked and manual lien');
  const unsupportedProjection=await(await call('mortgage-projection',{id:(await secondLien.json()).mortgage.id})).json();assert.equal(unsupportedProjection.projection.available,false,'unsupported loan types do not receive fixed-rate schedules');
  publicData=await stateSnapshot();assert.equal((await call('property',{id:home.id,action:'archive',revision:publicData.revision})).status,200);
  publicData=await stateSnapshot();publicData=await stateSnapshot();const firstBalanceSnapshot=await call('balance-snapshot',{revision:publicData.revision});assert.equal(firstBalanceSnapshot.status,200);assert.equal((await firstBalanceSnapshot.json()).existing,false);publicData=await stateSnapshot();assert.equal(publicData.balanceSheetSnapshots.length,1);const repeatedBalanceSnapshot=await call('balance-snapshot',{revision:publicData.revision});assert.equal((await repeatedBalanceSnapshot.json()).existing,true);assert.equal((await stateSnapshot()).balanceSheetSnapshots.length,1,'daily snapshots are idempotent');
  const previewScenario=await call('scenario-calculate',{input:goldenScenario,linkedGoalId:secondGoal.id});assert.equal(previewScenario.status,200);assert.equal((await previewScenario.json()).result.principalAndInterest,202262);
  const incompleteCosts={...goldenScenario,propertyTaxMonthly:null},incompletePreview=await call('scenario-calculate',{input:incompleteCosts});assert.equal(incompletePreview.status,400);assert.match((await incompletePreview.json()).error,/monthly property tax.*enter 0 if none/i);
  publicData=await stateSnapshot();const incompleteSave=await call('scenario',{input:incompleteCosts,revision:publicData.revision});assert.equal(incompleteSave.status,400,'unknown costs cannot be persisted as zero-valued estimates');
  publicData=await stateSnapshot();const savedScenario=await call('scenario',{input:goldenScenario,revision:publicData.revision});assert.equal(savedScenario.status,200);const scenario=(await savedScenario.json()).scenario;assert.equal(scenario.calculationVersion,'purchase-v1');assert.equal(scenario.version,1);
  const legacyScenarioState=JSON.parse(env.BUCKET.value),legacyScenario=legacyScenarioState.scenarios.find(row=>row.id===scenario.id);legacyScenario.inputs.propertyTaxMonthly=null;legacyScenarioState.revision++;env.BUCKET.value=JSON.stringify(legacyScenarioState);env.BUCKET.version++;
  publicData=await stateSnapshot();const blockedGoal=await call('scenario-goal',{scenarioId:scenario.id,revision:publicData.revision});assert.equal(blockedGoal.status,400);assert.match((await blockedGoal.json()).error,/needs input review/i);const blockedBudget=await call('scenario-budget',{scenarioId:scenario.id,revision:publicData.revision});assert.equal(blockedBudget.status,400,'incomplete historical scenarios cannot create budgets from old zero-filled results');
  publicData=await stateSnapshot();const revisedInput={...goldenScenario,name:'Revised synthetic purchase',downPayment:9000000};const revisedScenario=await call('scenario',{id:scenario.id,input:revisedInput,revision:publicData.revision});assert.equal(revisedScenario.status,200);assert.equal((await revisedScenario.json()).scenario.version,2);publicData=await stateSnapshot();assert.equal(publicData.scenarios.find(row=>row.id===scenario.id).versions.length,1,'scenario edits preserve immutable prior quote assumptions');assert.equal(publicData.scenarios.find(row=>row.id===scenario.id).versions[0].inputs.propertyTaxMonthly,null,'repairing an old quote retains its prior unknown input');
  const scenarioGoal=await call('scenario-goal',{scenarioId:scenario.id,revision:publicData.revision});assert.equal(scenarioGoal.status,200);const scenarioGoalId=(await scenarioGoal.json()).goalId;
  publicData=await stateSnapshot();const proposedGoalUpdate=await call('scenario-goal',{scenarioId:scenario.id,action:'update',revision:publicData.revision});assert.equal(proposedGoalUpdate.status,200);publicData=await stateSnapshot();assert.equal(publicData.goals.find(goal=>goal.id===scenarioGoalId).target,9800000,'explicit goal update applies the new scenario target');
  const scenarioBudget=await call('scenario-budget',{scenarioId:scenario.id,revision:publicData.revision});assert.equal(scenarioBudget.status,200);publicData=await stateSnapshot();assert.ok(publicData.budgetTemplates.some(entry=>entry.categoryId==='system:housing'));
  const renamedScenario=await call('scenario',{action:'rename',id:scenario.id,name:'Renamed scenario',revision:publicData.revision});assert.equal(renamedScenario.status,200);publicData=await stateSnapshot();assert.equal(publicData.scenarios.find(row=>row.id===scenario.id).name,'Renamed scenario');
  const duplicatedScenario=await call('scenario',{action:'duplicate',id:scenario.id,revision:publicData.revision});assert.equal(duplicatedScenario.status,200);publicData=await stateSnapshot();assert.equal(publicData.scenarios.filter(row=>!row.archivedAt).length,2);
  const archivedScenario=await call('scenario',{action:'archive',id:(await duplicatedScenario.json()).scenario.id,revision:publicData.revision});assert.equal(archivedScenario.status,200);publicData=await stateSnapshot();assert.ok(publicData.scenarios.find(row=>row.archivedAt).archivedAt);
  const csv={account:'Manual account',csv:'Date,Merchant,Amount,Category\n2026-10-01,Meijer,22.35,Groceries'};
  const previewResponse=await call('import-preview',csv);assert.equal(previewResponse.status,200);const csvPreview=await previewResponse.json();assert.equal(csvPreview.rows,1);assert.deepEqual(csvPreview.headers,['Date','Merchant','Amount','Category']);
  const importPayload={...csv,revision:csvPreview.revision,clientOperationId:'00000000-0000-4000-8000-000000000002'};
  const imported=await call('import',importPayload);assert.equal(imported.status,200);const importResult=await imported.json();assert.equal(importResult.imported,1);assert.ok(importResult.batchId);
  const revisionAfterImport=(await stateSnapshot()).revision;
  const importReplay=await call('import',importPayload);assert.equal(importReplay.status,200);assert.deepEqual(await importReplay.json(),importResult,'a stale CSV import retry replays its exact committed result');assert.equal((await stateSnapshot()).revision,revisionAfterImport,'a CSV import replay does not advance the revision twice');
  const changedImport=await call('import',{...importPayload,csv:importPayload.csv.replace('22.35','23.45')});assert.equal(changedImport.status,409,'the same import operation ID cannot be reused for different CSV content');assert.equal((await stateSnapshot()).revision,revisionAfterImport,'a changed-payload import replay leaves saved state unchanged');
  const repeatedPreview=await(await call('import-preview',csv)).json();assert.equal(repeatedPreview.alreadyImported,true);
  const repeatedImport=await(await call('import',{...csv,revision:repeatedPreview.revision})).json();assert.equal(repeatedImport.skipped,1);
  const overlapCSV={account:'Manual account',csv:'Category,Amount,Merchant,Date\nGroceries,22.35,Meijer,2026-10-01'};
  const overlapPreview=await(await call('import-preview',overlapCSV)).json();assert.equal(overlapPreview.overlapCount,1,'reordered, overlapping imports are surfaced for review');
  assert.equal((await call('import',{...overlapCSV,revision:overlapPreview.revision})).status,409,'overlaps require explicit keep confirmation');
  const overlapCommit=await(await call('import',{...overlapCSV,revision:overlapPreview.revision,confirmOverlaps:true})).json();assert.equal(overlapCommit.imported,1,'a legitimate identical purchase can be retained');
  publicData=await stateSnapshot();const overlapUndo=await call('import-undo',{batchId:overlapCommit.batchId,revision:publicData.revision});assert.equal(overlapUndo.status,200);assert.equal((await overlapUndo.json()).undone,1);
  const duplicatePurchases={account:'Manual account',csv:'Date,Merchant,Amount\n2026-10-02,Cafe,8.00\n2026-10-02,Cafe,8.00'};
  const duplicatePreview=await(await call('import-preview',duplicatePurchases)).json();assert.equal(duplicatePreview.rows,2);assert.equal(duplicatePreview.overlapCount,0);
  const duplicateCommit=await(await call('import',{...duplicatePurchases,revision:duplicatePreview.revision})).json();assert.equal(duplicateCommit.imported,2,'identical legitimate purchases in one source file are preserved');
  publicData=await stateSnapshot();assert.equal((await call('import-undo',{batchId:duplicateCommit.batchId,revision:publicData.revision})).status,200);
  const multiAccountCSV={account:'',csv:'Date,Merchant,Amount,Category,Account\n2026-10-03,Synthetic rewards purchase,9.99,Shopping,Rewards Credit\n2026-10-04,Synthetic checking purchase,2.00,Groceries,Everyday Checking',columnMapping:{account:'Account'}};const multiAccountPreviewResponse=await call('import-preview',multiAccountCSV);assert.equal(multiAccountPreviewResponse.status,200);const multiAccountPreview=await multiAccountPreviewResponse.json();assert.deepEqual(multiAccountPreview.accounts,['Rewards Credit','Everyday Checking']);assert.equal(multiAccountPreview.sample[0].accountName,'Rewards Credit');const multiAccountImport=await(await call('import',{...multiAccountCSV,revision:multiAccountPreview.revision})).json(),multiAccountState=await stateSnapshot();assert.equal(multiAccountImport.imported,2);assert.deepEqual(multiAccountState.transactions.filter(row=>row.importBatchId===multiAccountImport.batchId).map(row=>multiAccountState.accounts.find(account=>account.id===row.accountId)?.name),['Rewards Credit','Everyday Checking'],'row-level Account values are preserved in saved transactions');publicData=await stateSnapshot();assert.equal((await call('import-undo',{batchId:multiAccountImport.batchId,revision:publicData.revision})).status,200);
  const beforeMalformed=(await stateSnapshot()).transactions.length;
  assert.equal((await call('import-preview',{account:'Malformed',csv:'Date,Merchant,Amount\n2026-10-01,Good,1.00\n2026-10-02,Bad,2.00,Extra'})).status,400);
  assert.equal((await stateSnapshot()).transactions.length,beforeMalformed,'malformed batches do not partially commit');
  assert.equal((await call('transactions?from=2026-10-30&to=2026-10-25')).status,400,'inverted date ranges receive a clear validation response');const pageOne=await(await call('transactions?from=2026-10-01&to=2026-10-31&limit=1&page=1')).json(),pageTwo=await(await call('transactions?from=2026-10-01&to=2026-10-31&limit=1&page=2')).json();assert.equal(pageOne.limit,1);assert.ok(pageOne.total>=pageOne.transactions.length+pageTwo.transactions.length);assert.notEqual(pageOne.transactions[0].id,pageTwo.transactions[0].id,'server pages have stable non-overlapping ordering');
  publicData=await stateSnapshot();const csvRow=publicData.transactions.find(t=>t.source==='csv'),bulkResult=await(await call('category-bulk',{ids:['posted',csvRow.id],categoryId:'system:shopping',revision:publicData.revision})).json();
  publicData=await stateSnapshot();assert.equal(publicData.transactions.find(t=>t.id==='posted').override,'Shopping');assert.equal((await call('category',{id:'posted',category:'Health',categoryId:'system:health',revision:publicData.revision})).status,200);
  publicData=await stateSnapshot();assert.equal((await call('category',{id:'posted',category:'Shopping',categoryId:'system:shopping',revision:publicData.revision})).status,200,'a later edit back to the same category is still a distinct operation');
  publicData=await stateSnapshot();const bulkUndo=await(await call('category-bulk-undo',{batchId:bulkResult.batchId,revision:publicData.revision})).json();assert.equal(bulkUndo.undone,1);assert.equal(bulkUndo.skipped,1,'undo does not overwrite a later edit even when it returns to the same category');
  assert.equal((await stateSnapshot()).transactions.find(t=>t.id==='posted').override,'Shopping');
  assert.equal((await call('scheduled-sync',{},null)).status,401);
  assert.equal((await call('scheduled-sync',{},'other-owner')).status,403);
  const scheduled=await call('scheduled-sync',{});assert.equal(scheduled.status,200);assert.equal((await waitJob(await scheduled.json())).status,'succeeded');
  publicData=await stateSnapshot();const removeCalls=()=>seen.filter(call=>call.url.endsWith('/item/remove')).length,removalsBeforeConflict=removeCalls();
  assert.equal((await call('disconnect',{itemId:'item-1'})).status,409,'unlink requires an expected revision');
  assert.equal((await call('disconnect',{itemId:'item-1',revision:publicData.revision-1})).status,409,'stale unlink requests are rejected');
  assert.equal(removeCalls(),removalsBeforeConflict,'revision conflicts are rejected before provider unlink');
  const disconnectResponse=await call('disconnect',{itemId:'item-1',revision:publicData.revision});assert.equal(disconnectResponse.status,200,await disconnectResponse.clone().text());assert.ok(Number.isSafeInteger((await disconnectResponse.json()).revision));
  publicData=await stateSnapshot();
  assert.equal(publicData.items.length,1);assert.equal(publicData.items[0].lifecycle,'unlinked');assert.equal(publicData.transactions.filter(t=>t.itemId==='item-1').length,1);
  assert.ok(publicData.transactions.some(t=>t.itemId==='item-1'&&t.id==='posted'),'unlink retains provider transaction history');
  assert.equal((await call('delete-history',{itemId:'item-1',revision:publicData.revision-1})).status,409,'stale history deletion is rejected');
  const deleteResponse=await call('delete-history',{itemId:'item-1',revision:publicData.revision});assert.equal(deleteResponse.status,200);assert.ok(Number.isSafeInteger((await deleteResponse.json()).revision));
  publicData=await stateSnapshot();
  assert.equal(publicData.items.length,0);assert.equal(publicData.transactions.filter(t=>t.itemId==='item-1').length,0);assert.equal(publicData.transactions.length,1,'deleting a provider connection preserves unrelated CSV history');assert.equal(publicData.accounts.some(a=>a.itemId==='item-1'),false);
  const transactionCallsBeforeInvestment=seen.filter(x=>x.url.endsWith('/transactions/sync')).length;
  const investmentConnected=await call('exchange-token',{public_token:'public-investment',name:'Fidelity',product:'investments',environment:'sandbox'});
  assert.equal(investmentConnected.status,200);assert.equal((await waitJob(await investmentConnected.json())).status,'succeeded');
  assert.equal(seen.filter(x=>x.url.endsWith('/transactions/sync')).length,transactionCallsBeforeInvestment,'investment connections do not use transaction spending sync');
  publicData=await stateSnapshot();
  const investmentAccount=publicData.accounts.find(a=>a.itemId==='item-2');
  assert.ok(investmentAccount);assert.equal(investmentAccount.id,accountRecord(providerAccount,'item-2').id);
  assert.equal(publicData.holdings[0].accountId,investmentAccount.id);
  assert.equal(publicData.holdings[0].value,50000);
  failInvestmentHoldings=true;
  const failedInvestmentStart=await (await call('sync',{})).json();const failedInvestmentSync=await waitJob(failedInvestmentStart);
  assert.equal(failedInvestmentSync.status,'failed');
  publicData=await stateSnapshot();
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
  const localState=await stateSnapshot();
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
const scenarioAsset=await worker.fetch(new Request('https://ledger.test/assets/scenarios.mjs'));assert.equal(scenarioAsset.headers.get('Content-Type'),'text/javascript; charset=utf-8');
const viewStateAsset=await worker.fetch(new Request('https://ledger.test/assets/view-state.mjs'));assert.equal(viewStateAsset.headers.get('Content-Type'),'text/javascript; charset=utf-8');assert.ok((await viewStateAsset.text()).includes('readViewState'));
const browserImportFixtures=new Map([
  ["/assets/budgets.mjs",{budgetMonthKey,calculateBudgetPlan,mapBudgetRolloversByName,resolveBudget,resolveIncomePlan}],
  ["/assets/budget-frequency.mjs",await import('../shared/budget-frequency.mjs')],
  ["/assets/scenarios.mjs",{validateScenarioInput}],
  ["/assets/requests.mjs",{createApiClient,readPendingOperations}],
  ["/assets/dialogs.mjs",await import('../ui/dialogs.mjs')],
  ["/assets/view-state.mjs",{readViewState,writeViewState}]
  ,["/assets/commitments.mjs",{commitmentForecast}]
]);
const browserClient=client.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm,(_statement,names,path)=>{
  const fixture=browserImportFixtures.get(path);assert.ok(fixture,`browser render harness has an explicit fixture for ${path}`);
  return names.split(',').map(name=>name.trim()).filter(Boolean).map(name=>`const ${name} = __browserImports[${JSON.stringify(path)}][${JSON.stringify(name)}];`).join('\n');
});
assert.ok(!/^import\s/m.test(browserClient),'all browser module imports are handled by explicit fixtures');assert.match(browserClient,/Enter 0 if none/);
assert.equal((await worker.fetch(new Request('https://ledger.test/assets/../worker/index.js'),env)).status,404);
const elements=new Map();
const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',className:'',addEventListener(){}});return elements.get(id);};
const queryNodes=new Map();
const querySelectorAll=selector=>{if(selector==='[data-open-demo]'){if(!queryNodes.has(selector))queryNodes.set(selector,[{onclick:null}]);return queryNodes.get(selector);}return [];};
vm.runInNewContext(browserClient,{__browserImports:Object.fromEntries([...browserImportFixtures].map(([path,fixture])=>[path,fixture])),document:{getElementById:element,querySelector:()=>null,querySelectorAll,activeElement:null},window:{scrollTo(){},addEventListener(){}},fetch:async url=>{const path=String(url),state={revision:0,items:[],accounts:[],transactions:[],budgets:{},setup:{configured:false}},requestedMonth=new URL(path,'https://ledger.test').searchParams.get('month')||'2026-10';let value=state;if(path.includes('/api/month-summary?'))value={month:requestedMonth,previousMonth:'2026-09',revision:0,current:{spend:0,income:0,purchases:0,categories:{},weeklySpend:[0,0,0,0,0]},previous:{spend:0,income:0,categories:{},weeklySpend:[0,0,0,0,0]},recent:[],transactionCount:0};else if(path.includes('/api/budget-summary?'))value={month:requestedMonth,revision:0,categories:[],budgetTemplates:[],monthlyBudgets:{},monthlyBudgetSchedules:{},budgetTemplateSchedules:{},budgetItemSettings:{},budgetCategoryIds:{},incomePlanTemplates:[],monthlyIncomePlans:{},monthlyBudgetOutlooks:{},actuals:{income:0,categories:{},activity:{}},budgetRollovers:{}};return{ok:true,json:async()=>value};},budgetMonthKey,calculateBudgetPlan,resolveBudget,resolveIncomePlan,validateScenarioInput,commitmentForecast,URL,URLSearchParams,Date,Intl,Map,Set,JSON,Promise,console,setTimeout,clearTimeout,location:{href:'https://ledger.test/',pathname:'/'},history:{replaceState(){},pushState(){}},sessionStorage:{getItem:()=>null}});
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
  const elements={document:{getElementById:get,querySelector:()=>null,querySelectorAll:select,activeElement:null},window:{scrollTo(){},addEventListener(){}},fetch:async url=>{if(stateOrError instanceof Error)throw stateOrError;const path=String(url);let value=stateOrError;if(path.includes('/api/transactions?'))value={transactions:stateOrError.transactions||[],page:1,limit:50,total:stateOrError.transactions?.length||0};else if(path.includes('/api/month-summary?'))value=stateOrError.monthSummary||{month:'2026-10',previousMonth:'2026-09',revision:stateOrError.revision||0,current:{spend:0,income:0,purchases:0,categories:{},weeklySpend:[0,0,0,0,0]},previous:{spend:0,income:0,categories:{},weeklySpend:[0,0,0,0,0]},recent:(stateOrError.transactions||[]).slice(0,6),transactionCount:stateOrError.transactions?.length||0};else if(path.includes('/api/budget-summary?'))value=stateOrError.budgetSummary||{month:new URL(path,'https://ledger.test').searchParams.get('month'),revision:stateOrError.revision||0,categories:stateOrError.categoryCatalog||[],budgetTemplates:stateOrError.budgetTemplates||[],monthlyBudgets:stateOrError.monthlyBudgets||{},monthlyBudgetSchedules:{},budgetTemplateSchedules:{},budgetItemSettings:stateOrError.budgetItemSettings||{},budgetCategoryIds:stateOrError.budgetCategoryIds||{},incomePlanTemplates:stateOrError.incomePlanTemplates||[],monthlyIncomePlans:stateOrError.monthlyIncomePlans||{},monthlyBudgetOutlooks:stateOrError.monthlyBudgetOutlooks||{},actuals:stateOrError.actuals||{income:0,categories:{},activity:{}},budgetRollovers:stateOrError.budgetRollovers||{}};else if(path.endsWith('/api/scenarios'))value={scenarios:stateOrError.scenarios||[]};return{ok:true,json:async()=>JSON.parse(JSON.stringify(value))};},URL,URLSearchParams,Date,Intl,Map,Set,JSON,Promise,console,setTimeout,clearTimeout,location:{href,pathname:'/'},history:{replaceState(){},pushState(){}},sessionStorage:{getItem:()=>null}};
  elements.__browserImports=Object.fromEntries([...browserImportFixtures].map(([path,fixture])=>[path,fixture]));elements.budgetMonthKey=budgetMonthKey;elements.calculateBudgetPlan=calculateBudgetPlan;elements.resolveBudget=resolveBudget;elements.resolveIncomePlan=resolveIncomePlan;elements.validateScenarioInput=validateScenarioInput;
  vm.runInNewContext(browserClient,elements);
  await new Promise(resolve=>setTimeout(resolve,0));
  return get('app').innerHTML;
}
const pageBase={revision:0,items:[],accounts:[],transactions:[],budgets:{},setup:{configured:false,localOnly:true}};
const balanceHtml=await clientPage('https://ledger.test/',{...pageBase,balanceSheet:{asOf:'2026-10-25T12:00:00.000Z',netWorthLabel:'Known net worth · partial coverage',totals:{cash:10000,investments:25000,property:40000000,liabilities:32005000,assets:40037000,netWorth:8032000},coverage:{includedAccounts:2,accountCount:4,staleAccounts:0,nonUsdAccounts:1,unknownBalanceAccounts:1,missingPropertyValuations:0,incompletePropertyDebt:0,excludedAccounts:2},includedAccounts:[],excludedAccounts:[],properties:[]},balanceSheetSnapshots:[]});assert.ok(balanceHtml.includes('Balance sheet'));assert.ok(balanceHtml.includes('Record today’s snapshot'));assert.ok(balanceHtml.includes('Month over month'));
const mobileTransactionsHtml=await clientPage('https://ledger.test/?page=transactions',{...pageBase,accounts:[{id:'checking',name:'Checking'}],transactions:[{id:'mobile-tx',merchant:'A very long example merchant name',amount:12345,date:'2026-10-25',category:'Dining',currency:'USD'}]});assert.ok(mobileTransactionsHtml.includes('transaction-table'));assert.ok(mobileTransactionsHtml.includes('role="table" aria-label="Transactions"'));assert.ok(mobileTransactionsHtml.includes('transaction-cell-amount'));assert.ok(mobileTransactionsHtml.includes('mobile-cell-label'));assert.ok(mobileTransactionsHtml.includes('Amount'));
const accessibleChartHtml=await clientPage('https://ledger.test/',{...pageBase,transactions:[{id:'chart-tx',merchant:'Example',amount:1000,date:'2026-10-25',category:'Dining',currency:'USD'}],balanceSheet:{asOf:'2026-10-25T12:00:00.000Z',netWorthLabel:'Net worth',totals:{cash:0,investments:0,property:0,liabilities:0,assets:0,netWorth:0},coverage:{includedAccounts:0,accountCount:0,staleAccounts:0,nonUsdAccounts:0,unknownBalanceAccounts:0,missingPropertyValuations:0,incompletePropertyDebt:0,excludedAccounts:0},includedAccounts:[],excludedAccounts:[],properties:[]}});assert.ok(accessibleChartHtml.includes('View weekly spending data'));assert.ok(accessibleChartHtml.includes('Week 1'));
const mobileStyles=await readFile(new URL('../ui/styles.css',import.meta.url),'utf8');assert.match(mobileStyles,/transaction-table tbody tr\{display:grid/);assert.match(mobileStyles,/min-height:44px/);assert.match(mobileStyles,/max-width:600px/);
const manualHtml=await clientPage('https://ledger.test/',{...pageBase,accounts:[{id:'manual-1',name:'Manual Savings',balance:123456,currency:'USD'}]});
assert.ok(manualHtml.includes('Your records are ready'));
assert.ok(manualHtml.includes('Manual Savings'));
assert.ok(manualHtml.includes('$1,234.56'));
const homeHtml=await clientPage('https://ledger.test/?page=home',{...pageBase,properties:[{id:'house',name:'Test Home',ownershipBps:10000}],mortgages:[],propertySummary:{properties:[{id:'house',name:'Test Home',ownershipBps:10000,valuation:30000000,valuationAsOf:'2026-10-25',valuationSource:'appraisal',wholePropertyEquity:30000000,ownerValue:30000000,ownerEquity:30000000,debtComplete:true,mortgages:[]}],propertyCount:1},scenarios:[{id:'scenario-1',name:'Scenario Home',updatedAt:'2026-10-25T12:00:00.000Z',calculationVersion:'purchase-v1',result:{loanPrincipal:10000000,principalAndInterest:50000,ownershipOutflow:100000,remainingCashToClose:1000000,allInAcquisitionFunding:1500000,alreadyPaid:0,eligibleCash:0,allocatedGoalFunds:0,availableFunds:0,fundingShortfall:1500000,cashAfterClosing:-1000000,retainedReserve:500000,dtiHousing:50000,dtiPercent:null,cashFlowSurplus:null,currentHousingReplaced:false,rateSensitivity:[],taxInsuranceSensitivity:[],incomeSensitivity:[],quoteType:'estimate',rateSource:'Manual',rateAsOf:null},inputs:{}}]});assert.ok(homeHtml.includes('Test Home'));assert.ok(homeHtml.includes('Add mortgage / lien'));assert.ok(homeHtml.includes('Scenario Home'));assert.ok(homeHtml.includes('Create down-payment goal'));assert.ok(homeHtml.includes('Saved estimate needs input review'));assert.match(homeHtml,/data-create-scenario-goal="scenario-1" disabled/,'incomplete historical scenarios cannot apply downstream actions');
const goalsHtml=await clientPage('https://ledger.test/?page=goals',{...pageBase,goalSummary:{goals:[{id:'goal-1',name:'Emergency Fund',target:100000,targetDate:'2027-12-31',priority:1,funded:25000,backed:25000,provisional:0,reserved:25000,shortfall:75000,accountShortfall:0,monthlyContribution:5000,projection:{requiredMonthly:6250,scheduledDates:['2026-10-31','2026-11-30'],overdue:false,projectedAtTarget:85000,projectedShortfall:15000}}],accounts:[],unallocatedTotal:50000,provisionalTotal:0},goalAllocations:[]});assert.ok(goalsHtml.includes('Emergency Fund'));assert.ok(goalsHtml.includes('Allocate cash'));assert.ok(goalsHtml.includes('Scheduled month-end contributions: 2026-10-31, 2026-11-30'));
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
const settingsHtml=await clientPage('https://ledger.test/?page=settings',{...pageBase,setup:{configured:false,localOnly:true,syncTimer:{state:'available',enabled:false,active:false},backup:{state:'success',recoveryState:'complete',recoveryStale:false,verification:{bundleChecksums:'verified',databaseIntegrity:'passed',tokens:'decrypted',restoreRehearsal:'not_performed'},lastAttempt:'2026-10-25T12:00:00.000Z',lastSuccess:'2026-10-25T12:00:00.000Z',lastCompleteRecovery:'2026-10-25T12:00:00.000Z',timer:{state:'available',enabled:true,active:true,nextRun:'tomorrow'}}},syncJob:{status:'succeeded',startedAt:'2026-10-25T12:00:00.000Z',completed:2,total:2,failures:[]}});
assert.ok(settingsHtml.includes('Disabled · inactive'));
assert.ok(settingsHtml.includes('Latest sync job'));
assert.ok(settingsHtml.includes('succeeded'));
assert.ok(settingsHtml.includes('Local recovery backups'));
assert.ok(settingsHtml.includes('Verified bundle current; restore rehearsal not performed'));assert.ok(settingsHtml.includes('Database integrity'));assert.ok(settingsHtml.includes('Stored tokens'));assert.ok(settingsHtml.includes('Restore rehearsal'));
assert.ok(settingsHtml.includes('seven recent daily and four weekly'));
const databaseOnlySettingsHtml=await clientPage('https://ledger.test/?page=settings',{...pageBase,setup:{configured:false,localOnly:true,backup:{state:'success',recoveryState:'database_only'}}});
assert.ok(databaseOnlySettingsHtml.includes('Database backup only; recovery pair unavailable'));
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
const monthBudgetHtml=await clientPage('https://ledger.test/?page=budgets&month='+thisMonth,{...pageBase,month:thisMonth,categories:[{id:'system:housing',name:'Housing',kind:'expense',system:true,order:0,archivedAt:null}],categoryCatalog:[{id:'system:housing',name:'Housing',kind:'expense',system:true,order:0,archivedAt:null}],budgetTemplates:[{categoryId:'system:housing',amount:50000,effectiveFrom:thisMonth}],monthlyBudgets:{[thisMonth+':system:housing']:0},budgetHistoryUnavailableBefore:thisMonth,actuals:{income:0,categories:{},activity:{}}});
assert.ok(monthBudgetHtml.includes('data-budget-id="system:housing"'));
assert.ok(monthBudgetHtml.includes('name="amount" type="number"'));
assert.ok(!monthBudgetHtml.includes('value="NaN"'),'missing budget state does not render an invalid numeric amount');
assert.ok(monthBudgetHtml.includes('This month'));
assert.ok(monthBudgetHtml.includes('Projected take-home income after expense plans and savings allocations.'));
const rolloverBudgetHtml=await clientPage('https://ledger.test/?page=budgets&month='+thisMonth,{...pageBase,month:thisMonth,categories:[{id:'system:housing',name:'Housing',kind:'expense',system:true,order:0,archivedAt:null}],categoryCatalog:[{id:'system:housing',name:'Housing',kind:'expense',system:true,order:0,archivedAt:null}],budgetTemplates:[{categoryId:'system:housing',amount:50000,effectiveFrom:thisMonth}],budgetRollovers:{'system:housing':10000},budgetHistoryUnavailableBefore:thisMonth,actuals:{income:0,categories:{},activity:{}}});
assert.ok(rolloverBudgetHtml.includes('$600.00 available · $100.00 carried over'),'Budgets visibly adds the rollover to this month’s plan');
console.log('Finance checks passed: totals, refunds/transfers, currencies, pending replacements, CSV validation/idempotency, authentication, encryption, incremental sync, persistence, disconnect, and client render.');
