import assert from 'node:assert/strict';
import { calculateStatementReconciliation, statementTransactionFingerprint } from '../shared/statement-reconciliation.mjs';
const checking=calculateStatementReconciliation({account:{id:'checking',type:'depository',currency:'USD'},opening:{date:'2026-09-30',balance:100000},closing:{date:'2026-10-31',balance:120000},historyComplete:true,transactions:[
{id:'income',accountId:'checking',date:'2026-10-01',amount:-50000,currency:'USD'},
{id:'purchase',accountId:'checking',date:'2026-10-10',amount:20000,currency:'USD'},
{id:'transfer',accountId:'checking',date:'2026-10-20',amount:10000,currency:'USD'},
{id:'pending',accountId:'checking',date:'2026-10-31',amount:99999,currency:'USD',pending:true}
]});
assert.equal(checking.expectedClosing,120000);assert.equal(checking.discrepancy,0);assert.equal(checking.pendingCount,1);
const credit=calculateStatementReconciliation({account:{id:'card',type:'credit',currency:'USD'},opening:{date:'2026-09-30',balance:30000},closing:{date:'2026-10-31',balance:23000},historyComplete:true,transactions:[{id:'purchase',accountId:'card',date:'2026-10-02',amount:5000,currency:'USD'},{id:'payment',accountId:'card',date:'2026-10-12',amount:-10000,currency:'USD'},{id:'refund',accountId:'card',date:'2026-10-14',amount:-2000,currency:'USD'}]});
assert.equal(credit.expectedClosing,23000);assert.equal(credit.discrepancy,0);
assert.equal(calculateStatementReconciliation({account:{id:'investment',type:'investment',currency:'USD'}}).supported,false);
assert.equal(calculateStatementReconciliation({account:{id:'checking',type:'depository',currency:'USD'},opening:{date:'2026-09-30',balance:0},closing:{date:'2026-10-31',balance:0},transactions:[],historyComplete:false}).complete,false);
assert.equal(calculateStatementReconciliation({account:{id:'checking',type:'depository',currency:'USD'},opening:{date:'2026-10-01',balance:0},closing:{date:'2026-10-01',balance:0}}).complete,false,'inconsistent dates are incomplete');
const original=[{id:'tx',accountId:'checking',date:'2026-10-10',amount:1,currency:'USD'}];assert.notEqual(statementTransactionFingerprint(original,'checking','2026-09-30','2026-10-31'),statementTransactionFingerprint([{...original[0],amount:2}],'checking','2026-09-30','2026-10-31'));
assert.equal(statementTransactionFingerprint([...original,{id:'outside',accountId:'checking',date:'2026-11-01',amount:100,currency:'USD'}],'checking','2026-09-30','2026-10-31'),statementTransactionFingerprint(original,'checking','2026-09-30','2026-10-31'),'outside-period edits do not invalidate period coverage');
console.log('Statement reconciliation math, signs, boundaries, pending exclusion, coverage, and review invalidation checks passed.');

import { webcrypto } from 'node:crypto';
globalThis.crypto ||= webcrypto;
const { default: worker }=await import('../dist/server/index.js');
let ownerState={version:1,owner:'synthetic-owner',revision:4,items:[],accounts:[{id:'checking',type:'depository',currency:'USD'}],transactions:[{id:'t1',accountId:'checking',date:'2026-10-05',amount:1000,currency:'USD'}],statementReconciliations:[]};
const operations=new Map();const repository={schemaVersion:7,async read(){return{state:structuredClone(ownerState)};},async readIdentity(){return{owner:ownerState.owner,version:ownerState.version};},async readOperationResult(id){return operations.get(id)||null;},async mutateWithOperation(operation,update){if(operations.has(operation.id))return{state:null,result:operations.get(operation.id).response,replayed:true};const draft=structuredClone(ownerState),record=await update(draft);ownerState=draft;operations.set(operation.id,record);return{state:structuredClone(ownerState),result:record.response,replayed:false};}};
const call=async(path,{method='GET',payload}={})=>worker.fetch(new Request(`https://ledger.test/api/${path}`,{method,headers:{'oai-authenticated-user-id':'synthetic-owner',...(payload?{'content-type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})}),{REPOSITORY:repository,LOCAL_ONLY:true,logError:row=>{console.error('synthetic API error',row);}});
const response=await call('statement-reconciliation',{method:'POST',payload:{accountId:'checking',opening:{date:'2026-09-30',balance:5000},closing:{date:'2026-10-31',balance:4000},historyComplete:true,revision:4,clientOperationId:'11111111-1111-4111-8111-111111111111'}});
if(response.status!==200)throw new Error(`Statement API returned ${response.status}: ${await response.text()}`);const saved=await response.json();assert.equal(saved.review.result.expectedClosing,4000);
const status=await (await call('statement-reconciliation?accountId=checking')).json();assert.equal(status.status,'current');
ownerState.transactions[0].amount=2000;const stale=await (await call('statement-reconciliation?accountId=checking')).json();assert.equal(stale.status,'needs-review','API status notices an in-period ledger edit');
const unauthorized=await worker.fetch(new Request('https://ledger.test/api/statement-reconciliation?accountId=checking',{headers:{'oai-authenticated-user-id':'intruder'}}),{REPOSITORY:{...repository,async readIdentity(){return{owner:'another-owner'};}},LOCAL_ONLY:true});assert.equal(unauthorized.status,403,'statement reviews enforce owner isolation');
console.log('Statement reconciliation API persistence, authenticated owner boundary, and stale review status passed.');
