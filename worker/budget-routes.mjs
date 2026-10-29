function currentHistoryValue(state,entry){
  if(entry.recordType==='budget'&&entry.scope==='recurring'){const row=(state.budgetTemplates||[]).find(item=>item.categoryId===entry.categoryId&&item.effectiveFrom===entry.month);return row?{amount:row.amount,schedule:state.budgetTemplateSchedules?.[`${entry.categoryId}:${entry.month}`]||null}:null;}
  if(entry.recordType==='budget'&&entry.scope==='month'){const key=`${entry.month}:${entry.categoryId}`;return Object.hasOwn(state.monthlyBudgets||{},key)?{amount:state.monthlyBudgets[key],schedule:state.monthlyBudgetSchedules?.[key]||null}:null;}
  if(entry.recordType==='income'&&entry.scope==='recurring'){const row=(state.incomePlanTemplates||[]).find(item=>item.effectiveFrom===entry.month);return row?row.amount:null;}
  if(entry.recordType==='income'&&entry.scope==='month')return Object.hasOwn(state.monthlyIncomePlans||{},entry.month)?state.monthlyIncomePlans[entry.month]:null;
  if(entry.recordType==='outlook')return state.monthlyBudgetOutlooks?.[entry.month]??null;
  return null;
}

export async function handleBudgetSummaryRoute(context) {
  const {request,path,url,repository,user,response,apiError,monthInReportingZone,validMonth,budgetActualsFromRows,budgetActuals,budgetRolloversFromRows,budgetRollovers,categoryCatalog,budgetTemplates}=context;
  if(request.method!=='GET'||path!=='/api/budget-summary')return null;
  const month=url.searchParams.get('month')||monthInReportingZone();
  if(!validMonth(month))throw apiError('Choose a valid reporting month.');
  const analytics=typeof repository.readBudgetAnalytics==='function'?await repository.readBudgetAnalytics(month):null;
  let {state}=analytics||await repository.read();
  if((state.transactionSplits||[]).length)state=(await repository.read()).state;
  if(state.owner&&state.owner!==user)return response({error:'This dashboard belongs to another account.'},403);
  const useSplitRows=(state.transactionSplits||[]).length>0;
  const actuals=analytics&&!useSplitRows?budgetActualsFromRows(state,analytics.currentRows):budgetActuals(state,month);
  const rollovers=analytics&&!useSplitRows?budgetRolloversFromRows(state,month,analytics.historicalRows):budgetRollovers(state,month);
  return response({month,revision:Number.isSafeInteger(state.revision)?state.revision:0,categories:categoryCatalog(state),budgetTemplates:budgetTemplates(state),monthlyBudgets:state.monthlyBudgets||{},monthlyBudgetSchedules:state.monthlyBudgetSchedules||{},budgetTemplateSchedules:state.budgetTemplateSchedules||{},budgetItemSettings:state.budgetItemSettings||{},budgetCategoryIds:state.budgetCategoryIds||{},incomePlanTemplates:state.incomePlanTemplates||[],monthlyIncomePlans:state.monthlyIncomePlans||{},monthlyBudgetOutlooks:state.monthlyBudgetOutlooks||{},budgetHistoryUnavailableBefore:state.budgetHistoryUnavailableBefore||null,actuals,budgetRollovers:rollovers});
}

