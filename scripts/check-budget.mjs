import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
import { calculateBudgetPlan, resolveBudget, resolveIncomePlan } from '../dist/shared/budgets.mjs';

const month='2026-10';
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
const projection=calculateBudgetPlan({month,incomePlan:{amount:500000},buckets,actualIncome:250000});
assert.deepEqual(projection.rows.map(row=>row.runningBalance),[320000,260000,230000,210000,190000]);
assert.equal(projection.plannedExpenses,310000);assert.equal(projection.actualSpending,260000);
assert.equal(projection.plannedNet,190000);assert.equal(projection.actualNet,-10000);
assert.equal(projection.rows[1].remaining,-5000,'overspent bucket remains visible as a negative value');
assert.equal(projection.expectedIncome,500000);assert.equal(projection.expectedSpending,315000);assert.equal(projection.expectedNet,185000);
assert.equal(calculateBudgetPlan({month,incomePlan:{amount:300000},buckets}).plannedNet,-10000);
assert.equal(calculateBudgetPlan({month,incomePlan:{amount:null},buckets}).plannedNet,null,'unknown income does not become zero');
assert.equal(calculateBudgetPlan({month,incomePlan:{amount:0},buckets:[]}).plannedNet,0,'explicit zero income is known');
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
    {id:'paycheck-1',date:'2026-10-02',amount:-250000,currency:'USD',category:'Income',categoryId:'system:income',pending:false},
    {id:'housing-1',date:'2026-10-03',amount:180000,currency:'USD',category:'Housing',categoryId:'system:housing',pending:false},
    {id:'food-1',date:'2026-10-04',amount:65000,currency:'USD',category:'Groceries',categoryId:'system:groceries',pending:false},
    {id:'transport-1',date:'2026-10-05',amount:10000,currency:'USD',category:'Transport',categoryId:'system:transport',pending:false},
    {id:'other-1',date:'2026-10-06',amount:5000,currency:'USD',category:'Other',categoryId:'system:other',pending:false},
    {id:'cad-1',date:'2026-10-07',amount:70000,currency:'CAD',category:'Shopping',categoryId:'system:shopping',pending:false},
    {id:'pending-1',date:'2026-10-08',amount:5000,currency:'USD',category:'Shopping',categoryId:'system:shopping',pending:true},
    {id:'transfer-1',date:'2026-10-09',amount:20000,currency:'USD',category:'Transfers',categoryId:'system:transfers',pending:false}
  ],budgets:{},customCategories:[],categoryRecords:[],budgetTemplates:[],monthlyBudgets:{}});
  revision=0;
  async get(){return{etag:String(this.revision),json:async()=>JSON.parse(this.value)};}
  async put(_key,value,{onlyIf}){if(onlyIf.etagMatches!==String(this.revision))return null;this.value=value;this.revision++;return{etag:String(this.revision)};}
}
const bucket=new Bucket(),env={BUCKET:bucket,LOCAL_ONLY:true},request=async(path,input)=>worker.fetch(new Request('https://ledger.test/api/'+path,{method:input===undefined?'GET':'POST',headers:{'oai-authenticated-user-id':'synthetic-owner',...(input?{'Content-Type':'application/json'}:{})},body:input===undefined?undefined:JSON.stringify(input)}),env);
let summary=await(await request('budget-summary?month='+month)).json();
assert.equal(summary.actuals.income,250000);assert.deepEqual(summary.actuals.categories,{'system:housing':180000,'system:groceries':65000,'system:transport':10000,'system:other':5000});
assert.equal(summary.actuals.activity['system:shopping'],undefined,'pending and non-USD activity is excluded from budget activity');
let revision=summary.revision;
let response=await request('income-plan',{month,mode:'template',amount:500000,revision});assert.equal(response.status,200);revision=(await response.json()).revision;
for(const [categoryId,category,amount] of [['system:housing','Housing',180000],['system:groceries','Groceries',60000],['system:transport','Transport',30000],['system:utilities','Utilities',20000],['system:other','Other',20000]]){
  response=await request('budget',{category,categoryId,amount,mode:'template',month,revision});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));revision=result.revision;
}
summary=await(await request('budget-summary?month='+month)).json();
assert.equal(resolveIncomePlan(summary.incomePlanTemplates,summary.monthlyIncomePlans,month).amount,500000);
assert.equal(resolveBudget(summary.budgetTemplates,summary.monthlyBudgets,'system:groceries',month).amount,60000);
assert.equal((await request('income-plan',{month,mode:'month',amount:480000,revision:revision-1})).status,409,'stale income-plan writes cannot replace a newer plan');
response=await request('budget-outlook',{month,revision,changes:{actualIncome:250000,income:220000,expenses:{'system:utilities':0}}});const outlookResult=await response.json();assert.equal(response.status,200,JSON.stringify(outlookResult));revision=outlookResult.revision;
const saved=JSON.parse(bucket.value);assert.equal(saved.monthlyBudgetOutlooks[month].income.expectedTotal,470000);
assert.equal(saved.monthlyBudgetOutlooks[month].expenses['system:utilities'].expectedTotal,0);
assert.ok(saved.incomePlanTemplates&&saved.budgetTemplates&&saved.monthlyBudgetOutlooks,'plan and outlook persist together in repository state');
assert.equal((await request('income-plan',{month,mode:'month',amount:-1,revision})).status,400);
assert.equal((await request('budget-outlook',{month,revision,changes:{actualIncome:249999,income:1,expenses:{}}})).status,409,'a changed actual basis requires refreshing before saving expectations');
console.log('Budget plan, actual, outlook and local-only API checks passed.');
