import { isAllocationTransaction, transactionMatchesCategory } from '../shared/categories.mjs';
import { addSafeCents } from '../shared/reporting.mjs';
import { applyTransactionSplitsToRows } from '../shared/transaction-splits.mjs';

export const STATE_KEY = 'finance/owner-v1.json';

export const blankState = () => ({
  version: 1,
  owner: null,
  items: [],
  accounts: [],
  transactions: [],
  holdings: [],
  goals: [],
  goalAllocations: [],
  goalAllocationLedger: [],
  properties: [],
  mortgages: [],
  mortgageSnapshots: [],
  scenarios: [],
  balanceSheetSnapshots: [],
  customCategories: [],
  budgets: {},
  budgetChangeHistory: [],
  lastSync: null,
  lease: null
});

export function createStateRepository(store) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') {
    throw new TypeError('State storage must provide get and conditional put methods.');
  }

  async function read() {
    const object = await store.get(STATE_KEY);
    return { state: object ? await object.json() : blankState(), etag: object?.etag };
  }

  async function mutate(update) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { state, etag } = await read();
      await update(state);
      if(state._pendingBudgetHistory?.length)state.budgetChangeHistory=[...(state.budgetChangeHistory||[]),...state._pendingBudgetHistory];
      delete state._pendingBudgetHistory;
      const saved = await store.put(STATE_KEY, JSON.stringify(state), {
        onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' }
      });
      if (saved) return state;
    }
    throw Object.assign(new Error('Another update is in progress. Please try again.'), { status: 409 });
  }

  async function readDashboard() {
    const { state } = await read();
    const { transactions = [], scenarios, goalAllocationLedger = [], categoryEditBatches, importBatches, mortgageSnapshots, operationResults, budgetChangeHistory, ...dashboard } = state;
    const { lastGoalAllocationUndo, ...safeMeta } = dashboard;
    return { state: {
      ...safeMeta,
      items: (state.items || []).map(({ token, cursor, ...item }) => item),
      transactions: undefined,
      transactionCount: transactions.length,
      transactionMonths: [...new Set(transactions.map(row => row.date?.slice(0, 7)).filter(Boolean))].sort().reverse(),
      ...(goalAllocationLedger.length ? { lastGoalAllocationUndo: [...goalAllocationLedger].reverse().find(entry => !entry.undoneAt) || null } : { lastGoalAllocationUndo: lastGoalAllocationUndo || null }),
      balanceSheetSnapshots: (state.balanceSheetSnapshots || []).slice(-12)
    } };
  }
  async function readIdentity() { const {state}=await read();return{owner:state.owner||null,lastSync:state.lastSync||null,version:state.version}; }
  async function readSyncJob() { return (await read()).state.syncJob || null; }
  async function readOperationResult(id) { const {state}=await read();return (state.operationResults||[]).find(row=>row.id===id)||null; }
  async function readBudgetHistory({id,month,categoryId,limit=100}={}) { const rows=(await read()).state.budgetChangeHistory||[];return rows.filter(row=>(!id||row.id===id)&&(!month||row.month===month)&&(!categoryId||row.categoryId===categoryId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).slice(0,Math.min(500,Math.max(1,limit))); }

  async function mutateWithOperation(operation, update) {
    for(let attempt=0;attempt<4;attempt++){
      const {state,etag}=await read(),existing=(state.operationResults||[]).find(row=>row.id===operation.id);
      if(existing){if(existing.scope!==operation.scope||existing.payloadDigest!==operation.payloadDigest)throw Object.assign(new Error('This save identifier was already used for different values. Start a new save.'),{status:409});return{state:null,result:existing.response,replayed:true};}
      const record=await update(state);if(state._pendingBudgetHistory?.length)state.budgetChangeHistory=[...(state.budgetChangeHistory||[]),...state._pendingBudgetHistory];delete state._pendingBudgetHistory;state.operationResults||=[];state.operationResults.push(record);
      const saved=await store.put(STATE_KEY,JSON.stringify(state),{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
      if(saved)return{state,result:record.response,replayed:false};
    }
    throw Object.assign(new Error('Another update is in progress. Please try again.'),{status:409});
  }

  async function queryTransactions({ page=1,limit=50,search='',category='',accountId='',from='',to='',review=false }={}) {
    const { state } = await read();
    const matches=(state.transactions||[]).filter(row=>(!search||String(row.merchant||'').toLocaleLowerCase('en-US').includes(search.toLocaleLowerCase('en-US')))&&(!category||transactionMatchesCategory(row,category))&&(!accountId||row.accountId===accountId)&&(!from||row.date>=from)&&(!to||row.date<=to)&&(!review||row.review===true||row.confidence!==undefined&&row.confidence<.5||(row.override||row.category)==='Other')).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
    return {page,limit,total:matches.length,transactions:matches.slice((page-1)*limit,page*limit),revision:state.revision||0};
  }

  async function queryMonthSummary(month) {
    const { state } = await read();
    const reportTransactions=applyTransactionSplitsToRows(state,state.transactions||[]);
    const monthDate=new Date(`${month}-01T12:00:00Z`),previousDate=new Date(Date.UTC(monthDate.getUTCFullYear(),monthDate.getUTCMonth()-1,1)),previousMonth=`${previousDate.getUTCFullYear()}-${String(previousDate.getUTCMonth()+1).padStart(2,'0')}`;
    const summarize=key=>{
      const selected=reportTransactions.filter(row=>row.date?.startsWith(key));
      const summary=selected.filter(row=>!row.pending&&row.currency==='USD').reduce((out,row)=>{const category=row.override||row.category;if(category==='Income')out.income=addSafeCents(out.income,-row.amount,'Monthly income');else if(category!=='Transfers'&&!isAllocationTransaction(row,state)){out.spend=addSafeCents(out.spend,row.amount,'Monthly spending');out.categories[category]=addSafeCents(out.categories[category]||0,row.amount,'Monthly category spending');if(row.amount>0)out.purchases++;const week=Math.min(4,Math.floor((Number(row.date.slice(-2))-1)/7));out.weeklySpend[week]=addSafeCents(out.weeklySpend[week],row.amount,'Weekly spending');}return out;},{spend:0,income:0,purchases:0,categories:{},weeklySpend:[0,0,0,0,0]});
      return summary;
    };
    const currentRows=(state.transactions||[]).filter(row=>row.date?.startsWith(month)).sort((a,b)=>b.date.localeCompare(a.date)||String(a.merchant||'').localeCompare(String(b.merchant||''))||a.id.localeCompare(b.id));
    return {month,previousMonth,revision:Number.isSafeInteger(state.revision)?state.revision:0,current:summarize(month),previous:summarize(previousMonth),recent:currentRows.slice(0,6),transactionCount:currentRows.length};
  }

  return Object.freeze({ read, mutate, mutateWithOperation, readOperationResult, readBudgetHistory, readDashboard, readIdentity, readSyncJob, queryTransactions, queryMonthSummary, readScenarios: async () => (await read()).state.scenarios || [] });
}

const repositories = new WeakMap();

export function repositoryFor(environment) {
  if (environment.REPOSITORY) return environment.REPOSITORY;
  if (!environment.BUCKET) throw Object.assign(new Error('Storage is unavailable. Please try again later.'), { status: 503 });
  if (!repositories.has(environment)) repositories.set(environment, createStateRepository(environment.BUCKET));
  return repositories.get(environment);
}
