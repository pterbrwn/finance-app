import { monthlyBudgetAmount, validateBudgetSchedule } from './budget-frequency.mjs';

const validMonth=value=>typeof value==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const validProfile=value=>['peter','maddie','joint'].includes(value);

export function normalizeBudgetRecord(record){
  if(!record||typeof record.categoryId!=='string'||!record.categoryId||record.categoryId.length>160||!validMonth(record.effectiveMonth)||!['recurring','month'].includes(record.scope))throw new TypeError('Invalid complete budget record.');
  const monthlyCents=record.monthlyCents??null,sourceCents=record.sourceCents??null;
  if(monthlyCents!==null&&(!Number.isSafeInteger(monthlyCents)||monthlyCents<0)||sourceCents!==null&&(!Number.isSafeInteger(sourceCents)||sourceCents<0))throw new TypeError('Budget record amounts must be non-negative integer cents or unknown.');
  const schedule=validateBudgetSchedule({frequency:record.frequency||'monthly',dueMonth:record.dueMonth??null});
  if(sourceCents===null?monthlyCents!==null:monthlyBudgetAmount(sourceCents,schedule.frequency)!==monthlyCents)throw new TypeError('Budget record source and monthly amounts are inconsistent.');
  const profileId=record.profileId??'peter';if(!validProfile(profileId))throw new TypeError('Invalid budget profile.');
  return{categoryId:record.categoryId,effectiveMonth:record.effectiveMonth,scope:record.scope,profileId,monthlyCents,sourceCents,frequency:schedule.frequency,dueMonth:schedule.dueMonth};
}

export function budgetRecordsFromProjections({budgetTemplates=[],monthlyBudgets={},budgetTemplateSchedules={},monthlyBudgetSchedules={}}={}){
  const records=[],keys=new Set();
  const add=record=>{const value=normalizeBudgetRecord(record),key=`${value.profileId}:${value.categoryId}:${value.effectiveMonth}:${value.scope}`;if(keys.has(key))throw new TypeError('Duplicate complete budget record.');keys.add(key);records.push(value);};
  for(const row of budgetTemplates){const key=`${row.categoryId}:${row.effectiveFrom}`,schedule=budgetTemplateSchedules[key]||row;add({categoryId:row.categoryId,effectiveMonth:row.effectiveFrom,scope:'recurring',monthlyCents:row.amount,sourceCents:schedule.sourceAmount??row.amount,frequency:schedule.frequency||'monthly',dueMonth:schedule.dueMonth??null});}
  for(const[key,amount]of Object.entries(monthlyBudgets)){const month=key.slice(0,7),categoryId=key.slice(8),schedule=monthlyBudgetSchedules[key]||{};add({categoryId,effectiveMonth:month,scope:'month',monthlyCents:amount,sourceCents:schedule.sourceAmount??amount,frequency:schedule.frequency||'monthly',dueMonth:schedule.dueMonth??null});}
  return records;
}

export function budgetRecordProjections(records=[]){
  const valid=records.map(normalizeBudgetRecord);
  const templates=valid.filter(row=>row.scope==='recurring'&&row.profileId==='peter').map(row=>({categoryId:row.categoryId,effectiveFrom:row.effectiveMonth,amount:row.monthlyCents}));
  const monthlyBudgets=Object.fromEntries(valid.filter(row=>row.scope==='month'&&row.profileId==='peter').map(row=>[`${row.effectiveMonth}:${row.categoryId}`,row.monthlyCents]));
  const budgetTemplateSchedules=Object.fromEntries(valid.filter(row=>row.scope==='recurring'&&row.profileId==='peter').map(row=>[`${row.categoryId}:${row.effectiveMonth}`,{frequency:row.frequency,dueMonth:row.dueMonth,sourceAmount:row.sourceCents}]));
  const monthlyBudgetSchedules=Object.fromEntries(valid.filter(row=>row.scope==='month'&&row.profileId==='peter').map(row=>[`${row.effectiveMonth}:${row.categoryId}`,{frequency:row.frequency,dueMonth:row.dueMonth,sourceAmount:row.sourceCents}]));
  return{budgetRecords:valid,budgetTemplates:templates,monthlyBudgets,budgetTemplateSchedules,monthlyBudgetSchedules};
}

export function budgetRecordProjectionsForProfile(records=[],profileId){
  if(!validProfile(profileId))throw new TypeError('Invalid budget profile.');
  const selected=records.map(normalizeBudgetRecord).filter(row=>row.profileId===profileId);
  return{...budgetRecordProjections(selected.map(row=>({...row,profileId:'peter'}))),budgetRecords:selected};
}
