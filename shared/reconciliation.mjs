import { fromPlaid } from './reporting.mjs';

export function applyChanges(state, itemId, added, modified, removed) {
  const transactions = new Map(state.transactions.map(transaction => [transaction.id, transaction]));
const overrides = new Map(state.transactions.filter(transaction => transaction.override).map(transaction => [transaction.id, {
    override: transaction.override,
    ...(transaction.overrideCategoryId ? { overrideCategoryId: transaction.overrideCategoryId } : {}),
    ...(Number.isSafeInteger(transaction.categoryEditVersion) ? { categoryEditVersion: transaction.categoryEditVersion } : {})
  }]));
  for (const transaction of removed) transactions.delete(transaction.transaction_id);
  for (const transaction of [...added, ...modified]) {
    const override = overrides.get(transaction.transaction_id) || overrides.get(transaction.pending_transaction_id);
    transactions.set(transaction.transaction_id, {
      ...fromPlaid(transaction, itemId),
      ...(override || {})
    });
    if (transaction.pending_transaction_id && transaction.pending_transaction_id !== transaction.transaction_id) {
      transactions.delete(transaction.pending_transaction_id);
    }
  }
  state.transactions = [...transactions.values()];
}

export function applySyncPages(state, itemId, pages) {
  const added = pages.flatMap(page => page.added || []);
  const modified = pages.flatMap(page => page.modified || []);
  const removed = pages.flatMap(page => page.removed || []);
  applyChanges(state, itemId, added, modified, removed);
}
