import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../dist/server/index.js';
import { calculateBudgetPlan, mapBudgetRolloversByName, resolveBudget, resolveIncomePlan, validMonth } from '../dist/shared/budgets.mjs';
import { createSqliteRepositoryAt } from '../server/sqlite-repository.mjs';

const month='2026-10';
assert.equal(validMonth('1899-12'),false,'reporting months before 1900 are outside the supported range');assert.equal(validMonth('1900-01'),true);assert.equal(validMonth('2200-12'),true);assert.equal(validMonth('2201-01'),false,'reporting months after 2200 are rejected before historical replay');
const buckets=[
  {categoryId:'housing',name:'Housing',plan:{amount:180000,source:'template'},actual:180000},
  {categoryId:'food',name:'Groceries',plan:{amount:60000,source:'template'},actual:65000},
  {categoryId:'transport',name:'Transport',plan:{amount:30000,source:'template'},actual:10000},
  {categoryId:'utilities',name:'Utilities',plan:{amount:20000,source:'template'},actual:0},
  {categoryId:'other',name:'Other',plan:{amount:20000,source:'template'},actual:5000}
];
assert.equal(resolveIncomePlan([{effectiveFrom:'2026-01',amount:500000}],{'2026-10':480000},month).amount,480000);
assert.equal(resolveIncomePlan([{effectiveFrom:'2026-01',amount:500000},{effectiveFrom:'2026-11',amount:520000}],{},month).amount,500000);
assert.equal(resolveIncomePlan([{effectiveFrom:'2026-01',amount:null}],{},month).amount,null,'an explicit null recurring plan remains unknown');
assert.deepEqual(mapBudgetRolloversByName({'system:food':1200,'legacy:old':-300,'missing:id':0},[{id:'system:food',name:'Groceries'}],{'legacy:old':'Old category'}),{Groceries:1200,'Old category':-300,'missing:id':0},'budget presentation maps current, legacy, and unknown rollover IDs without dropping values');
const projection=calculateBudgetPlan({month,incomePlan:{amount:500000},buckets,actualIncome:250000});
assert.deepEqual(projection.rows.map(row=>row.runningBalance),[320000,260000,230000,210000,190000]);
assert.equal(projection.plannedExpenses,310000);assert.equal(projection.actualSpending,260000);
assert.equal(projection.plannedNet,190000);assert.equal(projection.actualNet,-10000);
assert.equal(projection.rows[1].remaining,-5000,'overspent bucket remains visible as a negative value');
const carried=calculateBudgetPlan({month,incomePlan:{amount:500000},buckets:[{categoryId:'fund',plan:{amount:50000},rollover:10000,actual:40000}]});
assert.equal(carried.rows[0].available,60000,'opening carryover is added to this month’s planned amount');
assert.equal(carried.rows[0].remaining,20000,'bucket remaining uses available funds after actual spending');
assert.equal(carried.bucketRemaining,20000,'total bucket remaining includes carried balances');
assert.equal(projection.expectedIncome,500000);assert.equal(projection.expectedSpending,315000);assert.equal(projection.expectedNet,185000);
const allocationPlan=calculateBudgetPlan({month,incomePlan:{amount:100000},buckets:[{categoryId:'food',itemType:'expense',plan:{amount:10000},actual:4000},{categoryId:'savings',itemType:'allocation',plan:{amount:5000},actual:0}]});
assert.equal(allocationPlan.plannedExpenses,10000);assert.equal(allocationPlan.plannedAllocations,5000);assert.equal(allocationPlan.remainingAfterCommitments,85000);assert.equal(allocationPlan.actualSpending,4000);assert.equal(allocationPlan.expectedSpending,10000,'allocation plans do not become expected expenses');assert.equal(allocationPlan.rows[1].expectedRemaining,0);
assert.equal(calculateBudgetPlan({month,incomePlan:{amount:300000},buckets}).plannedNet,-10000);
assert.equal(calculateBudgetPlan({month,incomePlan:{amount:null},buckets}).plannedNet,null,'unknown income does not become zero');
assert.equal(calculateBudgetPlan({month,incomePlan:{amount:0},buckets:[]}).plannedNet,0,'explicit zero income is known');
const incomeOnly=calculateBudgetPlan({month,incomePlan:{amount:500000},buckets:[]});
assert.equal(incomeOnly.complete,false,'income-only planning cannot report a structurally complete budget');
assert.equal(incomeOnly.expensePlanEstablished,false,'income alone does not establish expense coverage');
const onePlan=calculateBudgetPlan({month,incomePlan:{amount:0},buckets:[{categoryId:'rent',plan:{amount:100000},rollover:10000,actual:25000}]});
assert.equal(onePlan.expensePlanEstablished,true);assert.equal(onePlan.complete,true);assert.equal(onePlan.rows[0].remaining,85000,'opening carryover + plan - posted spending');
assert.equal(onePlan.unplannedExpenseActivity,0);
const netZeroUnplanned=calculateBudgetPlan({month,incomePlan:{amount:0},buckets:[{categoryId:'refund-pair',plan:{amount:null},actual:0,hasActivity:true}]});
assert.equal(netZeroUnplanned.complete,false,'gross activity remains visible when a purchase and refund net to zero');
assert.equal(netZeroUnplanned.unplannedExpenseActivity,1);
assert.equal(calculateBudgetPlan({month,incomePlan:{amount:500000},buckets:[{categoryId:'refund-pair',plan:{amount:null},actual:0,hasActivity:true}]}).complete,false,'gross activity keeps a net-zero unplanned purchase/refund category visible as incomplete');
assert.equal(calculateBudgetPlan({month,incomePlan:{amount:500000},buckets,outlook:{income:{expectedTotal:470000},expenses:{utilities:{expectedTotal:0}}}}).expectedNet,175000);
assert.equal(calculateBudgetPlan({month:'2026-09',incomePlan:{amount:500000},buckets,actualIncome:250000,outlook:{income:{expectedTotal:470000}},closed:true}).expectedNet,-10000,'closed-month outlook uses actuals rather than prior estimates');
assert.equal(calculateBudgetPlan({month,incomePlan:{amount:500000},buckets:[...buckets,{categoryId:'unplanned',name:'Unplanned',plan:{amount:null},actual:4000}]}).complete,false);
assert.throws(()=>calculateBudgetPlan({month,incomePlan:{amount:null},buckets:[{categoryId:'overflow',plan:{amount:Number.MAX_SAFE_INTEGER}},{categoryId:'overflow2',plan:{amount:1}}]}),/safe integer-cent range/,'planned expense sums reject overflow beyond safe integer cents');
assert.throws(()=>calculateBudgetPlan({month,incomePlan:{amount:0},buckets:[{categoryId:'overflow',plan:{amount:null},actual:Number.MAX_SAFE_INTEGER},{categoryId:'overflow2',plan:{amount:null},actual:1}]}),/safe integer-cent range/,'actual category sums reject overflow');
assert.equal(resolveBudget([{categoryId:'food',amount:60000,effectiveFrom:'2026-01'}],{'2026-10:food':null},'food',month).amount,null);
assert.throws(()=>calculateBudgetPlan({month:'2026-13'}));

