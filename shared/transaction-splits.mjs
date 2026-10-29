export function validateTransactionSplit(transaction, allocations, categories) {
  if (!transaction || transaction.pending || !Number.isSafeInteger(transaction.amount)) throw new TypeError('Only posted transactions with known integer cents can be split.');
  if (!Array.isArray(allocations) || allocations.length < 2 || allocations.length > 50) throw new TypeError('A split needs between 2 and 50 category allocations.');
  const allowed=new Set(categories.map(category=>category.id));let total=0;const ids=new Set();
  for(const row of allocations){
    if(!row||typeof row.categoryId!=='string'||!allowed.has(row.categoryId)||!Number.isSafeInteger(row.amount)||ids.has(row.categoryId))throw new TypeError('Choose unique valid categories and integer-cent amounts for every split line.');
    if(transaction.amount!==0&&row.amount!==0&&Math.sign(row.amount)!==Math.sign(transaction.amount))throw new TypeError('Split lines must keep the parent transaction sign; refunds remain negative.');
    ids.add(row.categoryId);total+=row.amount;if(!Number.isSafeInteger(total))throw new TypeError('Split amount exceeds the safe integer-cent range.');
  }
  if(total!==transaction.amount)throw new TypeError('Split allocations must sum exactly to the parent transaction amount.');
  return allocations.map((row,index)=>({id:row.id||`allocation-${index+1}`,categoryId:row.categoryId,amount:row.amount}));
}

export function transactionReportingRows(state, transaction) {
  const split=(state.transactionSplits||[]).find(row=>row.transactionId===transaction.id);
  if(!split)return[transaction];
  if(split.needsReview||split.parentAmount!==transaction.amount||split.parentDate!==transaction.date||split.parentAccountId!==transaction.accountId||split.parentCurrency!==transaction.currency)return[transaction];
  const categories=new Map((state.categoryRecords||[]).map(row=>[row.id,row]));
  for(const name of CATEGORIES){const id='system:'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-');categories.set(id,{id,name,kind:name==='Income'?'income':name==='Transfers'?'transfer':'expense'});}
  return split.allocations.map(allocation=>{const category=categories.get(allocation.categoryId);return{...transaction,amount:allocation.amount,category:category?.name||transaction.category,categoryId:allocation.categoryId,override:undefined,overrideCategoryId:undefined,splitAllocationId:allocation.id,parentTransactionId:transaction.id};});
}

export function applyTransactionSplitsToRows(state, transactions) { return transactions.flatMap(row=>transactionReportingRows(state,row)); }
import { CATEGORIES } from './categories.mjs';
