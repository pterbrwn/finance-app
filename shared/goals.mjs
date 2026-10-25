export function eligibleCashAccounts(accounts=[],items=[],asOf=new Date()){
  const now=asOf instanceof Date?asOf:new Date(asOf+'T12:00:00Z');
  const itemById=new Map(items.map(item=>[item.id,item]));
  return accounts.map(account=>{
    const type=String(account.type||'').toLowerCase(),subtype=String(account.subtype||'').toLowerCase();
    const restricted=['investment','retirement','hsa','credit','loan','liability','mortgage'].includes(type)||['401k','ira','brokerage','hsa'].includes(subtype);
    const cashType=type==='depository'||(['asset','other'].includes(type)&&subtype==='cash');
    const balance=account.balance,available=account.availableBalance;
    let freshnessDate=null;
    if(account.itemId){const item=itemById.get(account.itemId);freshnessDate=item?.lastSuccess||item?.lastSync||null;}
    else if(account.manual)freshnessDate=account.balanceAsOf||null;
    const age=freshnessDate?now.getTime()-Date.parse(freshnessDate.length===10?freshnessDate+'T23:59:59Z':freshnessDate):Infinity;
    const stale=!Number.isFinite(age)||age>24*60*60*1000;
    const known=Number.isSafeInteger(balance)&&balance>=0&&account.currency==='USD';
    const usable=known&&!restricted&&cashType&&account.archivedAt==null&&account.includeInReporting!==false;
    const cap=!known?0:available===null||available===undefined?balance:Number.isSafeInteger(available)?Math.max(0,Math.min(balance,available)):0;
    return{accountId:account.id,name:account.name,balance:usable?cap:0,eligible:usable&&!stale,provisional:usable&&stale,stale,currency:account.currency||'UNKNOWN',asOf:freshnessDate};
  });
}

function reportingDate(value){
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
  const instant=value instanceof Date&&Number.isFinite(value.getTime())?value:new Date();
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(instant);
  return `${parts.find(part=>part.type==='year').value}-${parts.find(part=>part.type==='month').value}-${parts.find(part=>part.type==='day').value}`;
}

function validDateOnly(value){
  return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
}

export function goalProjection({target=0,funded=0,targetDate,asOf,monthlyContribution=0,apyBps=0}){
  const current=reportingDate(asOf),date=validDateOnly(targetDate)?targetDate:'';
  const month=new Date(current+'T12:00:00Z');month.setUTCDate(1);
  const scheduledDates=[];
  for(let index=0;index<1200;index++){
    const end=new Date(month);end.setUTCMonth(month.getUTCMonth()+1);end.setUTCDate(0);
    const endDate=end.toISOString().slice(0,10);
    if(endDate>current&&endDate<=date)scheduledDates.push(endDate);
    if(endDate>=date)break;
    month.setUTCMonth(month.getUTCMonth()+1);
  }
  const contributionDates=scheduledDates.length,shortfall=Math.max(0,target-funded);
  const requiredMonthly=shortfall===0?0:contributionDates?Math.ceil(shortfall/contributionDates):null;
  let projected=Math.max(0,funded),previous=new Date(current+'T12:00:00Z');
  for(const scheduledDate of scheduledDates){
    const end=new Date(scheduledDate+'T12:00:00Z'),daysInMonth=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()+1,0,12)).getUTCDate();
    const elapsedDays=(end.getTime()-previous.getTime())/86_400_000;
    if(apyBps>0)projected=Math.round(projected*Math.pow(1+apyBps/10000,elapsedDays/(daysInMonth*12)));
    projected+=Math.max(0,monthlyContribution||0);
    previous=end;
  }
  const projectedAtTarget=Math.round(projected),projectedShortfall=Math.max(0,target-projectedAtTarget);
  return{target,funded,shortfall,contributionDates,scheduledDates,requiredMonthly,monthlyContribution:monthlyContribution||0,apyBps,projectedAtTarget,projectedShortfall,overdue:shortfall>0&&date!==''&&date<=current};
}

export function summarizeGoals(goals=[],allocations=[],accounts=[],items=[],asOf=new Date()){
  const cash=eligibleCashAccounts(accounts,items,asOf),cashById=new Map(cash.map(account=>[account.accountId,account]));
  const totals=new Map(cash.map(account=>[account.accountId,{fresh:account.eligible?account.balance:0,provisional:account.provisional?account.balance:0,reserved:0}]));
  const active=allocations.filter(allocation=>allocation.active!==false&&goals.some(goal=>goal.id===allocation.goalId&&!goal.archivedAt));
  const byGoal=new Map(goals.map(goal=>[goal.id,{reserved:0,backed:0,provisional:0,backedAllocations:[]} ]));
  const ordered=[...active].sort((a,b)=>{
    const ga=goals.find(goal=>goal.id===a.goalId),gb=goals.find(goal=>goal.id===b.goalId);
    return (ga?.priority??100)-(gb?.priority??100)||(ga?.createdAt||'').localeCompare(gb?.createdAt||'')||a.goalId.localeCompare(b.goalId)||a.accountId.localeCompare(b.accountId);
  });
  for(const allocation of ordered){
    const summary=byGoal.get(allocation.goalId),account=cashById.get(allocation.accountId),accountTotal=totals.get(allocation.accountId);if(!summary||!accountTotal)continue;
    const amount=Math.max(0,Number.isSafeInteger(allocation.amount)?allocation.amount:0);summary.reserved+=amount;accountTotal.reserved+=amount;
    const available=account.eligible?accountTotal.fresh:account.provisional?accountTotal.provisional:0,backed=Math.min(amount,available);
    if(account.eligible)accountTotal.fresh-=backed;else if(account.provisional)accountTotal.provisional-=backed;
    if(account.eligible)summary.backed+=backed;else summary.provisional+=backed;
    summary.backedAllocations.push({accountId:allocation.accountId,amount,backed,provisional:account.provisional,stale:account.stale});
  }
  const accountSummaries=cash.map(account=>{const total=totals.get(account.accountId);return{...account,reserved:total.reserved,unallocated:Math.max(0,account.balance-total.reserved),underfunded:total.reserved>account.balance};});
  const goalSummaries=goals.map(goal=>{
    const detail=byGoal.get(goal.id)||{reserved:0,backed:0,provisional:0,backedAllocations:[]};
    const funded=detail.backed,shortfall=Math.max(0,(goal.target||0)-funded);
    const projection=goalProjection({target:goal.target,funded,targetDate:goal.targetDate,asOf,monthlyContribution:goal.monthlyContribution,apyBps:goal.apyBps});
    return{...goal,...detail,funded,shortfall,projection,archived:!!goal.archivedAt,accountShortfall:Math.max(0,detail.reserved-detail.backed-detail.provisional)};
  });
  const eligibleTotal=cash.reduce((sum,account)=>sum+(account.eligible?account.balance:0),0),unallocatedTotal=accountSummaries.reduce((sum,account)=>sum+(account.eligible?account.unallocated:0),0);
  return{goals:goalSummaries,accounts:accountSummaries,eligibleTotal,unallocatedTotal,provisionalTotal:cash.reduce((sum,account)=>sum+(account.provisional?account.balance:0),0)};
}