class Bucket {
  value=JSON.stringify({version:1,owner:'synthetic-owner',revision:0,items:[],accounts:[],holdings:[],transactions:[
    {id:'old-paycheck',date:'2026-07-02',amount:-250000,currency:'USD',category:'Income',categoryId:'system:income',pending:false},
    {id:'old-grocery',date:'2026-07-03',amount:100000,currency:'USD',category:'Groceries',categoryId:'system:groceries',pending:false},
    {id:'paycheck-1',date:'2026-10-02',amount:-250000,currency:'USD',category:'Income',categoryId:'system:income',pending:false},
    {id:'sep-grocery',date:'2026-09-04',amount:40000,currency:'USD',category:'Groceries',categoryId:'system:groceries',pending:false},
    {id:'sep-housing',date:'2026-09-04',amount:60000,currency:'USD',category:'Housing',categoryId:'system:housing',pending:false},
    {id:'sep-dining-refund',date:'2026-09-05',amount:-5000,currency:'USD',category:'Dining',categoryId:'system:dining',pending:false},
    {id:'housing-1',date:'2026-10-03',amount:180000,currency:'USD',category:'Housing',categoryId:'system:housing',pending:false},
    {id:'food-1',date:'2026-10-04',amount:65000,currency:'USD',category:'Groceries',categoryId:'system:groceries',pending:false},
    {id:'transport-1',date:'2026-10-05',amount:10000,currency:'USD',category:'Transport',categoryId:'system:transport',pending:false},
    {id:'other-1',date:'2026-10-06',amount:5000,currency:'USD',category:'Other',categoryId:'system:other',pending:false},
    {id:'food-alias-current',date:'2026-10-06',amount:1200,currency:'USD',category:'Food',pending:false},
    {id:'allocation-current',date:'2026-10-06',amount:5000,currency:'USD',category:'Savings Allocation',categoryId:'allocation-test',pending:false},
    {id:'shopping-net-zero-purchase',date:'2026-10-06',amount:2000,currency:'USD',category:'Shopping',categoryId:'system:shopping',pending:false},
    {id:'shopping-net-zero-refund',date:'2026-10-06',amount:-2000,currency:'USD',category:'Shopping',categoryId:'system:shopping',pending:false},
    {id:'cad-1',date:'2026-10-07',amount:70000,currency:'CAD',category:'Shopping',categoryId:'system:shopping',pending:false},
    {id:'pending-1',date:'2026-10-08',amount:5000,currency:'USD',category:'Shopping',categoryId:'system:shopping',pending:true},
    {id:'transfer-1',date:'2026-10-09',amount:20000,currency:'USD',category:'Transfers',categoryId:'system:transfers',pending:false},
    {id:'historical-food-alias',date:'2026-09-06',amount:900,currency:'USD',category:'Food',pending:false},
    {id:'historical-food-group',date:'2026-09-07',amount:7000,currency:'USD',category:'Groceries',categoryId:'system:groceries',pending:false}
  ],budgets:{},customCategories:[],categoryRecords:[
    {id:'food-alias',name:'Food',normalizedName:'food',kind:'expense',order:20},
    {id:'food-group',name:'Food Group',normalizedName:'food group',kind:'expense',order:21},
    {id:'allocation-test',name:'Savings Allocation',normalizedName:'savings allocation',kind:'allocation',order:22}
  ],budgetItemSettings:{'allocation-test':{itemType:'allocation'},'food-group':{itemType:'expense',actualCategoryIds:['system:groceries']}},budgetCategoryIds:{'food-alias':'Food'},budgetTemplates:[
    {categoryId:'system:groceries',effectiveFrom:'2026-09',amount:50000},
    {categoryId:'system:housing',effectiveFrom:'2026-09',amount:50000},
    {categoryId:'system:dining',effectiveFrom:'2026-09',amount:50000},
    {categoryId:'food-alias',effectiveFrom:'2026-09',amount:5000},
    {categoryId:'food-group',effectiveFrom:'2026-09',amount:20000},
    {categoryId:'system:shopping',effectiveFrom:'2026-08',amount:20000},
    {categoryId:'system:shopping',effectiveFrom:'2026-09',amount:null}
  ],monthlyBudgets:{'2026-09:system:groceries':60000},budgetHistoryUnavailableBefore:'2026-08'});
  revision=0;
  async get(){return{etag:String(this.revision),json:async()=>JSON.parse(this.value)};}
  async put(_key,value,{onlyIf}){if(onlyIf.etagMatches!==String(this.revision))return null;this.value=value;this.revision++;return{etag:String(this.revision)};}
}
const bucket=new Bucket(),env={BUCKET:bucket,LOCAL_ONLY:true},request=async(path,input)=>worker.fetch(new Request('https://ledger.test/api/'+path,{method:input===undefined?'GET':'POST',headers:{'oai-authenticated-user-id':'synthetic-owner',...(input?{'Content-Type':'application/json'}:{})},body:input===undefined?undefined:JSON.stringify(input)}),env);
let summary=await(await request('budget-summary?month='+month)).json();
assert.equal((await request('month-summary?month=2201-01')).status,400,'monthly reporting rejects months outside the supported history range before reading summaries');
assert.equal(summary.actuals.income,250000);assert.deepEqual(summary.actuals.categories,{'system:housing':180000,'system:groceries':65000,'system:transport':10000,'system:other':5000,'food-alias':1200,'system:shopping':0});
assert.equal(summary.actuals.activity['allocation-test'],1,'allocation activity remains visible in activity counts');assert.equal(summary.actuals.activity['system:shopping'],2,'net-zero purchase/refund activity remains visible');
assert.equal(summary.budgetRollovers['system:groceries'],13000,'month-specific historical plans contribute to rollover');
assert.equal(summary.budgetRollovers['system:housing'],-10000,'negative bucket balances carry forward');
assert.equal(summary.budgetRollovers['system:dining'],55000,'refunds increase the carried balance');
assert.equal(summary.budgetRollovers['food-alias'],4100,'historical category aliases resolve to their budget bucket');
assert.equal(summary.budgetRollovers['food-group'],-27000,'grouped historical category activity reduces its destination bucket');
assert.equal(summary.budgetRollovers['system:shopping']||0,0,'an unplanned month ends carryover');
assert.equal(summary.actuals.activity['system:shopping'],2,'pending and non-USD activity is excluded from budget activity');
const analyticsDirectory=await mkdtemp(join(tmpdir(),'ledger-budget-analytics-'));
const analyticsRepository=await createSqliteRepositoryAt(join(analyticsDirectory,'ledger.sqlite'));
try{
  const syntheticState=JSON.parse(bucket.value);
  await analyticsRepository.mutate(state=>Object.assign(state,syntheticState));
  const analyticsEnv={REPOSITORY:analyticsRepository,LOCAL_ONLY:true};
  const sqliteSummaryResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/budget-summary?month='+month,{headers:{'oai-authenticated-user-id':'synthetic-owner'}}),analyticsEnv);
  const sqliteSummary=await sqliteSummaryResponse.json();
  assert.equal(sqliteSummaryResponse.status,200,JSON.stringify(sqliteSummary));
  assert.deepEqual(sqliteSummary.actuals,summary.actuals,'SQLite budget actual aggregates match the full-state implementation');
  assert.deepEqual(sqliteSummary.budgetRollovers,summary.budgetRollovers,'SQLite historical aggregates match full-state rollover calculations');
}finally{await analyticsRepository.close();await rm(analyticsDirectory,{recursive:true,force:true});}
let revision=summary.revision;
async function saveAndReplay(path,input,changed){
  let resultResponse=await request(path,input),result=await resultResponse.json();assert.equal(resultResponse.status,200,JSON.stringify(result));
  const replayResponse=await request(path,input),replay=await replayResponse.json();assert.equal(replayResponse.status,200,JSON.stringify(replay));assert.deepEqual(replay,result,path+' returns the original committed response after a stale retry');
  const savedRevision=JSON.parse(bucket.value).revision;assert.equal(savedRevision,result.revision,path+' replay does not advance the revision twice');
  const conflictResponse=await request(path,{...input,...changed}),conflict=await conflictResponse.json();assert.equal(conflictResponse.status,409,JSON.stringify(conflict));assert.equal(JSON.parse(bucket.value).revision,savedRevision,path+' changed-payload conflict does not mutate state');
  revision=result.revision;return result;
}
let response=await request('income-plan',{month,mode:'template',amount:500000,revision});assert.equal(response.status,200);revision=(await response.json()).revision;
for(const [categoryId,category,amount] of [['system:housing','Housing',180000],['system:groceries','Groceries',60000],['system:transport','Transport',30000],['system:utilities','Utilities',20000],['system:other','Other',20000]]){
  response=await request('budget',{category,categoryId,amount,mode:'template',month,revision});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));revision=result.revision;
}
summary=await(await request('budget-summary?month='+month)).json();
assert.equal(resolveIncomePlan(summary.incomePlanTemplates,summary.monthlyIncomePlans,month).amount,500000);
assert.equal(resolveBudget(summary.budgetTemplates,summary.monthlyBudgets,'system:groceries',month).amount,60000);
assert.equal((await request('income-plan',{month,mode:'month',amount:480000,revision:revision-1})).status,409,'stale income-plan writes cannot replace a newer plan');
await saveAndReplay('budget',{categoryId:'system:transport',amount:29000,mode:'month',month,revision,clientOperationId:'00000000-0000-4000-8000-000000000101'},{amount:28000});
await saveAndReplay('budget-reset',{categoryId:'system:transport',month,revision,clientOperationId:'00000000-0000-4000-8000-000000000102'},{month:'2026-11'});
await saveAndReplay('income-plan',{month,mode:'month',amount:480000,revision,clientOperationId:'00000000-0000-4000-8000-000000000103'},{amount:470000});
await saveAndReplay('income-plan-reset',{month,revision,clientOperationId:'00000000-0000-4000-8000-000000000104'},{month:'2026-11'});
const outlookResult=await saveAndReplay('budget-outlook',{month,revision,changes:{actualIncome:250000,income:220000,expenses:{'system:utilities':0}},clientOperationId:'00000000-0000-4000-8000-000000000105'},{changes:{actualIncome:250000,income:210000,expenses:{'system:utilities':0}}});
const saved=JSON.parse(bucket.value);assert.equal(saved.monthlyBudgetOutlooks[month].income.expectedTotal,470000);
assert.equal(saved.monthlyBudgetOutlooks[month].expenses['system:utilities'].expectedTotal,0);
assert.ok(saved.incomePlanTemplates&&saved.budgetTemplates&&saved.monthlyBudgetOutlooks,'plan and outlook persist together in repository state');
assert.equal((await request('income-plan',{month,mode:'month',amount:-1,revision})).status,400);
assert.equal((await request('budget-outlook',{month,revision,changes:{actualIncome:249999,income:1,expenses:{}}})).status,409,'a changed actual basis requires refreshing before saving expectations');
assert.ok(saved.budgetChangeHistory.some(row=>row.action==='budget-outlook'&&row.operationId==='00000000-0000-4000-8000-000000000105'),'JSON storage commits the outlook audit row with its operation ID');
const publicState=await(await request('state')).json();assert.equal(publicState.budgetChangeHistory,undefined,'budget history is read through its bounded history endpoint rather than copied into the public state snapshot');
const historyResponse=await request('budget-history?month='+month+'&limit=200'),historyEntries=(await historyResponse.json()).entries;assert.ok(historyEntries.length>=8);const outlookHistory=historyEntries.find(row=>row.operationId==='00000000-0000-4000-8000-000000000105');assert.ok(outlookHistory);
let latestState=JSON.parse(bucket.value);const reverted=await request('budget-history-revert',{historyId:outlookHistory.id,revision:latestState.revision,clientOperationId:'00000000-0000-4000-8000-000000000106'});assert.equal(reverted.status,200);assert.equal(JSON.parse(bucket.value).monthlyBudgetOutlooks[month],undefined,'reverting an outlook to unknown removes the saved adjustment but retains both audit entries');assert.ok(JSON.parse(bucket.value).budgetChangeHistory.some(row=>row.action==='budget-history-revert'&&row.before!==null&&row.after===null));
latestState=JSON.parse(bucket.value);let futureSave=await request('budget',{categoryId:'system:utilities',amount:36000,mode:'template',month:'2027-01',revision:latestState.revision,clientOperationId:'00000000-0000-4000-8000-000000000107'});assert.equal(futureSave.status,200);latestState=JSON.parse(bucket.value);futureSave=await request('budget',{categoryId:'system:utilities',amount:42000,mode:'month',month:'2027-03',revision:latestState.revision,clientOperationId:'00000000-0000-4000-8000-000000000108'});assert.equal(futureSave.status,200);
const stopPreview=await(await request('budget-stop-preview?categoryId=system%3Autilities&month=2026-11')).json();assert.equal(stopPreview.laterTemplates.length,1);assert.equal(stopPreview.laterOverrides.length,1);latestState=JSON.parse(bucket.value);const stopResult=await request('budget-stop-future',{categoryId:'system:utilities',month:'2026-11',confirmFuture:true,revision:latestState.revision,clientOperationId:'00000000-0000-4000-8000-000000000109'});assert.equal(stopResult.status,200);latestState=JSON.parse(bucket.value);assert.equal(latestState.budgetTemplates.find(row=>row.categoryId==='system:utilities'&&row.effectiveFrom==='2026-10').amount,20000);assert.equal(latestState.budgetTemplates.find(row=>row.categoryId==='system:utilities'&&row.effectiveFrom==='2026-11').amount,0);assert.equal(latestState.monthlyBudgets['2027-03:system:utilities'],0);assert.ok(latestState.budgetChangeHistory.some(row=>row.action==='budget-stop-future'&&row.operationId==='00000000-0000-4000-8000-000000000109'));
console.log('Budget plan, actual, outlook, replay, and local-only API checks passed.');