export async function handleBudgetMutationRoute(context) {
  const {request,path,env,user,state,repository,response,apiError,body,categoryCatalog,budgetTemplates,monthInReportingZone,budgetActualsFromRows,budgetActuals,mutateTransactions,mutateWithReplay,findOperationReplay,checkRevision,budgetMonthKey,resolveBudget,resolveIncomePlan,validMonth,validateBudgetSchedule,monthlyBudgetAmount,normalizeCategory,CATEGORIES}=context;

  if(path==='/api/budget-stop-preview'&&request.method==='GET'){
    const url=new URL(request.url),categoryId=url.searchParams.get('categoryId'),month=url.searchParams.get('month'),category=categoryCatalog(state).find(row=>row.id===categoryId&&row.kind==='expense');
    if(!category||!validMonth(month))throw apiError('Choose a valid category and month to stop future funding.');
    const laterTemplates=budgetTemplates(state).filter(row=>row.categoryId===categoryId&&row.effectiveFrom>month).map(row=>({...row,schedule:state.budgetTemplateSchedules?.[`${categoryId}:${row.effectiveFrom}`]||null}));
    const laterOverrides=Object.entries(state.monthlyBudgets||{}).filter(([key])=>key.slice(8)===categoryId&&key.slice(0,7)>=month).map(([key,amount])=>({month:key.slice(0,7),amount,schedule:state.monthlyBudgetSchedules?.[key]||null})).sort((a,b)=>a.month.localeCompare(b.month));
    return response({categoryId,category:category.name,month,revision:state.revision||0,laterTemplates,laterOverrides});
  }

  if(path==='/api/budget-stop-future'&&request.method==='POST'){
    const input=await body(request),replay=await findOperationReplay(env,state,'budget-stop-future',input);if(replay.found)return response(replay.response);
    const category=categoryCatalog(state).find(row=>row.id===input.categoryId&&row.kind==='expense'&&!row.archivedAt),month=input.month;
    if(!category||!validMonth(month)||input.confirmFuture!==true)throw apiError('Review the future funding preview and confirm the selected month and category.',409);
    const mutation=await mutateWithReplay(env,'budget-stop-future',input,s=>{
      checkRevision(s,input);s.budgetTemplates=budgetTemplates(s).filter(row=>!(row.categoryId===category.id&&row.effectiveFrom>month));
      const key=`${category.id}:${month}`,index=s.budgetTemplates.findIndex(row=>row.categoryId===category.id&&row.effectiveFrom===month),template={categoryId:category.id,effectiveFrom:month,amount:0};if(index>=0)s.budgetTemplates[index]=template;else s.budgetTemplates.push(template);
      s.budgetTemplateSchedules={...(s.budgetTemplateSchedules||{}),[key]:{frequency:'monthly',dueMonth:null,sourceAmount:0}};
      s.monthlyBudgets={...(s.monthlyBudgets||{})};delete s.monthlyBudgets[`${month}:${category.id}`];s.monthlyBudgetSchedules={...(s.monthlyBudgetSchedules||{})};delete s.monthlyBudgetSchedules[`${month}:${category.id}`];
      for(const overrideKey of Object.keys(s.monthlyBudgets))if(overrideKey.slice(8)===category.id&&overrideKey.slice(0,7)>month){s.monthlyBudgets[overrideKey]=0;s.monthlyBudgetSchedules[overrideKey]={frequency:'monthly',dueMonth:null,sourceAmount:0};}
    },(saved,revision)=>({ok:true,revision,categoryId:category.id,month,amount:0}),null,'budget');
    return response(mutation.result);
  }

  if(path==='/api/budget-history-revert'&&request.method==='POST'){
    const input=await body(request),replay=await findOperationReplay(env,state,'budget-history-revert',input);if(replay.found)return response(replay.response);
    const history=typeof repository.readBudgetHistory==='function'?await repository.readBudgetHistory({id:input.historyId,limit:1}):(await repository.read()).state.budgetChangeHistory?.filter(row=>row.id===input.historyId)||[],entry=history[0];
    if(!entry)throw apiError('Budget history entry not found.',404);
    const mutation=await mutateWithReplay(env,'budget-history-revert',input,s=>{
      checkRevision(s,input);
      if(JSON.stringify(currentHistoryValue(s,entry))!==JSON.stringify(entry.after))throw apiError('This record changed after that history entry. Refresh the history before reverting it.',409);
      const updateArray=(rows,keyField,key,value)=>{const index=rows.findIndex(row=>row[keyField]===key);if(value===null){if(index>=0)rows.splice(index,1);}else if(index>=0)rows[index]=value;else rows.push(value);};
      if(entry.recordType==='budget'&&entry.scope==='recurring'){
        s.budgetTemplates=budgetTemplates(s);const key=`${entry.categoryId}:${entry.month}`,before=entry.before;s.budgetTemplates=s.budgetTemplates.filter(row=>row.categoryId!==entry.categoryId||row.effectiveFrom!==entry.month);
        if(before!==null)s.budgetTemplates.push({categoryId:entry.categoryId,effectiveFrom:entry.month,amount:before.amount});s.budgetTemplateSchedules={...(s.budgetTemplateSchedules||{})};if(before===null)delete s.budgetTemplateSchedules[key];else s.budgetTemplateSchedules[key]=before.schedule||{frequency:'monthly',dueMonth:null,sourceAmount:before.amount};
      }else if(entry.recordType==='budget'&&entry.scope==='month'){
        const key=budgetMonthKey(entry.month,entry.categoryId);s.monthlyBudgets={...(s.monthlyBudgets||{})};s.monthlyBudgetSchedules={...(s.monthlyBudgetSchedules||{})};if(entry.before===null){delete s.monthlyBudgets[key];delete s.monthlyBudgetSchedules[key];}else{s.monthlyBudgets[key]=entry.before.amount;s.monthlyBudgetSchedules[key]=entry.before.schedule||{frequency:'monthly',dueMonth:null,sourceAmount:entry.before.amount};}
      }else if(entry.recordType==='income'&&entry.scope==='recurring'){
        s.incomePlanTemplates=[...(s.incomePlanTemplates||[])];updateArray(s.incomePlanTemplates,'effectiveFrom',entry.month,entry.before===null?null:{effectiveFrom:entry.month,amount:entry.before});
      }else if(entry.recordType==='income'&&entry.scope==='month'){
        s.monthlyIncomePlans={...(s.monthlyIncomePlans||{})};if(entry.before===null)delete s.monthlyIncomePlans[entry.month];else s.monthlyIncomePlans[entry.month]=entry.before;
      }else if(entry.recordType==='outlook'){
        s.monthlyBudgetOutlooks={...(s.monthlyBudgetOutlooks||{})};if(entry.before===null)delete s.monthlyBudgetOutlooks[entry.month];else s.monthlyBudgetOutlooks[entry.month]=entry.before;
      }else throw apiError('This history entry cannot be reverted.',409);
    },(saved,revision)=>({ok:true,revision,revertedHistoryId:entry.id}),null,'budget');
    return response(mutation.result);
  }

  if(path==='/api/budget'&&request.method==='POST'){
    const input=await body(request),replay=await findOperationReplay(env,state,'budget',input);if(replay.found)return response(replay.response);
    const category=categoryCatalog(state).find(row=>row.id===input.categoryId)||categoryCatalog(state).find(row=>row.name===input.category),mode=input.mode||'template',month=input.month||monthInReportingZone(),rawSchedule=input.schedule||null;
    let schedule=null,amount=input.amount;
    try{if(rawSchedule){schedule=validateBudgetSchedule(rawSchedule);if(amount!==null)amount=monthlyBudgetAmount(amount,schedule.frequency);}}
    catch(error){throw apiError(error.message);}
    if(!category||!['expense','allocation'].includes(category.kind)||!['template','month'].includes(mode)||!validMonth(month)||input.amount!==null&&(!Number.isSafeInteger(input.amount)||input.amount<0||input.amount>100_000_000)||amount!==null&&(!Number.isSafeInteger(amount)||amount>100_000_000))throw apiError('Enter a valid budget item.');
    const mutation=await mutateWithReplay(env,'budget',input,s=>{
      checkRevision(s,input);
      const live=categoryCatalog(s).find(row=>row.id===category.id);if(!live)throw apiError('That category is no longer available.',409);
      s.owner=user;s.budgetHistoryUnavailableBefore||=monthInReportingZone();s.budgetTemplates=budgetTemplates(s);
      const effectiveSchedule=schedule||{frequency:'monthly',dueMonth:null};
      if(mode==='template'){
        const index=s.budgetTemplates.findIndex(entry=>entry.categoryId===live.id&&entry.effectiveFrom===month);
        s.budgetTemplateSchedules={...(s.budgetTemplateSchedules||{}),[`${live.id}:${month}`]:{frequency:effectiveSchedule.frequency,dueMonth:effectiveSchedule.dueMonth,sourceAmount:input.amount}};
        const template={categoryId:live.id,amount,effectiveFrom:month};
        if(index>=0)s.budgetTemplates[index]=template;else s.budgetTemplates.push(template);
        if(month<=monthInReportingZone()){if(amount===null)delete s.budgets[live.name];else s.budgets[live.name]=amount;}
      }else{
        const key=budgetMonthKey(month,live.id);s.monthlyBudgets={...(s.monthlyBudgets||{}),[key]:amount};s.monthlyBudgetSchedules={...(s.monthlyBudgetSchedules||{}),[key]:{frequency:effectiveSchedule.frequency,dueMonth:effectiveSchedule.dueMonth,sourceAmount:input.amount}};
      }
      s.budgetCategoryIds={...(s.budgetCategoryIds||{}),[live.id]:live.name};
    },(saved,revision)=>{const resolved=resolveBudget(budgetTemplates(saved),saved.monthlyBudgets||{},category.id,month,saved.monthlyBudgetSchedules||{}),effectiveScheduleResult=resolved.source==='month'?resolved:saved.budgetTemplateSchedules?.[`${category.id}:${resolved.effectiveFrom}`]||{};return{ok:true,revision,amount:resolved.amount,schedule:{frequency:effectiveScheduleResult.frequency||'monthly',dueMonth:effectiveScheduleResult.dueMonth??null,sourceAmount:effectiveScheduleResult.sourceAmount??resolved.amount}};},null,'budget');
    return response(mutation.result);
  }

  if(path==='/api/budget-reset'&&request.method==='POST'){
    const input=await body(request),replay=await findOperationReplay(env,state,'budget-reset',input);if(replay.found)return response(replay.response);
    const category=categoryCatalog(state).find(row=>row.id===input.categoryId);
    if(!category||!['expense','allocation'].includes(category.kind)||!validMonth(input.month))throw apiError('Choose a valid category and month.');
    const mutation=await mutateWithReplay(env,'budget-reset',input,s=>{checkRevision(s,input);const key=budgetMonthKey(input.month,category.id);s.monthlyBudgets={...(s.monthlyBudgets||{})};s.monthlyBudgetSchedules={...(s.monthlyBudgetSchedules||{})};delete s.monthlyBudgets[key];delete s.monthlyBudgetSchedules[key];},(saved,revision)=>{const resolved=resolveBudget(budgetTemplates(saved),saved.monthlyBudgets||{},category.id,input.month,saved.monthlyBudgetSchedules||{}),effectiveScheduleResult=resolved.source==='month'?resolved:saved.budgetTemplateSchedules?.[`${category.id}:${resolved.effectiveFrom}`]||{};return{ok:true,revision,amount:resolved.amount,schedule:{frequency:effectiveScheduleResult.frequency||'monthly',dueMonth:effectiveScheduleResult.dueMonth??null,sourceAmount:effectiveScheduleResult.sourceAmount??resolved.amount}};},null,'budget');
    return response(mutation.result);
  }

  if(path==='/api/income-plan'&&request.method==='POST'){
    const input=await body(request),replay=await findOperationReplay(env,state,'income-plan',input);if(replay.found)return response(replay.response);
    const mode=input.mode||'month',month=input.month||monthInReportingZone();
    if(!['template','month'].includes(mode)||!validMonth(month)||input.amount!==null&&(!Number.isSafeInteger(input.amount)||input.amount<0||input.amount>100_000_000))throw apiError('Enter a valid projected income amount.');
    const mutation=await mutateWithReplay(env,'income-plan',input,s=>{checkRevision(s,input);if(mode==='template'){s.incomePlanTemplates=[...(s.incomePlanTemplates||[])];const index=s.incomePlanTemplates.findIndex(row=>row.effectiveFrom===month),template={effectiveFrom:month,amount:input.amount};if(index>=0)s.incomePlanTemplates[index]=template;else s.incomePlanTemplates.push(template);}else s.monthlyIncomePlans={...(s.monthlyIncomePlans||{}),[month]:input.amount};},(saved,revision)=>{const plan=resolveIncomePlan(saved.incomePlanTemplates||[],saved.monthlyIncomePlans||{},month);return{ok:true,revision,amount:plan.amount,source:plan.source};},null,'budget');
    return response(mutation.result);
  }

  if(path==='/api/income-plan-reset'&&request.method==='POST'){
    const input=await body(request),replay=await findOperationReplay(env,state,'income-plan-reset',input);if(replay.found)return response(replay.response);
    if(!validMonth(input.month))throw apiError('Choose a valid reporting month.');
    const mutation=await mutateWithReplay(env,'income-plan-reset',input,s=>{checkRevision(s,input);s.monthlyIncomePlans={...(s.monthlyIncomePlans||{})};delete s.monthlyIncomePlans[input.month];},(saved,revision)=>({ok:true,revision,amount:resolveIncomePlan(saved.incomePlanTemplates||[],saved.monthlyIncomePlans||{},input.month).amount}),null,'budget');
    return response(mutation.result);
  }

  if(path==='/api/budget-outlook'&&request.method==='POST'){
    const input=await body(request),replay=await findOperationReplay(env,state,'budget-outlook',input);if(replay.found)return response(replay.response);
    const month=input.month;
    if(!validMonth(month)||!input.changes||typeof input.changes!=='object'||Array.isArray(input.changes))throw apiError('Enter valid month-end expectations.');
    const analytics=typeof repository.readBudgetAnalytics==='function'?await repository.readBudgetAnalytics(month):null;
    if(analytics&&analytics.state.revision!==state.revision)throw apiError('Data changed while you were editing. Refresh and try again.',409);
    const actuals=analytics?budgetActualsFromRows(analytics.state,analytics.currentRows):budgetActuals(state,month),incomeActual=actuals.income;
    if(input.changes.actualIncome!==incomeActual)throw apiError('Actual income changed while you were editing. Refresh and try again.',409);
    const categories=categoryCatalog(state),mutation=await mutateWithReplay(env,'budget-outlook',input,s=>{
      checkRevision(s,input);s.monthlyBudgetOutlooks={...(s.monthlyBudgetOutlooks||{})};
      const prior={...(s.monthlyBudgetOutlooks[month]||{}),expenses:{...(s.monthlyBudgetOutlooks[month]?.expenses||{})}},incomeRemaining=input.changes.income;
      if(incomeRemaining===null)delete prior.income;
      else{if(!Number.isSafeInteger(incomeRemaining)||incomeRemaining<0||incomeRemaining>100_000_000)throw apiError('Enter a non-negative remaining income amount.');prior.income={expectedTotal:incomeActual+incomeRemaining,actualAtEdit:incomeActual,updatedAt:new Date().toISOString()};}
      for(const [categoryId,remaining] of Object.entries(input.changes.expenses||{})){
        const category=categories.find(row=>row.id===categoryId&&row.kind==='expense');
        if(!category||remaining!==null&&(!Number.isSafeInteger(remaining)||remaining<0||remaining>100_000_000))throw apiError('Choose a valid bucket expectation.');
        if(remaining===null)delete prior.expenses[categoryId];else{const actual=actuals.categories[categoryId]||0;prior.expenses[categoryId]={expectedTotal:actual+remaining,actualAtEdit:actual,updatedAt:new Date().toISOString()};}
      }
      if(!prior.income&&!Object.keys(prior.expenses).length)delete s.monthlyBudgetOutlooks[month];else s.monthlyBudgetOutlooks[month]=prior;
    },(saved,revision)=>({ok:true,revision}),null,'budget');
    return response(mutation.result);
  }

  if(path==='/api/category-create'&&request.method==='POST'){
    const input=await body(request),name=typeof input.name==='string'?input.name.trim().replace(/\s+/g,' '):'';
    if(!name||name.length>80||!/^[\p{L}\p{N}][\p{L}\p{N} .&'’()/_-]*$/u.test(name)||Object.hasOwn(Object.prototype,name))throw apiError('Use a bucket name up to 80 characters, starting with a letter or number.');
    const itemType=input.itemType||'expense',budgetGroup=typeof input.budgetGroup==='string'?input.budgetGroup.trim():'',effectiveMonth=input.month||monthInReportingZone(),mode=input.mode||'template';
    let schedule=null,amount=input.amount;
    try{if(input.schedule){schedule=validateBudgetSchedule(input.schedule);const sourceAmount=input.schedule.sourceAmount??amount;if(sourceAmount!==undefined&&sourceAmount!==null)amount=monthlyBudgetAmount(sourceAmount,schedule.frequency);}}
    catch(error){throw apiError(error.message);}
    if(!['expense','allocation'].includes(itemType)||!['template','month'].includes(mode)||!validMonth(effectiveMonth)||budgetGroup.length>50||input.amount!==undefined&&input.amount!==null&&(!Number.isSafeInteger(input.amount)||input.amount<0||input.amount>100_000_000)||amount!==undefined&&amount!==null&&(!Number.isSafeInteger(amount)||amount>100_000_000))throw apiError('Enter a valid budget item.');
    const mutation=await mutateWithReplay(env,'category-create',input,s=>{
      checkRevision(s,input);
      if(categoryCatalog(s).some(category=>category.normalizedName===normalizeCategory(name)))throw apiError('A bucket with this name already exists.',409);
      if(categoryCatalog(s).filter(existing=>!existing.system).length>=50)throw apiError('Use up to 50 custom budget buckets.');
      if(amount!==undefined&&amount!==null){if(mode==='template')s.budgetTemplates=budgetTemplates(s);else s.monthlyBudgets={...(s.monthlyBudgets||{})};}
      const catalog=categoryCatalog(s),records=s.categoryRecords||catalog.filter(category=>!category.system),category={id:crypto.randomUUID(),name,normalizedName:normalizeCategory(name),kind:itemType==='allocation'?'allocation':'expense',system:false,order:Math.max(CATEGORIES.length-1,...catalog.map(row=>row.order))+1,archivedAt:null,budgetGroup};
      s.owner=user;s.categoryRecords=[...records,category];
      s.budgetItemSettings={...(s.budgetItemSettings||{}),[category.id]:{itemType,budgetGroup,...(schedule||{frequency:'monthly',dueMonth:null}),sourceAmount:schedule?.sourceAmount??input.amount??null}};
      if(amount!==undefined&&amount!==null){const scheduleRecord={frequency:schedule?.frequency||'monthly',dueMonth:schedule?.dueMonth??null,sourceAmount:schedule?.sourceAmount??input.amount??amount};if(mode==='template'){s.budgetTemplates.push({categoryId:category.id,amount,effectiveFrom:effectiveMonth});s.budgetTemplateSchedules={...(s.budgetTemplateSchedules||{}),[`${category.id}:${effectiveMonth}`]:scheduleRecord};if(effectiveMonth<=monthInReportingZone())s.budgets[name]=amount;}else{const key=budgetMonthKey(effectiveMonth,category.id);s.monthlyBudgets[key]=amount;s.monthlyBudgetSchedules={...(s.monthlyBudgetSchedules||{}),[key]:scheduleRecord};}}
      s.budgetCategoryIds={...(s.budgetCategoryIds||{}),[category.id]:name};
    },(s,revision)=>({ok:true,revision,category:categoryCatalog(s).find(category=>category.name===name&&!category.system)}),null,'budget');
    return response(mutation.result);
  }

  if(path==='/api/category-update'&&request.method==='POST'){
    const input=await body(request),replay=await context.findOperationReplay(env,state,'category-update',input);if(replay.found)return response(replay.response);
    let result;
    const renameCategory=input.action==='rename'?categoryCatalog(state).find(category=>category.id===input.id):null;
    const transactionIds=input.action==='rename'&&renameCategory?(typeof repository.queryCategoryTransactionIds==='function'?await repository.queryCategoryTransactionIds(renameCategory.id,renameCategory.name):(state.transactions||[]).filter(transaction=>transaction.category===renameCategory.name||transaction.overrideCategoryId===renameCategory.id||(!transaction.overrideCategoryId&&transaction.override===renameCategory.name)).map(transaction=>transaction.id)):[];
    const updateCategory=s=>{
      checkRevision(s,input);
      const records=s.categoryRecords||categoryCatalog(s).filter(category=>!category.system),index=records.findIndex(category=>category.id===input.id);
      if(index<0)throw apiError('Custom category not found.',404);
      const category=records[index];
      if(category.system||!['expense','allocation'].includes(category.kind))throw apiError('System categories cannot be changed here.',400);
      if(input.action==='rename'){
        const name=typeof input.name==='string'?input.name.trim().replace(/\s+/g,' '):'';
        if(!name||name.length>80||!/^[\p{L}\p{N}][\p{L}\p{N} .&'’()/_-]*$/u.test(name))throw apiError('Use a bucket name up to 80 characters, starting with a letter or number.');
        const normalizedName=normalizeCategory(name);
        if(categoryCatalog(s).some(row=>row.id!==category.id&&row.normalizedName===normalizedName))throw apiError('A bucket with this name already exists.',409);
        const oldName=category.name;records[index]={...category,name,normalizedName};
        if(Object.hasOwn(s.budgets||{},oldName)){s.budgets[name]=s.budgets[oldName];delete s.budgets[oldName];s.budgetCategoryIds={...(s.budgetCategoryIds||{}),[category.id]:name};}
        s.transactions.forEach(transaction=>{if(transaction.overrideCategoryId===category.id||(!transaction.overrideCategoryId&&transaction.override===oldName)){transaction.overrideCategoryId=category.id;transaction.override=name;}if(transaction.category===oldName){transaction.sourceCategory??=oldName;transaction.categoryId=category.id;transaction.category=name;}});
        s.customCategories=(s.customCategories||[]).map(value=>value===oldName?name:value);if(s.budgetCategoryIds?.[category.id])s.budgetCategoryIds[category.id]=name;
      }else if(input.action==='archive'){
        if(category.archivedAt)throw apiError('Category is already archived.',409);records[index]={...category,archivedAt:new Date().toISOString()};
      }else if(input.action==='restore'){
        if(!category.archivedAt)throw apiError('Category is already active.',409);records[index]={...category,archivedAt:null};
      }else if(input.action==='move'){
        if(!['up','down'].includes(input.direction))throw apiError('Choose a valid category order.');
        const ordered=records.map((row,i)=>({c:row,i})).sort((a,b)=>a.c.order-b.c.order),position=ordered.findIndex(entry=>entry.c.id===category.id),otherPosition=position+(input.direction==='up'?-1:1);
        if(otherPosition>=0&&otherPosition<ordered.length){const first=ordered[position],second=ordered[otherPosition],order=first.c.order;records[first.i]={...first.c,order:second.c.order};records[second.i]={...second.c,order};}
      }else throw apiError('Choose rename, archive, or move.');
      s.owner=user;s.categoryRecords=records;result=records[index];
    };
    const buildResult=(s,revision)=>({ok:true,revision,category:result});
    const saved=input.action==='rename'?await mutateWithReplay(env,'category-update',input,updateCategory,buildResult,transactionIds):await mutateWithReplay(env,'category-update',input,updateCategory,buildResult,null,'budget');
    return response(saved.result);
  }
  return null;
}
