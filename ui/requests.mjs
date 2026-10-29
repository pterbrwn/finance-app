const REPLAY_SAFE_WRITE_PATHS = new Set([
  'account-update', 'budget', 'budget-history-revert', 'budget-outlook', 'budget-reset', 'budget-stop-future', 'category', 'category-bulk', 'category-bulk-undo', 'category-create', 'category-update', 'goal', 'goal-allocation-undo',
  'income-plan', 'income-plan-reset',
  'goal-allocations', 'import', 'import-undo', 'manual-account',
  'mortgage', 'property', 'scenario', 'scenario-budget', 'scenario-goal',
  'transaction-split', 'transaction-reimbursement', 'commitments', 'commitment-match', 'statement-reconciliation'
]);
export const PENDING_OPERATIONS_KEY=['ledger','pending-operations','v1'].join('.');
function browserSessionStore(){try{return globalThis.sessionStorage||null;}catch{return null;}}
export function readPendingOperations(store=browserSessionStore()){
  if(!store)return[];
  try{const value=JSON.parse(store.getItem(PENDING_OPERATIONS_KEY)||'[]');return Array.isArray(value)?value.filter(row=>row&&typeof row.operationId==='string'&&typeof row.scope==='string'&&Number.isSafeInteger(row.baseRevision)&&typeof row.startedAt==='string'):[];}catch{return[];}
}
export function clearPendingOperation(operationId,store=browserSessionStore()){
  if(!store)return false;
  try{const rows=readPendingOperations(store).filter(row=>row.operationId!==operationId);store.setItem(PENDING_OPERATIONS_KEY,JSON.stringify(rows));return true;}catch{return false;}
}

export function createApiClient({ isSample = () => false, fetcher = fetch, createOperationId = () => crypto.randomUUID(), sessionStore = browserSessionStore() } = {}) {
  const pendingOperationIds = new Map();
  const inFlightWrites = new Map();
  const api=async function api(path, input) {
    if (isSample() && input !== undefined) throw new Error('Sample preview cannot save changes.');
    const replaySafe = input !== undefined && REPLAY_SAFE_WRITE_PATHS.has(path);
    let requestInput = input, operationKey = null;
    if (replaySafe) {
      operationKey = path + '\n' + JSON.stringify(input);
      let clientOperationId = pendingOperationIds.get(operationKey);
      if (!clientOperationId) {
        const matches=readPendingOperations(sessionStore).filter(row=>row.scope===path);
        if(matches.length>1)throw new Error('Resolve the earlier '+path+' save status before starting another save in this section.');
        const existing=matches[0];
        clientOperationId = existing?.operationId||createOperationId();
        pendingOperationIds.set(operationKey, clientOperationId);
      }
      const rows=readPendingOperations(sessionStore),existing=rows.find(row=>row.operationId===clientOperationId),baseRevision=existing?.baseRevision??(Number.isSafeInteger(input?.revision)?input.revision:0);
      requestInput = { ...input,...(Number.isSafeInteger(input?.revision)?{revision:baseRevision}:{}),clientOperationId };
      if(sessionStore){try{const next=[{operationId:clientOperationId,scope:path,baseRevision,startedAt:rows.find(row=>row.operationId===clientOperationId)?.startedAt||new Date().toISOString()},...rows.filter(row=>row.operationId!==clientOperationId)];sessionStore.setItem(PENDING_OPERATIONS_KEY,JSON.stringify(next));}catch{api.reloadRecoveryAvailable=false;}}
    }

    const requestKey = input === undefined ? null : path + '\n' + JSON.stringify(requestInput);
    if (requestKey && inFlightWrites.has(requestKey)) return inFlightWrites.get(requestKey);
    const task = (async () => {
      for (let attempt = 0; attempt < (replaySafe ? 2 : 1); attempt++) {
        let response;
        try {
          response = await fetcher('/api/' + path, {
            method: input === undefined ? 'GET' : 'POST',
            headers: input === undefined ? {} : { 'Content-Type': 'application/json' },
            body: input === undefined ? undefined : JSON.stringify(requestInput)
          });
        } catch (error) {
          if (replaySafe && attempt === 0) continue;
          throw Object.assign(new Error('Could not reach Ledger. Check the connection and try again.'), { cause: error, network: true });
        }
        if (replaySafe && response.status >= 500 && attempt === 0) continue;
        let result = null;
        try { result = await response.json(); } catch {}
        if (!response.ok) {
          // A conflict is a known response, but it can mean either a stale
          // revision (the operation did not commit) or a reused operation ID
          // whose earlier request did commit. Resolve that distinction before
          // deciding whether the same-tab recovery reference is still needed.
          if (response.status === 409 && operationKey) {
            try {
              const statusResponse = await fetcher('/api/operation-status?operationId=' + encodeURIComponent(requestInput.clientOperationId));
              const statusResult = statusResponse.ok ? await statusResponse.json() : null;
              if (statusResult?.status === 'unknown' || statusResult?.status === 'committed') {
                clearPendingOperation(requestInput.clientOperationId, sessionStore);
                pendingOperationIds.delete(operationKey);
              }
            } catch {}
          }
          throw Object.assign(new Error(result?.error || 'Ledger could not complete this request. Try again.'), { status: response.status });
        }
        if (!result || typeof result !== 'object') throw new Error('Ledger returned an unreadable response. Try again.');
        if(operationKey)clearPendingOperation(requestInput.clientOperationId,sessionStore);
        return result;
      }
      throw new Error('Ledger could not confirm the save. Retry it to check the saved result.');
    })();
    if (requestKey) inFlightWrites.set(requestKey, task);
    try {
      const result = await task;
      if (operationKey) pendingOperationIds.delete(operationKey);
      return result;
    } finally {
      if (requestKey && inFlightWrites.get(requestKey) === task) inFlightWrites.delete(requestKey);
    }
  };
  api.reloadRecoveryAvailable=!!sessionStore;
  api.pendingOperations=()=>readPendingOperations(sessionStore);
  api.clearPendingOperation=id=>clearPendingOperation(id,sessionStore);
  return api;
}
