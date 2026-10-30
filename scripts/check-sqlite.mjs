import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes, createHash, randomUUID } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import worker from '../worker/index.js';
import { webcrypto } from 'node:crypto';

globalThis.crypto ||= webcrypto;
import { createSqliteRepository, createSqliteRepositoryAt, openLedgerDatabase, SQLITE_SCHEMA_VERSION } from '../server/sqlite-repository.mjs';

assert.match(process.version, /^v24\./);
assert.equal(SQLITE_SCHEMA_VERSION, 9);
const directory = await mkdtemp(join(tmpdir(), 'ledger-sqlite-check-'));
try {
  const databasePath = join(directory, 'ledger.sqlite');
  const repository = await createSqliteRepositoryAt(databasePath);
  await repository.mutate(state => {
    state.owner = 'synthetic-owner';
    state.items.push({ id: 'item-1', token: { data: 'synthetic-ciphertext', iv: 'synthetic-iv' }, cursor: 'cursor-x' });
    state.accounts.push({ id: 'account-1', itemId: 'item-1', source: 'provider', balance: 12345, profileId:'peter' });
    state.transactions.push({ id: 'txn-1', accountId: 'account-1', itemId: 'item-1', date: '2026-01-03', merchant:'Café Étoile', amount: 2500, currency: 'USD', override: 'Travel', profileId:'peter' });
    state.holdings.push({ id: 'holding-1', itemId: 'item-1', quantity: '1.250' });
    state.customCategories.push('Travel');
    state.budgets.Travel = 40000;
    state.budgetTemplates.push({categoryId:'category-travel',effectiveFrom:'2026-10',amount:40000});
    state.monthlyBudgets['2026-10:category-travel'] = 0;
    state.incomePlanTemplates=[{effectiveFrom:'2026-10',amount:500000}];
    state.monthlyIncomePlans={'2026-11':480000};
    state.monthlyBudgetOutlooks={'2026-10':{income:{expectedTotal:470000,actualAtEdit:250000,updatedAt:'2026-10-25T00:00:00.000Z'},expenses:{'category-travel':{expectedTotal:25000,actualAtEdit:10000,updatedAt:'2026-10-25T00:00:00.000Z'}}}};
    state.goals = [{id:'goal-1',name:'Emergency fund',target:500000,allocationHistory:[{id:'allocation-1',amount:12500}]}];
    state.properties = [{id:'property-1',value:32000000,mortgageSnapshots:[{date:'2026-10-01',balance:24000000}]}];
    state.scenarios = [{id:'scenario-1',versions:[{id:'quote-1',inputs:{purchasePrice:40000000},funding:{goalId:'goal-1'}}]}];
    state.balanceSnapshots = [{date:'2026-10-25',assets:51000000}];
    state.importHistory = [{id:'undo-1',transactionIds:['txn-1']}];
    state.syncJobs = [{id:'job-1',status:'interrupted'}];
  });
  const read = (await repository.read()).state;
  assert.equal(read.transactions[0].override, 'Travel');
  assert.equal(read.items[0].token.data, 'synthetic-ciphertext');
  assert.equal(read.accounts[0].balance, 12345);
  assert.equal(read.budgets.Travel, 40000);
  const operationId=randomUUID(),operation={id:operationId,scope:'manual-account',payloadDigest:createHash('sha256').update('synthetic-operation').digest('hex')};
  const committed=await repository.mutateWithOperation(operation,async state=>{state.accounts[0].balance=12346;state.revision=(state.revision||0)+1;return{...operation,response:{ok:true,revision:state.revision},revision:state.revision,createdAt:'2026-10-29T12:00:00.000Z'};});
  assert.deepEqual(committed.result,{ok:true,revision:1});assert.equal(committed.replayed,false);
  const replayed=await repository.mutateWithOperation(operation,async()=>{throw new Error('a committed operation must not run its update twice');});assert.deepEqual(replayed.result,committed.result);assert.equal(replayed.replayed,true);
  await assert.rejects(repository.mutateWithOperation({...operation,payloadDigest:createHash('sha256').update('changed-operation').digest('hex')},async()=>{}),/already used for different values/);
  assert.equal((await repository.readOperationResult(operationId)).payloadDigest,operation.payloadDigest);
  assert.equal(JSON.stringify((await repository.read()).state).includes('synthetic-operation'),false,'SQLite metadata does not retain raw operation payloads');
  const operationIndexDb=new Database(databasePath,{readonly:true,fileMustExist:true});assert.match(operationIndexDb.prepare('EXPLAIN QUERY PLAN SELECT response_json FROM operation_results WHERE operation_id=?').all(operationId).map(row=>row.detail).join(' '),/PRIMARY KEY|sqlite_autoindex_operation_results/i,'operation replay lookup uses the primary-key index');operationIndexDb.close();
  const atomicOperationId=randomUUID(),atomicGuardDb=new Database(databasePath);atomicGuardDb.exec(`CREATE TRIGGER reject_synthetic_operation BEFORE INSERT ON operation_results WHEN NEW.operation_id='${atomicOperationId}' BEGIN SELECT RAISE(ABORT,'synthetic operation commit interruption'); END;`);
  const balanceBeforeFailedOperation=(await repository.read()).state.accounts[0].balance;
  await assert.rejects(repository.mutateWithOperation({id:atomicOperationId,scope:'manual-account',payloadDigest:createHash('sha256').update('atomic').digest('hex')},async state=>{state.accounts[0].balance=999999;state.revision++;return{id:atomicOperationId,scope:'manual-account',payloadDigest:createHash('sha256').update('atomic').digest('hex'),response:{ok:true},revision:state.revision,createdAt:'2026-10-29T12:01:00.000Z'};}),/synthetic operation commit interruption/);
  assert.equal((await repository.read()).state.accounts[0].balance,balanceBeforeFailedOperation,'failed operation-row insertion rolls back the domain mutation');assert.equal(await repository.readOperationResult(atomicOperationId),null);atomicGuardDb.close();
  assert.deepEqual(read.budgetTemplates,[{categoryId:'category-travel',effectiveFrom:'2026-10',amount:40000}]);
  assert.equal(read.monthlyBudgets['2026-10:category-travel'],0);
  assert.deepEqual(read.incomePlanTemplates,[{effectiveFrom:'2026-10',amount:500000}]);
  assert.deepEqual(read.monthlyIncomePlans,{'2026-11':480000});
  assert.deepEqual(read.monthlyBudgetOutlooks['2026-10'].expenses['category-travel'],{expectedTotal:25000,actualAtEdit:10000,updatedAt:'2026-10-25T00:00:00.000Z'});
  assert.deepEqual(read.goals,[{id:'goal-1',name:'Emergency fund',target:500000,allocationHistory:[{id:'allocation-1',amount:12500}]}]);
  assert.deepEqual(read.properties,[{id:'property-1',value:32000000,mortgageSnapshots:[{date:'2026-10-01',balance:24000000}]}]);
  assert.deepEqual(read.scenarios,[{id:'scenario-1',versions:[{id:'quote-1',inputs:{purchasePrice:40000000},funding:{goalId:'goal-1'}}]}]);
  assert.deepEqual(read.balanceSnapshots,[{date:'2026-10-25',assets:51000000}]);
  assert.deepEqual(read.importHistory,[{id:'undo-1',transactionIds:['txn-1']}]);
  assert.deepEqual(read.syncJobs,[{id:'job-1',status:'interrupted'}]);
  const dashboardRead=await repository.readDashboard();
  assert.equal(dashboardRead.state.transactionCount,1);
  assert.equal('transactions' in dashboardRead.state,false,'bounded dashboard state omits transaction history');
  assert.equal('scenarios' in dashboardRead.state,false,'bounded dashboard state omits versioned scenario history');
  assert.equal(dashboardRead.state.items[0].token,undefined);
  assert.equal(dashboardRead.state.items[0].cursor,undefined);
  assert.deepEqual((await repository.queryTransactions({page:1,limit:50,category:'Travel',from:'2026-01-01',to:'2026-01-31'})).transactions.map(row=>row.id),['txn-1']);
  assert.deepEqual((await repository.queryTransactions({page:1,limit:50,search:'CAFÉ',from:'2026-01-01',to:'2026-01-31'})).transactions.map(row=>row.id),['txn-1'],'SQLite merchant filtering retains Unicode case-insensitive search');
  const januarySummary=await repository.queryMonthSummary('2026-01');
  assert.equal(januarySummary.current.spend,2500);
  assert.equal(januarySummary.current.categories.Travel,2500);
  assert.equal(januarySummary.current.purchases,1);
  assert.deepEqual(januarySummary.current.weeklySpend,[2500,0,0,0,0]);
  await repository.mutate(state=>{state.categoryRecords=[{id:'allocation-savings',name:'Savings Allocation',kind:'allocation'}];state.budgetItemSettings={'allocation-savings':{itemType:'allocation'}};state.transactions.push({id:'txn-allocation',accountId:'account-1',date:'2026-01-04',merchant:'Synthetic allocation transfer',amount:90000,currency:'USD',category:'Savings Allocation',categoryId:'allocation-savings'});});
  const allocationSummary=await repository.queryMonthSummary('2026-01');
  assert.equal(allocationSummary.current.spend,2500,'SQLite monthly summary excludes explicitly classified allocation transactions from spending');
  assert.deepEqual(allocationSummary.current.categories,{Travel:2500});assert.equal(allocationSummary.current.purchases,1,'allocation transfers do not count as purchases');
  await repository.mutate(state=>{state.transactions=state.transactions.filter(row=>row.id!=='txn-allocation');delete state.categoryRecords;delete state.budgetItemSettings;});
  await Promise.all([
    repository.mutate(state => { state.budgets.Dining = 10000; }),
    repository.mutate(state => { state.budgets.Housing = 150000; })
  ]);
  assert.deepEqual({ ...(await repository.read()).state.budgets }, { Travel: 40000, Dining: 10000, Housing: 150000 });
  const subsetRevision=(await repository.read()).state.revision||0;
  await repository.mutateTransactionSubset(['txn-1'],state=>{assert.equal(state.transactions.length,1);assert.equal(state.revision,subsetRevision);state.transactions[0].override='Groceries';});
  const subsetRead=(await repository.read()).state;
  assert.equal(subsetRead.transactions[0].override,'Groceries','scoped transaction writes persist the selected row');
  assert.equal(subsetRead.revision,subsetRevision+1,'scoped transaction writes advance the shared revision');
  assert.equal(subsetRead.incomePlanTemplates[0].amount,500000,'transaction subset writes preserve projected income plans');
  assert.equal(subsetRead.monthlyBudgetOutlooks['2026-10'].income.expectedTotal,470000,'transaction subset writes preserve month-end outlook adjustments');
  await repository.mutateTransactionSubset(['txn-1'],state=>{state.transactions[0].override='Travel';delete state.transactions[0].overrideCategoryId;});
  const transactionGuardDb = new Database(databasePath);
  transactionGuardDb.exec("CREATE TRIGGER forbid_budget_transaction_delete BEFORE DELETE ON transactions BEGIN SELECT RAISE(ABORT,'synthetic unrelated transaction delete'); END; CREATE TRIGGER forbid_budget_transaction_insert BEFORE INSERT ON transactions WHEN NOT EXISTS(SELECT 1 FROM transactions WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'synthetic unrelated transaction insert'); END; CREATE TRIGGER forbid_budget_transaction_update BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT,'synthetic unrelated transaction update'); END;");
  const budgetSnapshot = await repository.readBudgetState();
  const budgetSaveResponse = await worker.fetch(new Request('https://ledger.sqlite.test/api/budget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-id': 'synthetic-owner' },
    body: JSON.stringify({ category: 'Groceries', categoryId: 'system:groceries', amount: 73000, mode: 'template', month: '2026-10', revision: budgetSnapshot.state.revision })
  }), { REPOSITORY: repository, LOCAL_ONLY: true });
  assert.equal(budgetSaveResponse.status, 200, await budgetSaveResponse.text());
  const guardedBudgetState = (await repository.read()).state;
  assert.deepEqual(guardedBudgetState.transactions.map(row => row.id), ['txn-1'], 'budget edits never delete or reinsert unrelated transaction rows');
  assert.equal(guardedBudgetState.transactions[0].override, 'Travel', 'budget edits preserve the existing transaction override');
  assert.equal(guardedBudgetState.budgetTemplates.find(row => row.categoryId === 'system:groceries' && row.effectiveFrom === '2026-10').amount, 73000);
  let scopedBudgetRevision=guardedBudgetState.revision;
  async function scopedBudgetPost(path,input){const result=await worker.fetch(new Request('https://ledger.sqlite.test/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({...input,revision:scopedBudgetRevision})}),{REPOSITORY:repository,LOCAL_ONLY:true});const text=await result.text();assert.equal(result.status,200,`${path}: ${text}`);const payload=JSON.parse(text);scopedBudgetRevision=payload.revision;return payload;}
  await scopedBudgetPost('budget-reset',{categoryId:'system:groceries',month:'2026-10'});
  await scopedBudgetPost('income-plan',{mode:'template',month:'2026-10',amount:500000});
  await scopedBudgetPost('income-plan-reset',{month:'2026-10'});
  await scopedBudgetPost('budget-outlook',{month:'2026-10',changes:{actualIncome:0,income:12000,expenses:{'system:groceries':5000}}});
  const createdScopedCategory=await scopedBudgetPost('category-create',{name:'Synthetic scoped category',amount:null,itemType:'expense',budgetGroup:'Other'});
  assert.ok((await repository.read()).state.customCategories.includes('Synthetic scoped category'),'scoped category creation keeps the legacy SQL name projection consistent with canonical category records');
  const categoryLimitPath=join(directory,'category-limit.sqlite'),categoryLimitRepository=await createSqliteRepositoryAt(categoryLimitPath);
  await categoryLimitRepository.mutate(state=>{state.revision=0;state.categoryRecords=Array.from({length:50},(_,index)=>({id:`synthetic-category-${index}`,name:`Synthetic category ${index}`,normalizedName:`synthetic category ${index}`,kind:'expense',system:false,order:20+index,archivedAt:null}));state.customCategories=[];});
  const categoryLimitState=(await categoryLimitRepository.read()).state,categoryLimitResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/category-create',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({name:'Synthetic category 51',amount:null,itemType:'expense',budgetGroup:'Other',revision:categoryLimitState.revision})}),{REPOSITORY:categoryLimitRepository,LOCAL_ONLY:true});
  assert.equal(categoryLimitResponse.status,400,`the custom category limit uses persisted canonical category records: ${await categoryLimitResponse.clone().text()}`);
  assert.equal((await categoryLimitRepository.read()).state.categoryRecords.length,50,'rejected category does not alter canonical category storage');
  await categoryLimitRepository.close();
  const categoryRenameRepository=await createSqliteRepositoryAt(join(directory,'category-rename-reopen.sqlite'));await categoryRenameRepository.mutate(state=>{state.revision=0;});const categoryCreateState=(await categoryRenameRepository.read()).state,categoryCreateResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/category-create',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({name:'Before SQLite rename',profileId:'peter',amount:null,itemType:'expense',budgetGroup:'Other',revision:categoryCreateState.revision})}),{REPOSITORY:categoryRenameRepository,LOCAL_ONLY:true});assert.equal(categoryCreateResponse.status,200,await categoryCreateResponse.clone().text());const categoryCreateResult=await categoryCreateResponse.json(),categoryRenameResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/category-update',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({id:categoryCreateResult.category.id,action:'rename',name:'After SQLite rename',profileId:'peter',revision:categoryCreateResult.revision})}),{REPOSITORY:categoryRenameRepository,LOCAL_ONLY:true});assert.equal(categoryRenameResponse.status,200,await categoryRenameResponse.clone().text());await categoryRenameRepository.close();const categoryRenameReopened=await createSqliteRepositoryAt(join(directory,'category-rename-reopen.sqlite')),categoryRenameState=(await categoryRenameReopened.read()).state;assert.equal(categoryRenameState.categoryRecords.filter(row=>!row.system).length,1,'category rename and reopen do not create a phantom custom category');assert.equal(categoryRenameState.categoryRecords.find(row=>row.id===categoryCreateResult.category.id).name,'After SQLite rename','renamed category identity and name survive SQLite reopen');assert.ok(categoryRenameState.customCategories.includes('After SQLite rename'));assert.equal(categoryRenameState.customCategories.includes('Before SQLite rename'),false,'legacy category projection does not resurrect the pre-rename name');await categoryRenameReopened.close();
  await scopedBudgetPost('category-update',{id:createdScopedCategory.category.id,action:'archive'});
  await scopedBudgetPost('category-update',{id:createdScopedCategory.category.id,action:'restore'});
  await scopedBudgetPost('category-update',{id:createdScopedCategory.category.id,action:'move',direction:'up'});
  const afterScopedBudgetFamily=(await repository.read()).state;
  assert.deepEqual(afterScopedBudgetFamily.transactions.map(row=>row.id),['txn-1'],'budget reset, income, outlook, and category-create routes do not rewrite unrelated transaction rows');
  assert.equal(afterScopedBudgetFamily.revision,scopedBudgetRevision,'scoped metadata routes each advance the shared revision once');
  async function budgetAuditPost(path,input){const result=await worker.fetch(new Request('https://ledger.sqlite.test/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify(input)}),{REPOSITORY:repository,LOCAL_ONLY:true});return{status:result.status,body:await result.json()};}
  let auditState=(await repository.readBudgetState()).state;const auditedInput={categoryId:'system:groceries',amount:77000,mode:'template',month:'2026-10',revision:auditState.revision,clientOperationId:randomUUID()},auditedSave=await budgetAuditPost('budget',auditedInput);assert.equal(auditedSave.status,200);const auditRows=await repository.readBudgetHistory({month:'2026-10',categoryId:'system:groceries',limit:100}),auditedEntry=auditRows.find(row=>row.operationId===auditedInput.clientOperationId);assert.ok(auditedEntry);assert.equal(auditedEntry.before.amount,73000);assert.equal(auditedEntry.after.amount,77000);
  const replayedAuditSave=await budgetAuditPost('budget',auditedInput);assert.deepEqual(replayedAuditSave.body,auditedSave.body);assert.equal((await repository.readBudgetHistory({month:'2026-10',categoryId:'system:groceries',limit:100})).filter(row=>row.operationId===auditedInput.clientOperationId).length,1,'an exact operation replay does not duplicate budget history');
  auditState=(await repository.readBudgetState()).state;const auditRevert=await budgetAuditPost('budget-history-revert',{historyId:auditedEntry.id,revision:auditState.revision,clientOperationId:randomUUID()});assert.equal(auditRevert.status,200);assert.equal((await repository.readBudgetState()).state.budgetTemplates.find(row=>row.categoryId==='system:groceries'&&row.effectiveFrom==='2026-10').amount,73000,'history revert applies the before-value as a new saved change');assert.equal((await repository.readBudgetHistory({month:'2026-10',categoryId:'system:groceries',limit:100})).length,auditRows.length+1,'reverting appends a new history entry without removing the original');
  const staleRevert=await budgetAuditPost('budget-history-revert',{historyId:auditedEntry.id,revision:auditState.revision,clientOperationId:randomUUID()});assert.equal(staleRevert.status,409,'history revert rejects a stale revision');
  auditState=(await repository.readBudgetState()).state;const futureTemplate=await budgetAuditPost('budget',{categoryId:'system:groceries',amount:50000,mode:'template',month:'2027-01',revision:auditState.revision,clientOperationId:randomUUID()});assert.equal(futureTemplate.status,200);
  auditState=(await repository.readBudgetState()).state;const futureOverride=await budgetAuditPost('budget',{categoryId:'system:groceries',amount:60000,mode:'month',month:'2027-03',revision:auditState.revision,clientOperationId:randomUUID()});assert.equal(futureOverride.status,200);
  const stopPreview=await worker.fetch(new Request('https://ledger.sqlite.test/api/budget-stop-preview?categoryId=system%3Agroceries&month=2026-11',{headers:{'oai-authenticated-user-id':'synthetic-owner'}}),{REPOSITORY:repository,LOCAL_ONLY:true});const stopPreviewBody=await stopPreview.json();assert.equal(stopPreview.status,200);assert.equal(stopPreviewBody.laterTemplates.length,1);assert.equal(stopPreviewBody.laterOverrides.length,1);
  auditState=(await repository.readBudgetState()).state;const stopped=await budgetAuditPost('budget-stop-future',{categoryId:'system:groceries',month:'2026-11',confirmFuture:true,revision:auditState.revision,clientOperationId:randomUUID()});assert.equal(stopped.status,200);
  const stoppedState=(await repository.readBudgetState()).state;assert.equal(stoppedState.budgetTemplates.find(row=>row.categoryId==='system:groceries'&&row.effectiveFrom==='2026-10').amount,73000,'stopping future funding preserves the earlier plan');assert.equal(stoppedState.budgetTemplates.find(row=>row.categoryId==='system:groceries'&&row.effectiveFrom==='2026-11').amount,0,'stopping future funding establishes a known zero from the chosen month');assert.equal(stoppedState.budgetTemplates.some(row=>row.categoryId==='system:groceries'&&row.effectiveFrom==='2027-01'),false);assert.equal(stoppedState.monthlyBudgets['2027-03:system:groceries'],0,'later month overrides cannot restart funding');
  const stoppedSummary=await(await worker.fetch(new Request('https://ledger.sqlite.test/api/budget-summary?month=2026-11',{headers:{'oai-authenticated-user-id':'synthetic-owner'}}),{REPOSITORY:repository,LOCAL_ONLY:true})).json();assert.equal(stoppedSummary.budgetRollovers['system:groceries'],73000,'zero future funding preserves the accrued bucket carryover');
  scopedBudgetRevision=stoppedState.revision;
  transactionGuardDb.exec('DROP TRIGGER forbid_budget_transaction_update;');
  await scopedBudgetPost('category-update',{id:'legacy:travel',action:'rename',name:'Trip'});
  const afterScopedCategoryRename=(await repository.read()).state;
  assert.deepEqual(afterScopedCategoryRename.transactions.map(row=>row.id),['txn-1'],'category rename retains transaction identity through targeted persistence');
  assert.equal(afterScopedCategoryRename.transactions[0].override,'Trip','category rename updates its matching legacy assignment');
  assert.equal(afterScopedCategoryRename.transactions[0].overrideCategoryId,'legacy:travel','category rename assigns the stable category ID');
  transactionGuardDb.exec("CREATE TRIGGER forbid_budget_transaction_update BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT,'synthetic unrelated transaction update'); END;");
  const manualCreateResponse = await worker.fetch(new Request('https://ledger.sqlite.test/api/manual-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-id': 'synthetic-owner' },
    body: JSON.stringify({ name: 'Synthetic manual cash', type: 'depository', balance: 8800, currency: 'USD', asOf: '2026-10-25', revision: scopedBudgetRevision })
  }), { REPOSITORY: repository, LOCAL_ONLY: true });
  assert.equal(manualCreateResponse.status, 200, await manualCreateResponse.text());
  const manualCreated = await repository.read(), manualAccount = manualCreated.state.accounts.find(row => row.name === 'Synthetic manual cash');
  assert.ok(manualAccount?.manual, 'manual account creation persists through the account-scoped writer');
  const linkedAccount = manualCreated.state.accounts.find(row => row.id === 'account-1');
  const accountUpdateResponse = await worker.fetch(new Request('https://ledger.sqlite.test/api/account-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-id': 'synthetic-owner' },
    body: JSON.stringify({ id: linkedAccount.id, action: 'include', value: false, revision: manualCreated.state.revision })
  }), { REPOSITORY: repository, LOCAL_ONLY: true });
  assert.equal(accountUpdateResponse.status, 200, await accountUpdateResponse.text());
  const afterAccountUpdates = (await repository.read()).state;
  assert.equal(afterAccountUpdates.accounts.find(row => row.id === 'account-1').includeInReporting, false, 'provider-account metadata writes use the account-scoped path');
  assert.deepEqual(afterAccountUpdates.transactions.map(row => row.id), ['txn-1'], 'manual and provider account edits do not rewrite transactions');
  let ownerMetadataRevision=afterAccountUpdates.revision;
  async function scopedOwnerPost(path,input){const result=await worker.fetch(new Request('https://ledger.sqlite.test/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({...input,revision:ownerMetadataRevision})}),{REPOSITORY:repository,LOCAL_ONLY:true});const text=await result.text();assert.equal(result.status,200,`${path}: ${text}`);const payload=JSON.parse(text);ownerMetadataRevision=payload.revision;return payload;}
  await scopedOwnerPost('goal',{profileId:'peter',name:'Synthetic scoped goal',target:100000,targetDate:'2027-12-31',priority:1,monthlyContribution:0,apyBps:0});
  const scopedProperty=await scopedOwnerPost('property',{name:'Synthetic scoped property',address:'',ownershipBps:10000,valuation:null});
  await scopedOwnerPost('mortgage',{propertyId:scopedProperty.property.id,lender:'Synthetic scoped lender',loanType:'other',statementBalance:null,originalPrincipal:null,originationDate:null,annualRatePercent:'',termMonths:null,components:{}});
  const afterScopedOwnerFamily=(await repository.read()).state;
  assert.deepEqual(afterScopedOwnerFamily.transactions.map(row=>row.id),['txn-1'],'manual account, provider account, goal, property, and mortgage writes preserve unrelated transaction rows');
  assert.equal(afterScopedOwnerFamily.revision,ownerMetadataRevision,'owner metadata routes each advance the shared revision exactly once');
  const revisionBeforeSubsetFailure = ownerMetadataRevision;
  transactionGuardDb.exec('DROP TRIGGER forbid_budget_transaction_delete; DROP TRIGGER forbid_budget_transaction_insert; DROP TRIGGER forbid_budget_transaction_update;');
  transactionGuardDb.close();
  await assert.rejects(repository.mutateTransactionSubset(['txn-1'],state=>{state.transactions[0].override='Must Roll Back';throw new Error('synthetic scoped rollback');}),/synthetic scoped rollback/);
  assert.equal((await repository.read()).state.transactions[0].override,'Trip','failed scoped edits leave the row unchanged');
  assert.equal((await repository.read()).state.revision,revisionBeforeSubsetFailure,'failed scoped edits leave the revision unchanged');
  await repository.mutateTransactionSubset(['txn-1'],state=>{state.transactions[0].override='Travel';});
  await repository.mutate(state=>{state.items.push({id:'sync-item',cursor:'cursor-before',lifecycle:'connected'});});
  const beforeSyncRevision=(await repository.read()).state.revision;
  await repository.mutateTransactionSubset(['sync-added'],state=>{state.items.find(item=>item.id==='sync-item').cursor='cursor-after';state.transactions.push({id:'sync-added',itemId:'sync-item',date:'2026-01-04',merchant:'Synced row',amount:500,currency:'USD'});});
  let syncState=(await repository.read()).state;
  assert.equal(syncState.items.find(item=>item.id==='sync-item').cursor,'cursor-after');
  assert.equal(syncState.transactions.some(transaction=>transaction.id==='sync-added'),true);
  assert.equal(syncState.revision,beforeSyncRevision+1,'sync cursor and transaction share one revision');
  await assert.rejects(repository.mutateTransactionSubset(['sync-added'],state=>{state.items.find(item=>item.id==='sync-item').cursor='cursor-rolled-back';state.transactions[0].amount=999;throw new Error('synthetic cursor rollback');}),/synthetic cursor rollback/);
  syncState=(await repository.read()).state;
  assert.equal(syncState.items.find(item=>item.id==='sync-item').cursor,'cursor-after','failed sync write retains the prior cursor');
  assert.equal(syncState.transactions.find(transaction=>transaction.id==='sync-added').amount,500,'failed sync write retains the prior transaction');
  await repository.mutateTransactionSubset(['sync-added'],state=>{state.items.find(item=>item.id==='sync-item').cursor='cursor-before';state.transactions=[];});
  await assert.rejects(repository.mutate(state => {
    state.accounts.push({ id: 'orphan-account', itemId: 'missing-item' });
  }));
  assert.equal((await repository.read()).state.accounts.length, 2, 'failed FK writes roll back without removing the synthetic manual account');
  await repository.close();

  let profileRepository=await createSqliteRepositoryAt(join(directory,'profiles.sqlite'));
  await profileRepository.mutate(state=>{state.owner='synthetic-owner';state.revision=0;state.items=[{id:'peter-provider',lastSync:new Date().toISOString()},{id:'maddie-provider',lastSync:new Date(Date.now()-2*86_400_000).toISOString()}];state.accounts=[{id:'peter-account',itemId:'peter-provider',source:'provider',profileId:'peter',balance:10000},{id:'maddie-account',itemId:'maddie-provider',source:'provider',profileId:'maddie',balance:20000},{id:'joint-account',source:'manual',profileId:'joint',balance:30000},{id:'review-account',source:'manual',balance:40000}];state.transactions=[{id:'peter-txn',accountId:'peter-account',profileId:'peter',date:'2026-01-03',merchant:'Peter grocery',category:'Groceries',categoryId:'system:groceries',amount:1000,currency:'USD'},{id:'maddie-txn',accountId:'maddie-account',profileId:'maddie',date:'2026-01-04',merchant:'Maddie grocery',category:'Groceries',categoryId:'system:groceries',amount:900,currency:'USD'},{id:'joint-txn',accountId:'joint-account',profileId:'joint',date:'2026-01-05',merchant:'Joint utility',category:'Utilities',categoryId:'system:utilities',amount:700,currency:'USD'},{id:'unassigned-txn',accountId:'review-account',date:'2026-01-06',merchant:'Needs review',category:'Groceries',categoryId:'system:groceries',amount:50,currency:'USD'}];state.budgetTemplates=[{categoryId:'system:groceries',effectiveFrom:'2026-01',amount:5000}];state.incomePlanTemplates=[{effectiveFrom:'2026-01',amount:300000}];});
  assert.deepEqual((await profileRepository.queryTransactions({page:1,limit:50,viewProfile:'peter'})).transactions.map(row=>row.id),['peter-txn']);
  assert.deepEqual((await profileRepository.queryTransactions({page:1,limit:50,viewProfile:'maddie'})).transactions.map(row=>row.id),['maddie-txn']);
  assert.deepEqual((await profileRepository.queryTransactions({page:1,limit:50,viewProfile:'joint'})).transactions.map(row=>row.id),['joint-txn']);
  assert.equal((await profileRepository.queryMonthSummary('2026-01','maddie')).current.spend,900);
  assert.equal((await profileRepository.queryMonthSummary('2026-01','joint')).current.spend,700);const peterJanuary=await profileRepository.queryMonthSummary('2026-01','peter');assert.equal(peterJanuary.transactionCount,1,'personal month summary counts only the selected owner’s transactions');assert.deepEqual(peterJanuary.recent.map(row=>row.id),['peter-txn'],'personal month summary recent rows do not leak another owner’s activity');
  const emptyMaddieBudget=await worker.fetch(new Request('https://ledger.sqlite.test/api/budget-summary?month=2026-01&profile=maddie',{headers:{'oai-authenticated-user-id':'synthetic-owner'}}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(emptyMaddieBudget.status,200);assert.deepEqual((await emptyMaddieBudget.json()).budgetTemplates,[],'Maddie does not inherit Peter’s legacy budget fallback');
  const maddieBudgetInput={profileId:'maddie',category:'Groceries',categoryId:'system:groceries',amount:2700,mode:'template',month:'2026-01',revision:(await profileRepository.read()).state.revision};
  const maddieBudgetResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/budget',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify(maddieBudgetInput)}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});
  assert.equal(maddieBudgetResponse.status,200,await maddieBudgetResponse.clone().text());
  assert.equal((await profileRepository.readBudgetState('peter')).state.budgetTemplates.find(row=>row.categoryId==='system:groceries').amount,5000,'Maddie budget edits preserve Peter plan records');
  assert.equal((await profileRepository.readBudgetState('maddie')).state.budgetTemplates.find(row=>row.categoryId==='system:groceries').amount,2700,'Maddie budget edits persist in her independent profile');
  assert.equal((await profileRepository.readBudgetAnalytics('2026-01','maddie')).state.budgetTemplates.find(row=>row.categoryId==='system:groceries').amount,2700,'budget analytics load the selected profile plan');
  const maddieIncomeInput={profileId:'maddie',mode:'template',month:'2026-01',amount:220000,revision:(await profileRepository.read()).state.revision};const maddieIncomeResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/income-plan',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify(maddieIncomeInput)}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(maddieIncomeResponse.status,200,await maddieIncomeResponse.clone().text());assert.equal((await profileRepository.readBudgetState('peter')).state.incomePlanTemplates[0].amount,300000,'Maddie projected income edits preserve Peter income');assert.equal((await profileRepository.readBudgetState('maddie')).state.incomePlanTemplates[0].amount,220000,'projected income plans are stored independently by profile');
  await profileRepository.mutate(state=>{state.lastSync='2026-01-31T12:00:00.000Z';});
  assert.equal((await profileRepository.readBudgetState('peter')).state.budgetTemplates.find(row=>row.categoryId==='system:groceries').amount,5000,'full state writes preserve Peter recurring budgets');
  assert.equal((await profileRepository.readBudgetState('maddie')).state.budgetTemplates.find(row=>row.categoryId==='system:groceries').amount,2700,'full state writes preserve Maddie recurring budgets');
  assert.equal((await profileRepository.readBudgetState('maddie')).state.incomePlanTemplates[0].amount,220000,'full state writes preserve Maddie income plans');
  const householdSummaryResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/household-summary?month=2026-01',{headers:{'oai-authenticated-user-id':'synthetic-owner'}}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});
  assert.equal(householdSummaryResponse.status,200,await householdSummaryResponse.clone().text());const householdSummary=await householdSummaryResponse.json();assert.equal(householdSummary.profiles.peter.actualSpending,1000);assert.equal(householdSummary.profiles.maddie.actualSpending,900);assert.equal(householdSummary.profiles.joint.actualSpending,700);assert.equal(householdSummary.household.actualSpending,2650,'household actual spending includes Peter, Maddie, Joint, and unassigned activity exactly once');assert.equal(householdSummary.ownershipReview.actualSpending,50,'unassigned transaction spending is visible in the ownership review subtotal');assert.equal(householdSummary.freshness.peter.status,'current','household summary reports fresh provider sync per profile');assert.equal(householdSummary.freshness.maddie.status,'stale','household summary identifies a stale provider for its profile');assert.equal(householdSummary.freshness.combined.status,'stale','combined freshness rolls up stale profile providers');assert.equal(householdSummary.profiles.maddie.plannedSpending,2700,JSON.stringify(householdSummary.profiles.maddie));const groceriesSummary=householdSummary.categories.find(row=>row.name==='Groceries');assert.equal(groceriesSummary.profiles.peter.actual,1000);assert.equal(groceriesSummary.profiles.maddie.actual,900);assert.equal(groceriesSummary.household.actual,1950,'category actual includes classified and unassigned profile contributors');assert.equal(groceriesSummary.unassignedActual,50,'category comparison exposes unassigned transaction activity');assert.equal(groceriesSummary.profiles.maddie.planned,2700,'category plan breakdown follows independent profile plan');const profileCategoryCreate=async(profileId,amount)=>{const currentRevision=(await profileRepository.read()).state.revision;const response=await worker.fetch(new Request('https://ledger.sqlite.test/api/category-create',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({name:'Same Named Custom',profileId,amount,month:'2026-01',revision:currentRevision})}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(response.status,200,await response.clone().text());return response.json();};const peterDuplicateCategory=await profileCategoryCreate('peter',1000),maddieDuplicateCategory=await profileCategoryCreate('maddie',700);assert.notEqual(peterDuplicateCategory.category.id,maddieDuplicateCategory.category.id);const duplicateCategorySummaryResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/household-summary?month=2026-01',{headers:{'oai-authenticated-user-id':'synthetic-owner'}}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(duplicateCategorySummaryResponse.status,200,await duplicateCategorySummaryResponse.clone().text());const duplicateCategoryRow=(await duplicateCategorySummaryResponse.json()).categories.filter(row=>row.name==='Same Named Custom');assert.equal(duplicateCategoryRow.length,1,'same-named profile categories share one Combined display row');assert.equal(duplicateCategoryRow[0].household.planned,1700,'same-named category plans remain independent and sum once');assert.equal(duplicateCategoryRow[0].profiles.peter.categoryId,peterDuplicateCategory.category.id);assert.equal(duplicateCategoryRow[0].profiles.maddie.categoryId,maddieDuplicateCategory.category.id);await profileRepository.mutate(state=>state.transactions.push({id:'peter-same-name-spend',accountId:'peter-account',profileId:'peter',date:'2026-01-20',merchant:'Peter same named category',category:'Same Named Custom',categoryId:peterDuplicateCategory.category.id,amount:500,currency:'USD'},{id:'maddie-same-name-spend',accountId:'maddie-account',profileId:'maddie',date:'2026-01-21',merchant:'Maddie same named category',category:'Same Named Custom',categoryId:maddieDuplicateCategory.category.id,amount:300,currency:'USD'}));const actualDuplicateSummary=await worker.fetch(new Request('https://ledger.sqlite.test/api/household-summary?month=2026-01',{headers:{'oai-authenticated-user-id':'synthetic-owner'}}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});const actualDuplicateRow=(await actualDuplicateSummary.json()).categories.find(row=>row.name==='Same Named Custom');assert.equal(actualDuplicateRow.household.actual,800,'same-name household actual is aggregated once across source category IDs');assert.equal(actualDuplicateRow.profiles.peter.actual,500);assert.equal(actualDuplicateRow.profiles.maddie.actual,300);const jointActivityResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/transactions?profile=joint&limit=100&page=1',{headers:{'oai-authenticated-user-id':'synthetic-owner'}}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(jointActivityResponse.status,200);assert.deepEqual((await jointActivityResponse.json()).transactions.map(row=>row.id),['joint-txn'],'Combined’s Joint owner filter returns only shared activity');await profileRepository.mutate(state=>state.transactions.push({id:'peter-feb-txn',accountId:'peter-account',profileId:'peter',date:'2026-02-04',merchant:'Peter only month',category:'Groceries',categoryId:'system:groceries',amount:250,currency:'USD'}));const seriesResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/household-summary?month=2026-02&series=true',{headers:{'oai-authenticated-user-id':'synthetic-owner'}}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(seriesResponse.status,200);const febSeries=(await seriesResponse.json()).monthlySeries.find(row=>row.month==='2026-02');assert.equal(febSeries.household.coverage,'partial-observed','a month with one active owner is shown as partial activity, not omitted or presented as complete');assert.deepEqual(febSeries.household.unknownProfiles.sort(),['joint','maddie']);assert.equal(febSeries.household.spending,250);assert.equal(febSeries.profiles.maddie,null);const reassignmentResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/transaction-owner',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({id:'peter-txn',profileId:'joint',revision:(await profileRepository.read()).state.revision})}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(reassignmentResponse.status,200,await reassignmentResponse.clone().text());assert.deepEqual((await profileRepository.queryTransactions({page:1,limit:50,viewProfile:'peter'})).transactions.map(row=>row.id),['peter-feb-txn','peter-same-name-spend'],'transaction owner override removes the reassigned row while retaining Peter’s other transactions');assert.deepEqual((await profileRepository.queryTransactions({page:1,limit:50,viewProfile:'joint'})).transactions.map(row=>row.id).sort(),['joint-txn','peter-txn'],'transaction override adds the row to the chosen profile');assert.equal((await profileRepository.read()).state.transactions.find(row=>row.id==='peter-txn').profileAttributionHistory.at(-1).actor,'synthetic-owner','owner reassignment records the authenticated actor');assert.equal((await profileRepository.queryMonthSummary('2026-01','combined')).current.spend,3450,'owner reassignment preserves household spending including same-name category activity');
  const ownershipUndoCreate=await worker.fetch(new Request('https://ledger.sqlite.test/api/manual-account',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({name:'Undo persistence fixture',type:'asset',profileId:'maddie',balance:5000,asOf:'2026-10-01',currency:'USD',revision:(await profileRepository.read()).state.revision})}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(ownershipUndoCreate.status,200,await ownershipUndoCreate.clone().text());const ownershipUndoCreated=await ownershipUndoCreate.json();const manualMove=await worker.fetch(new Request('https://ledger.sqlite.test/api/manual-account',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({id:ownershipUndoCreated.account.id,name:ownershipUndoCreated.account.name,type:'asset',profileId:'peter',balance:5000,asOf:'2026-10-01',currency:'USD',revision:(await profileRepository.read()).state.revision})}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(manualMove.status,200,await manualMove.clone().text());const manualMoveBody=await manualMove.json();assert.ok(manualMoveBody.ownershipBatchId);await profileRepository.close();
  profileRepository=await createSqliteRepositoryAt(join(directory,'profiles.sqlite'));const persistedUndo=await worker.fetch(new Request('https://ledger.sqlite.test/api/account-ownership-undo',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({batchId:manualMoveBody.ownershipBatchId,revision:(await profileRepository.read()).state.revision})}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(persistedUndo.status,200,await persistedUndo.clone().text());assert.equal((await profileRepository.read()).state.accounts.find(account=>account.id===ownershipUndoCreated.account.id).profileId,'maddie','ownership undo batch survives SQLite reopen and restores its owner');
  await profileRepository.mutate(state=>{state.categoryRecords=[...(state.categoryRecords||[]),{id:'sqlite-owner-category',name:'SQLite owner category',normalizedName:'sqlite owner category',kind:'expense',system:false,profileId:'peter',order:100,archivedAt:null}];state.transactions.push({id:'sqlite-owner-category-transaction',accountId:'peter-account',date:'2026-01-20',merchant:'Synthetic owner guard',amount:100,currency:'USD',category:'SQLite owner category',categoryId:'sqlite-owner-category'});});
  const ownerGuardState=(await profileRepository.read()).state,ownerGuardPost=await worker.fetch(new Request('https://ledger.sqlite.test/api/account-update',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({id:'peter-account',action:'ownership',profileId:'maddie',revision:ownerGuardState.revision})}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(ownerGuardPost.status,409,'SQLite ownership mutation sees transaction relationships instead of treating unloaded transactions as absent');assert.equal((await profileRepository.read()).state.accounts.find(row=>row.id==='peter-account').profileId,'peter','blocked SQLite ownership change leaves the owner intact');
  const allocationAccountResponse=await worker.fetch(new Request('https://ledger.sqlite.test/api/manual-account',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({name:'Goal undo account',type:'asset',profileId:'peter',balance:50000,asOf:'2026-10-30',currency:'USD',revision:(await profileRepository.read()).state.revision})}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(allocationAccountResponse.status,200,await allocationAccountResponse.clone().text());const allocationAccount=(await allocationAccountResponse.json()).account;
  await profileRepository.mutate(state=>{state.goals=[...(state.goals||[]),{id:'sqlite-goal-undo',name:'SQLite goal undo',target:100000,targetDate:'2027-10-30',profileId:'peter',priority:1,monthlyContribution:0,apyBps:0}];state.goalAllocations=[...(state.goalAllocations||[]),{id:'sqlite-goal-undo-prior',goalId:'sqlite-goal-undo',profileId:'peter',accountId:allocationAccount.id,amount:10000,active:true}];});
  const allocationRemove=await worker.fetch(new Request('https://ledger.sqlite.test/api/goal-allocations',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({goalId:'sqlite-goal-undo',allocations:[],revision:(await profileRepository.read()).state.revision})}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(allocationRemove.status,200,await allocationRemove.clone().text());const allocationBatch=(await allocationRemove.json()).batchId;
  const allocationAccountMove=await worker.fetch(new Request('https://ledger.sqlite.test/api/manual-account',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({id:allocationAccount.id,name:allocationAccount.name,type:'asset',profileId:'maddie',balance:50000,asOf:'2026-10-30',currency:'USD',revision:(await profileRepository.read()).state.revision})}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(allocationAccountMove.status,200,await allocationAccountMove.clone().text());
  const rejectedAllocationUndo=await worker.fetch(new Request('https://ledger.sqlite.test/api/goal-allocation-undo',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':'synthetic-owner'},body:JSON.stringify({batchId:allocationBatch,revision:(await profileRepository.read()).state.revision,clientOperationId:'00000000-0000-4000-8000-000000000015'})}),{REPOSITORY:profileRepository,LOCAL_ONLY:true});assert.equal(rejectedAllocationUndo.status,409,'SQLite allocation undo cannot restore a Peter goal allocation onto an account reassigned to Maddie');const rejectedAllocationState=(await profileRepository.read()).state;assert.equal(rejectedAllocationState.goalAllocations.find(row=>row.id==='sqlite-goal-undo-prior').active,false,'rejected allocation undo leaves the prior allocation inactive');assert.equal(rejectedAllocationState.goalAllocationLedger.find(row=>row.id===allocationBatch).undoneAt,null,'rejected allocation undo leaves the ledger available for review');
  await profileRepository.close();

  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name IN ('transactions_date_id_idx','transactions_account_date_id_idx','transactions_item_date_id_idx','transactions_budget_analytics_idx')").get().count,4,'schema migration creates the date/account/item page indexes and covering budget analytics index');
  db.close();

  const backupPath = join(directory, 'verified.sqlite');
  const backupResult = spawnSync(process.execPath, ['scripts/sqlite-backup.mjs', databasePath, backupPath], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(backupResult.status, 0, backupResult.stderr);
  assert.equal(JSON.parse(backupResult.stdout).ok, true);
  assert.equal(JSON.parse(backupResult.stdout).schemaVersion, 9, 'backup manifest reports the database schema it contains');
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  const restoredPath = join(directory, 'restored.sqlite');
  const restoreResult = spawnSync(process.execPath, ['scripts/sqlite-restore.mjs', backupPath, restoredPath], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(restoreResult.status, 0, restoreResult.stderr);
  const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 1);
  assert.equal(restored.prepare("SELECT amount FROM budget_templates WHERE category_id='system:groceries' AND effective_from='2026-10'").get().amount,73000,'the scoped budget edit survives backup and restore');
  assert.equal(restored.prepare('SELECT amount FROM monthly_budgets').get().amount,0);
  assert.equal(restored.prepare("SELECT json_extract(payload_json, '$.override') AS value FROM transactions").get().value, 'Travel');
  restored.close();

  const importKey = randomBytes(32);
  const tokenIv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', importKey, tokenIv);
  const ciphertext = Buffer.concat([cipher.update('synthetic-access-token'), cipher.final(), cipher.getAuthTag()]);
  const encoded = value => value.toString('base64');
  const legacyPath = join(directory, 'legacy-state.json');
  const configPath = join(directory, 'private-config.json');
  const importedPath = join(directory, 'imported.sqlite');
  await writeFile(legacyPath, JSON.stringify({ version: 1, owner: null, items: [{ id: 'legacy-item', token: { iv: encoded(tokenIv), data: encoded(ciphertext) }, cursor: 'cursor-legacy' }], accounts: [{ id: 'legacy-account', itemId: 'legacy-item' }], transactions: [{ id: 'legacy-transaction', accountId: 'legacy-account', itemId: 'legacy-item', amount: 1, date: '2026-01-01', override: 'Travel' }], budgets: { Travel: 5 } }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ tokenEncryptionKey: encoded(importKey), plaidEnv: 'production' }), { mode: 0o600 });
  await chmod(legacyPath, 0o600); await chmod(configPath, 0o600);
  const importer = ['scripts/import-legacy-json.mjs', legacyPath, importedPath, configPath];
  const firstImport = spawnSync(process.execPath, importer, { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(firstImport.status, 0, firstImport.stderr);
  const firstSummary = JSON.parse(firstImport.stdout);
  assert.equal(firstSummary.verifiedEncryptedTokens, 1);
  assert.equal(firstSummary.environmentUnspecifiedItems, 1, 'deployment environment is not guessed for legacy items');
  assert.equal((await stat(importedPath)).mode & 0o777, 0o600);
  const secondImport = spawnSync(process.execPath, importer, { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(secondImport.status, 0, secondImport.stderr);
  assert.equal(JSON.parse(secondImport.stdout).imported, false, 'same-source reruns are idempotent');
  const importedDb = new Database(importedPath, { readonly: true, fileMustExist: true });
  const importedItem = JSON.parse(importedDb.prepare('SELECT payload_json FROM items').get().payload_json);
  assert.equal(importedItem.environment, undefined);
  assert.equal(importedItem.token.data, encoded(ciphertext));
  assert.equal(importedItem.cursor, 'cursor-legacy');
  assert.equal(importedDb.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 1);
  assert.equal(importedDb.prepare('SELECT amount FROM budgets WHERE category=?').get('Travel').amount, 5);
  importedDb.close();

  const metadataOnlyPath = join(directory, 'metadata-only.sqlite');
  const metadataOnlyDb = await openLedgerDatabase(metadataOnlyPath);
  metadataOnlyDb.prepare('INSERT INTO state_meta(singleton,payload_json) VALUES(1,?)').run(JSON.stringify({version:1,goals:[{id:'preserve-me'}]}));
  const metadataOnlyRepository = createSqliteRepository(metadataOnlyDb);
  await assert.rejects(metadataOnlyRepository.importLegacyState({items:[],accounts:[],transactions:[],holdings:[],budgets:{},customCategories:[]}, 'synthetic-different-source'), /already contains records/);
  assert.deepEqual((await metadataOnlyRepository.read()).state.goals, [{id:'preserve-me'}], 'metadata-only entities prevent an import from overwriting them');
  await metadataOnlyRepository.close();

  const splitReportRepository=await createSqliteRepositoryAt(join(directory,'split-report.sqlite'));await splitReportRepository.mutate(state=>{state.transactions=[{id:'parent',accountId:'cash',date:'2026-10-10',amount:10000,currency:'USD',category:'Other',categoryId:'system:other'}];state.transactionSplits=[{id:'split',transactionId:'parent',parentAmount:10000,parentDate:'2026-10-10',parentAccountId:'cash',parentCurrency:'USD',allocations:[{id:'s1',categoryId:'system:groceries',amount:6000},{id:'s2',categoryId:'system:dining',amount:4000}]}];});const splitMonth=(await splitReportRepository.queryMonthSummary('2026-10')).current;assert.equal(splitMonth.spend,10000);assert.deepEqual(splitMonth.categories,{Groceries:6000,Dining:4000},'SQLite Overview counts split allocations instead of the parent category');await splitReportRepository.close();
  const orderingRepository=await createSqliteRepositoryAt(join(directory,'ordering.sqlite'));
  await orderingRepository.mutate(state=>{state.transactions=[{id:'z-last',date:'2026-10-25',merchant:'Same day Z',amount:200,currency:'USD',category:'Dining'},{id:'a-first',date:'2026-10-25',merchant:'Same day A',amount:300,currency:'USD',category:'Dining'},{id:'refund',date:'2026-10-24',merchant:'Refund',amount:-50,currency:'USD',category:'Dining'},{id:'pending',date:'2026-10-24',merchant:'Pending',amount:500,currency:'USD',category:'Dining',pending:true}];});
  const orderedPage=await orderingRepository.queryTransactions({page:1,limit:3,from:'2026-10-01',to:'2026-10-31'});
  assert.deepEqual(orderedPage.transactions.map(row=>row.id),['a-first','z-last','pending'],'same-day transaction pages have stable ID ordering');
  const completeSummary=await orderingRepository.queryMonthSummary('2026-10');
  assert.equal(completeSummary.current.spend,450,'monthly summaries include every matching posted record including refunds and exclude pending rows');
  assert.equal(completeSummary.transactionCount,4);
  await orderingRepository.close();

  const effectiveCategoryRepository=await createSqliteRepositoryAt(join(directory,'effective-category.sqlite'));
  await effectiveCategoryRepository.mutate(state=>{state.transactions=[
    {id:'source-groceries',accountId:'synthetic-checking',date:'2026-10-23',merchant:'Synthetic unchanged groceries',amount:100,currency:'USD',category:'Groceries',categoryId:'system:groceries'},
    {id:'override-dining',accountId:'synthetic-checking',date:'2026-10-25',merchant:'Synthetic overridden dining',amount:200,currency:'USD',category:'Groceries',categoryId:'system:groceries',override:'Dining',overrideCategoryId:'system:dining'},
    {id:'legacy-dining',accountId:'synthetic-checking',date:'2026-10-24',merchant:'Synthetic legacy dining',amount:300,currency:'USD',category:'Groceries',override:'Dining'},
    {id:'empty-override',accountId:'synthetic-checking',date:'2026-10-22',merchant:'Synthetic empty override',amount:400,currency:'USD',category:'Groceries',categoryId:'system:groceries',override:'',overrideCategoryId:'system:dining'},
    {id:'renamed-custom',accountId:'synthetic-checking',date:'2026-10-21',merchant:'Synthetic renamed custom',amount:500,currency:'USD',category:'Old custom name',categoryId:'custom:stable',override:'New custom name',overrideCategoryId:'custom:stable'}
  ];});
  const categoryIds=async(category,options={})=>(await effectiveCategoryRepository.queryTransactions({page:1,limit:50,...options,category})).transactions.map(row=>row.id);
  assert.deepEqual(await categoryIds('Groceries'),['source-groceries','empty-override'],'effective Groceries name excludes rows currently overridden to another category');
  assert.deepEqual(await categoryIds('system:groceries'),['source-groceries','empty-override'],'effective source category ID is used when there is no nonempty override');
  assert.deepEqual(await categoryIds('Dining'),['override-dining','legacy-dining'],'legacy label-only and ID-backed overrides match their displayed category');
  assert.deepEqual(await categoryIds('system:dining'),['override-dining'],'override category IDs do not include source-category matches');
  assert.deepEqual(await categoryIds('Old custom name'),[],'a renamed transaction does not remain under its previous source label');
  assert.deepEqual(await categoryIds('New custom name'),['renamed-custom']);
  assert.deepEqual(await categoryIds('custom:stable'),['renamed-custom'],'renamed custom category identity remains filterable by ID');
  const filteredSecondPage=await effectiveCategoryRepository.queryTransactions({page:2,limit:1,category:'Dining',search:'synthetic',accountId:'synthetic-checking',from:'2026-10-01',to:'2026-10-31'});
  assert.equal(filteredSecondPage.total,2,'filtered total counts only the two effective Dining rows');assert.deepEqual(filteredSecondPage.transactions.map(row=>row.id),['legacy-dining'],'effective category filtering composes with search/account/date filters and paging');
  await effectiveCategoryRepository.close();

  const budgetPersistencePath=join(directory,'budget-template-persistence.sqlite'),budgetMonthParts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit'}).formatToParts(new Date()),budgetCurrentMonth=budgetMonthParts.find(part=>part.type==='year').value+'-'+budgetMonthParts.find(part=>part.type==='month').value,budgetPriorDate=new Date(budgetCurrentMonth+'-01T12:00:00Z');budgetPriorDate.setUTCMonth(budgetPriorDate.getUTCMonth()-1);const budgetPriorMonth=budgetPriorDate.toISOString().slice(0,7),budgetCategoryId='custom:budget-persistence';
  const budgetPersistenceRepository=await createSqliteRepositoryAt(budgetPersistencePath);
  await budgetPersistenceRepository.mutate(state=>{state.categoryRecords=[{id:budgetCategoryId,name:'Current Budget Name',normalizedName:'current budget name',kind:'expense',system:false,order:20,archivedAt:null}];state.customCategories=['Current Budget Name'];state.budgets={'Current Budget Name':10000};state.budgetHistoryUnavailableBefore=budgetPriorMonth;state.budgetTemplates=[{categoryId:budgetCategoryId,amount:10000,effectiveFrom:budgetCurrentMonth}];state.budgetTemplateSchedules={[`${budgetCategoryId}:${budgetCurrentMonth}`]:{frequency:'annual',dueMonth:11,sourceAmount:120000}};state.monthlyBudgets={[`${budgetPriorMonth}:${budgetCategoryId}`]:0};state.monthlyBudgetSchedules={[`${budgetPriorMonth}:${budgetCategoryId}`]:{frequency:'monthly',dueMonth:null,sourceAmount:0}};});
  await budgetPersistenceRepository.close();
  const reopenedBudgetRepository=await createSqliteRepositoryAt(budgetPersistencePath),reopenedBudgetState=(await reopenedBudgetRepository.read()).state;
  assert.deepEqual(reopenedBudgetState.budgetTemplates,[{categoryId:budgetCategoryId,amount:10000,effectiveFrom:budgetCurrentMonth}],'explicit category budget template survives SQLite close and reopen');
  assert.equal(reopenedBudgetState.monthlyBudgets[`${budgetPriorMonth}:${budgetCategoryId}`],0,'SQLite preserves explicit zero month overrides alongside templates');
  assert.deepEqual(reopenedBudgetState.budgetTemplateSchedules[`${budgetCategoryId}:${budgetCurrentMonth}`],{frequency:'annual',dueMonth:11,sourceAmount:120000},'SQLite preserves schedule metadata with its effective template');
  assert.deepEqual(reopenedBudgetState.monthlyBudgetSchedules[`${budgetPriorMonth}:${budgetCategoryId}`],{frequency:'monthly',dueMonth:null,sourceAmount:0},'SQLite preserves schedule metadata for a zero month override');
  await reopenedBudgetRepository.mutate(state=>{state.categoryRecords[0]={...state.categoryRecords[0],name:'Renamed Budget'};state.customCategories=['Renamed Budget'];state.budgets={'Renamed Budget':10000};});
  await reopenedBudgetRepository.close();
  const renamedBudgetRepository=await createSqliteRepositoryAt(budgetPersistencePath),renamedBudgetState=(await renamedBudgetRepository.read()).state;
  assert.equal(renamedBudgetState.categoryRecords[0].name,'Renamed Budget');
  assert.deepEqual(renamedBudgetState.budgetTemplates,[{categoryId:budgetCategoryId,amount:10000,effectiveFrom:budgetCurrentMonth}],'stable category identity keeps its explicit template through rename and SQLite reopen');
  assert.equal(renamedBudgetState.budgetHistoryUnavailableBefore,budgetPriorMonth,'SQLite retains the legacy history boundary');
  await renamedBudgetRepository.close();

  const allProfilePersistencePath=join(directory,'all-profile-full-save.sqlite'),allProfilePersistenceRepository=await createSqliteRepositoryAt(allProfilePersistencePath),allProfileRecords=[
    {categoryId:'system:groceries',effectiveMonth:'2026-10',scope:'recurring',profileId:'peter',monthlyCents:12300,sourceCents:12300,frequency:'monthly',dueMonth:null},
    {categoryId:'system:groceries',effectiveMonth:'2026-10',scope:'recurring',profileId:'maddie',monthlyCents:45600,sourceCents:547200,frequency:'annual',dueMonth:5},
    {categoryId:'system:groceries',effectiveMonth:'2026-10',scope:'month',profileId:'joint',monthlyCents:0,sourceCents:0,frequency:'monthly',dueMonth:null},
    {categoryId:'system:housing',effectiveMonth:'2026-11',scope:'recurring',profileId:'joint',monthlyCents:null,sourceCents:null,frequency:'monthly',dueMonth:null}
  ],allProfilePlans={
    peter:{incomePlanTemplates:[{effectiveFrom:'2026-10',amount:500000}],monthlyIncomePlans:{'2026-11':490000},monthlyBudgetOutlooks:{'2026-10':{income:{expectedTotal:510000}}}},
    maddie:{incomePlanTemplates:[{effectiveFrom:'2026-10',amount:420000}],monthlyIncomePlans:{'2026-11':410000},monthlyBudgetOutlooks:{'2026-10':{income:{expectedTotal:430000}}}},
    joint:{incomePlanTemplates:[{effectiveFrom:'2026-10',amount:25000}],monthlyIncomePlans:{'2026-11':30000},monthlyBudgetOutlooks:{'2026-10':{income:{expectedTotal:35000}}}}
  };
  await allProfilePersistenceRepository.mutate(state=>{state.budgetRecords=allProfileRecords;state.incomePlanTemplates=allProfilePlans.peter.incomePlanTemplates;state.monthlyIncomePlans=allProfilePlans.peter.monthlyIncomePlans;state.monthlyBudgetOutlooks=allProfilePlans.peter.monthlyBudgetOutlooks;state.profilePlanState=allProfilePlans;});
  assert.deepEqual((await allProfilePersistenceRepository.read()).state.profilePlanState,allProfilePlans,'initial complete-state write stores all three profile plans');
  await allProfilePersistenceRepository.mutate(state=>{assert.deepEqual(state.profilePlanState,allProfilePlans,'full-state loader provides every profile plan before an unrelated mutation');assert.deepEqual(state.incomePlanTemplates,allProfilePlans.peter.incomePlanTemplates,'full-state loader exposes Peter plan projection');state.lastSync='2026-10-30T12:00:00.000Z';});
  await allProfilePersistenceRepository.close();const allProfilePersistenceReopened=await createSqliteRepositoryAt(allProfilePersistencePath),allProfilePersistedState=(await allProfilePersistenceReopened.read()).state,sortedProfileRecords=(rows)=>rows.slice().sort((a,b)=>a.profileId.localeCompare(b.profileId)||a.effectiveMonth.localeCompare(b.effectiveMonth)||a.categoryId.localeCompare(b.categoryId)||a.scope.localeCompare(b.scope));assert.deepEqual(sortedProfileRecords(allProfilePersistedState.budgetRecords),sortedProfileRecords(allProfileRecords),'an unrelated full-state save and SQLite reopen preserve all owners, zero overrides, null stops, annual frequency, and source values');assert.deepEqual(allProfilePersistedState.profilePlanState,allProfilePlans,'full-state save and reopen preserve independent Peter, Maddie, and Joint income/outlook plans');await allProfilePersistenceReopened.close();

  const legacyDatabase=join(directory,'schema-v1.sqlite');
  const oldDb=new Database(legacyDatabase);
  oldDb.exec(await readFile(new URL('../server/migrations/001-initial.sql',import.meta.url),'utf8'));
  oldDb.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)').run(new Date().toISOString());
  oldDb.close();
  const migrated=await openLedgerDatabase(legacyDatabase);
  assert.equal(migrated.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,9);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='monthly_budgets'").get().count,1);
  migrated.close();
  const migrationBackupDirectory=join(directory,'backups');
  const migrationBackups=(await readdir(migrationBackupDirectory)).filter(name=>name.endsWith('.sqlite'));
  assert.equal(migrationBackups.length,1);
  assert.equal((await stat(migrationBackupDirectory)).mode & 0o777,0o700);
  const preMigrationBackupPath=join(migrationBackupDirectory,migrationBackups[0]);
  assert.equal((await stat(preMigrationBackupPath)).mode & 0o777,0o600);
  const preMigrationBackup=new Database(preMigrationBackupPath,{readonly:true,fileMustExist:true});
  assert.equal(preMigrationBackup.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(preMigrationBackup.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,1,'backup captured the old schema before applying migration 002');
  preMigrationBackup.close();

  const migration3Directory=join(directory,'version-3-migration');await mkdir(migration3Directory,{mode:0o700});
  const migration3Path=join(migration3Directory,'ledger.sqlite'),migration3Db=new Database(migration3Path);
  for(const [version,file] of [[1,'001-initial.sql'],[2,'002-monthly-budgets.sql'],[3,'003-transaction-query-indexes.sql']]){migration3Db.exec(await readFile(new URL(`../server/migrations/${file}`,import.meta.url),'utf8'));migration3Db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(version,new Date().toISOString());}
  const legacyReplay={id:'f4248bc1-e924-4db0-a726-616e4ac340f6',fingerprint:'manual-account\n{"amount":1,"revision":7}',response:{ok:true,revision:8},createdAt:'2026-10-28T12:00:00.000Z'};
  migration3Db.prepare('INSERT INTO state_meta(singleton,payload_json) VALUES(1,?)').run(JSON.stringify({version:1,owner:'synthetic-migration-owner',revision:7,operationResults:[legacyReplay],incomePlanTemplates:[{effectiveFrom:'2026-10',amount:500000}],monthlyIncomePlans:{'2026-11':480000},monthlyBudgetOutlooks:{'2026-10':{income:{expectedTotal:470000}}},budgetTemplateSchedules:{'custom:annual:2026-10':{frequency:'annual',dueMonth:11,sourceAmount:120000}},monthlyBudgetSchedules:{'2026-10:custom:zero':{frequency:'monthly',dueMonth:null,sourceAmount:0}}}));
  migration3Db.prepare('INSERT INTO budget_templates(category_id,effective_from,amount) VALUES(?,?,?)').run('custom:annual','2026-10',10000);
  migration3Db.prepare('INSERT INTO monthly_budgets(month,category_id,amount) VALUES(?,?,?)').run('2026-10','custom:zero',0);
  migration3Db.prepare('INSERT INTO accounts(id,item_id,payload_json) VALUES(?,?,?)').run('migration-3-account',null,JSON.stringify({id:'migration-3-account',name:'Legacy account'}));migration3Db.prepare('INSERT INTO transactions(id,account_id,item_id,payload_json) VALUES(?,?,?,?)').run('migration-3-transaction','migration-3-account',null,JSON.stringify({id:'migration-3-transaction',date:'2026-10-01',amount:1234,currency:'USD',category:'Groceries'}));migration3Db.close();
  const migrated3=await openLedgerDatabase(migration3Path);
  assert.equal(migrated3.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,9,'version-3 databases migrate additively to the current schema');
  assert.equal(migrated3.prepare('SELECT id FROM transactions').get().id,'migration-3-transaction','version-3 migration preserves existing transaction identity');
  assert.deepEqual(migrated3.prepare('SELECT id,label FROM household_profiles ORDER BY id').all(),[{id:'joint',label:'Joint'},{id:'maddie',label:'Maddie'},{id:'peter',label:'Peter'}],'profile migration creates the three stable household buckets');
  assert.equal(JSON.parse(migrated3.prepare('SELECT payload_json FROM accounts WHERE id=?').get('migration-3-account').payload_json).profileId,'peter','legacy accounts receive provisional Peter ownership');
  assert.equal(Object.hasOwn(JSON.parse(migrated3.prepare('SELECT payload_json FROM transactions WHERE id=?').get('migration-3-transaction').payload_json),'profileId'),false,'legacy transactions inherit account attribution instead of receiving a false explicit override');
  assert.deepEqual(JSON.parse(migrated3.prepare("SELECT income_templates_json FROM household_plan_state WHERE profile_id='peter'").get().income_templates_json),[{effectiveFrom:'2026-10',amount:500000}],'legacy projected income is migrated to Peter');assert.deepEqual(JSON.parse(migrated3.prepare("SELECT monthly_income_json FROM household_plan_state WHERE profile_id='maddie'").get().monthly_income_json),{},'Maddie starts with an empty independent income plan');
  assert.equal(migrated3.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='transactions_budget_analytics_idx'").get().count,1,'version-3 migration creates the covering analytics index');
  const migratedReplay=migrated3.prepare('SELECT scope,payload_digest,response_json,revision FROM operation_results WHERE operation_id=?').get(legacyReplay.id);
  assert.equal(migratedReplay.scope,'manual-account');assert.equal(migratedReplay.payload_digest,createHash('sha256').update(legacyReplay.fingerprint).digest('hex'));assert.deepEqual(JSON.parse(migratedReplay.response_json),legacyReplay.response);assert.equal(migratedReplay.revision,8);
  const canonicalAnnual=migrated3.prepare("SELECT monthly_cents,source_cents,frequency,due_month FROM budget_records WHERE category_id='custom:annual'").get();assert.deepEqual(canonicalAnnual,{monthly_cents:10000,source_cents:120000,frequency:'annual',due_month:11},'legacy amount and schedule migrate together without changing the annual source amount');
  assert.equal(migrated3.prepare("SELECT profile_id FROM budget_records WHERE category_id='custom:annual'").get().profile_id,'peter','legacy budgets migrate under Peter');
  const canonicalZero=migrated3.prepare("SELECT monthly_cents,source_cents,frequency FROM budget_records WHERE category_id='custom:zero'").get();assert.deepEqual(canonicalZero,{monthly_cents:0,source_cents:0,frequency:'monthly'},'a known zero survives the budget-record migration');
  const migratedMeta=JSON.parse(migrated3.prepare('SELECT payload_json FROM state_meta').get().payload_json);assert.equal(Object.hasOwn(migratedMeta,'operationResults'),false,'legacy raw fingerprints are removed only after indexed insertion');assert.equal(Object.hasOwn(migratedMeta,'budgetTemplateSchedules'),false,'budget schedule metadata is moved out of the JSON state');migrated3.close();
  const migratedBudgetRepository=await createSqliteRepositoryAt(migration3Path),migratedBudgetState=(await migratedBudgetRepository.read()).state;assert.deepEqual(migratedBudgetState.budgetTemplates,[{categoryId:'custom:annual',effectiveFrom:'2026-10',amount:10000}]);assert.deepEqual(migratedBudgetState.budgetTemplateSchedules['custom:annual:2026-10'],{frequency:'annual',dueMonth:11,sourceAmount:120000});assert.equal(migratedBudgetState.monthlyBudgets['2026-10:custom:zero'],0);assert.equal(migratedBudgetState.monthlyBudgetSchedules['2026-10:custom:zero'].sourceAmount,0);await migratedBudgetRepository.close();
  const migration3Backups=(await readdir(join(migration3Directory,'backups'))).filter(name=>name.endsWith('.sqlite'));assert.equal(migration3Backups.length,1);
  const migration3Backup=new Database(join(migration3Directory,'backups',migration3Backups[0]),{readonly:true,fileMustExist:true});assert.equal(migration3Backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,3,'automatic rollback copy preserves the pre-v4 database');assert.equal(migration3Backup.prepare('SELECT id FROM transactions').get().id,'migration-3-transaction');migration3Backup.close();

  const profileMigrationPath=join(directory,'profile-migration-retry.sqlite'),profileMigrationDb=new Database(profileMigrationPath);
  for(const file of ['001-initial.sql','002-monthly-budgets.sql','003-transaction-query-indexes.sql','004-budget-analytics-index.sql','005-operation-results.sql','006-budget-records.sql','007-budget-history.sql']){const version=Number(file.slice(0,3));profileMigrationDb.exec(await readFile(new URL(`../server/migrations/${file}`,import.meta.url),'utf8'));profileMigrationDb.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(version,new Date().toISOString());}
  profileMigrationDb.prepare('INSERT INTO state_meta(singleton,payload_json) VALUES(1,?)').run(JSON.stringify({version:1,incomePlanTemplates:[{effectiveFrom:'2026-10',amount:345600}],monthlyIncomePlans:{'2026-11':320000},monthlyBudgetOutlooks:{'2026-10':{income:{expectedTotal:330000}}}}));profileMigrationDb.prepare('INSERT INTO accounts(id,item_id,payload_json) VALUES(?,?,?)').run('profile-retry-account',null,JSON.stringify({id:'profile-retry-account',name:'Legacy migration account'}));profileMigrationDb.exec("CREATE TRIGGER block_profile_migration_marker BEFORE INSERT ON schema_migrations WHEN NEW.version=8 BEGIN SELECT RAISE(ABORT,'synthetic profile migration interruption'); END;");profileMigrationDb.close();
  await assert.rejects(openLedgerDatabase(profileMigrationPath),/synthetic profile migration interruption/,'a failed profile migration marker aborts the schema/data conversion transaction');
  const failedProfileMigration=new Database(profileMigrationPath,{readonly:true,fileMustExist:true});assert.equal(failedProfileMigration.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,7,'interrupted profile migration remains at the prior schema version');assert.equal(failedProfileMigration.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='household_profiles'").get().count,0,'interrupted profile migration rolls back its household tables');assert.equal(JSON.parse(failedProfileMigration.prepare("SELECT payload_json FROM accounts WHERE id='profile-retry-account'").get().payload_json).profileId,undefined,'interrupted conversion leaves legacy account attribution untouched');failedProfileMigration.close();
  const retryProfileMigration=new Database(profileMigrationPath);retryProfileMigration.exec('DROP TRIGGER block_profile_migration_marker');retryProfileMigration.close();
  const completedProfileMigration=await openLedgerDatabase(profileMigrationPath);assert.equal(completedProfileMigration.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,9);const convertedProfileMeta=JSON.parse(completedProfileMigration.prepare('SELECT payload_json FROM state_meta').get().payload_json);assert.equal(convertedProfileMeta.householdProfileMigrationComplete,true,'successful retry records the durable conversion marker');assert.equal(JSON.parse(completedProfileMigration.prepare("SELECT payload_json FROM accounts WHERE id='profile-retry-account'").get().payload_json).profileId,'peter','successful retry converts the legacy account exactly once');assert.deepEqual(JSON.parse(completedProfileMigration.prepare("SELECT income_templates_json FROM household_plan_state WHERE profile_id='peter'").get().income_templates_json),[{effectiveFrom:'2026-10',amount:345600}],'successful retry migrates the legacy plan into Peter');assert.deepEqual(JSON.parse(completedProfileMigration.prepare("SELECT income_templates_json FROM household_plan_state WHERE profile_id='maddie'").get().income_templates_json),[],'successful retry leaves Maddie independent');completedProfileMigration.close();

  const futureSchemaPath=join(directory,'future-schema.sqlite'),futureSchema=new Database(futureSchemaPath);
  futureSchema.pragma('journal_mode = DELETE');futureSchema.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL); CREATE TABLE future_data(value TEXT);');
  futureSchema.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(10,?)').run(new Date().toISOString());futureSchema.prepare('INSERT INTO future_data(value) VALUES(?)').run('preserved');futureSchema.close();
  await assert.rejects(openLedgerDatabase(futureSchemaPath),/newer than this application supports/);
  const afterFutureRefusal=new Database(futureSchemaPath,{readonly:true,fileMustExist:true});assert.equal(afterFutureRefusal.pragma('journal_mode',{simple:true}),'delete','future-schema refusal does not change the database journal mode');assert.equal(afterFutureRefusal.prepare('SELECT value FROM future_data').get().value,'preserved');afterFutureRefusal.close();

  const invalidHistoryPath=join(directory,'invalid-history.sqlite'),invalidHistory=new Database(invalidHistoryPath);
  invalidHistory.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);');invalidHistory.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)').run(new Date().toISOString());invalidHistory.close();
  await assert.rejects(openLedgerDatabase(invalidHistoryPath),/migration history is inconsistent/);
  const unversionedPath=join(directory,'unversioned.sqlite'),unversioned=new Database(unversionedPath);unversioned.exec('CREATE TABLE unrelated(value TEXT);');unversioned.close();
  await assert.rejects(openLedgerDatabase(unversionedPath),/without migration history/);

  const rollbackPath=join(directory,'atomic-migration.sqlite'),rollbackDb=new Database(rollbackPath);
  rollbackDb.exec(await readFile(new URL('../server/migrations/001-initial.sql',import.meta.url),'utf8'));
  rollbackDb.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)').run(new Date().toISOString());
  rollbackDb.exec("CREATE TRIGGER block_schema_v2 BEFORE INSERT ON schema_migrations WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'synthetic migration interruption'); END;");rollbackDb.close();
  await assert.rejects(openLedgerDatabase(rollbackPath),/synthetic migration interruption/);
  const rolledBack=new Database(rollbackPath,{readonly:true,fileMustExist:true});assert.equal(rolledBack.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='monthly_budgets'").get().count,0,'failed DDL is rolled back with its migration version');assert.equal(rolledBack.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,1);rolledBack.close();

  console.log('SQLite ARM64 runtime, constraints, import preservation/idempotency, schema compatibility, atomic migration, automatic migration backup, backup and restore passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
