import { isFreshObservation } from './dates.mjs';

const addSafeCents=(total,amount,label)=>{
  const result=total+amount;
  if(!Number.isSafeInteger(total)||!Number.isSafeInteger(amount)||!Number.isSafeInteger(result))throw new RangeError(`${label} exceeds the safe integer-cent range.`);
  return result;
};

export function summarizeBalanceSheet(accounts=[],items=[],propertySummary={properties:[]},asOf=new Date()){
  const now=asOf instanceof Date?asOf:new Date(typeof asOf==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(asOf)?asOf+'T12:00:00Z':asOf),itemById=new Map(items.map(item=>[item.id,item])),properties=propertySummary.properties||[];
  const linkedLiabilityIds=new Set(properties.flatMap(property=>property.mortgages||[]).map(mortgage=>mortgage.linkedAccountId).filter(Boolean));
  const totals={cash:0,investments:0,otherAssets:0,property:0,debts:0},includedAccounts=[],excludedAccounts=[];
  const coverage={accountCount:accounts.length,includedAccounts:0,unknownBalanceAccounts:0,nonUsdAccounts:0,staleAccounts:0,excludedAccounts:0,propertyCount:properties.length,missingPropertyValuations:0,stalePropertyValuations:0,incompletePropertyDebt:0,missingMortgageBalances:0,staleMortgageBalances:0};
  for(const account of accounts){
    let reason=null;if(account.archivedAt)reason='archived';else if(account.includeInReporting===false)reason='excluded from reports';else if(linkedLiabilityIds.has(account.id))reason='included with linked mortgage';else if(account.currency!=='USD')reason='non-USD balance';else if(!Number.isSafeInteger(account.balance))reason='unknown balance';
    const type=String(account.type||'').toLowerCase(),subtype=String(account.subtype||'').toLowerCase(),debt=['credit','loan','liability','mortgage'].includes(type),assetLike=['asset','other'].includes(type);
    const kind=debt?'debts':type==='depository'||assetLike&&subtype==='cash'?'cash':['investment','retirement','hsa'].includes(type)||assetLike&&['401k','ira','brokerage','hsa'].includes(subtype)?'investments':assetLike?'otherAssets':null;
    if(!reason&&!kind)reason='unsupported account type';
    if(reason){coverage.excludedAccounts++;if(reason==='non-USD balance')coverage.nonUsdAccounts++;if(reason==='unknown balance')coverage.unknownBalanceAccounts++;excludedAccounts.push({id:account.id,name:account.name,reason});continue;}
    const item=account.itemId?itemById.get(account.itemId):null,observedAt=account.manual?account.balanceAsOf:account.balanceAsOf||item?.lastSuccess||item?.lastSync||null,stale=!isFreshObservation(observedAt,now,1);
    if(stale)coverage.staleAccounts++;
    const amount=kind==='debts'?Math.abs(account.balance):account.balance;totals[kind]=addSafeCents(totals[kind],amount,'Balance sheet account total');coverage.includedAccounts++;
    includedAccounts.push({id:account.id,name:account.name,kind,amount,currency:'USD',source:account.manual?'Manual':'Connected',observedAt,stale});
  }
  const propertyRows=properties.map(property=>{
    if(!Number.isSafeInteger(property.ownerValue)){coverage.missingPropertyValuations++;}else totals.property=addSafeCents(totals.property,property.ownerValue,'Balance sheet property total');
    if(property.valuationAsOf&&!isFreshObservation(property.valuationAsOf,now,365))coverage.stalePropertyValuations++;
    if(!property.debtComplete)coverage.incompletePropertyDebt++;
    const mortgages=(property.mortgages||[]).map(mortgage=>{const linked=mortgage.linkedAccount,fresh=isFreshObservation(mortgage.balanceAsOf,now,45),fallbackEligible=linked?.currency==='USD'&&!linked.archivedAt&&linked.includeInReporting!==false&&Number.isSafeInteger(linked.balance)&&fresh,balance=mortgage.statementBalance??(fallbackEligible?Math.abs(linked.balance):null),stale=!fresh;if(!Number.isSafeInteger(balance))coverage.missingMortgageBalances++;if(stale)coverage.staleMortgageBalances++;return{id:mortgage.id,name:mortgage.lender||'Mortgage / lien',balance,ownerDebtShareBps:mortgage.ownerDebtShareBps,components:mortgage.components||{},loanType:mortgage.loanType,asOf:mortgage.balanceAsOf||null,stale};});
    if(Number.isSafeInteger(property.ownerDebt))totals.debts=addSafeCents(totals.debts,property.ownerDebt,'Balance sheet debt total');else for(const mortgage of mortgages){if(!Number.isSafeInteger(mortgage.balance))continue;const share=Number.isSafeInteger(mortgage.ownerDebtShareBps)?mortgage.ownerDebtShareBps:property.debtComplete?10000:null;if(share!==null)totals.debts=addSafeCents(totals.debts,Math.round(mortgage.balance*share/10000),'Balance sheet debt total');}
    return{id:property.id,name:property.name,ownerValue:property.ownerValue,ownerDebt:property.ownerDebt,ownerEquity:property.ownerEquity,valuationAsOf:property.valuationAsOf||null,mortgages};
  });
  const assets=addSafeCents(addSafeCents(addSafeCents(totals.cash,totals.investments,'Balance sheet asset total'),totals.otherAssets,'Balance sheet asset total'),totals.property,'Balance sheet asset total'),netWorth=addSafeCents(assets,-totals.debts,'Net worth');
  const incomplete=coverage.unknownBalanceAccounts>0||coverage.nonUsdAccounts>0||coverage.missingPropertyValuations>0||coverage.incompletePropertyDebt>0||coverage.missingMortgageBalances>0||coverage.staleAccounts>0||coverage.stalePropertyValuations>0||coverage.staleMortgageBalances>0;
  return{asOf:now.toISOString(),totals:{...totals,assets,liabilities:totals.debts,netWorth},includedAccounts,excludedAccounts,properties:propertyRows,coverage,incomplete,netWorthLabel:incomplete?'Known net worth · partial coverage':'Net worth · recorded USD records'};
}

export function makeBalanceSheetSnapshot(summary,date){
  return{id:crypto.randomUUID(),date,recordedAt:new Date().toISOString(),totals:{...summary.totals},coverage:{...summary.coverage},incomplete:summary.incomplete};
}
