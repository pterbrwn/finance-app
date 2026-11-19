export const CATEGORIES = Object.freeze([
  'Housing', 'Groceries', 'Dining', 'Shopping', 'Transport', 'Utilities',
  'Health', 'Entertainment', 'Travel', 'Other', 'Income', 'Transfers'
]);

export const TRANSACTION_CATEGORY_KINDS = Object.freeze(['expense', 'income', 'transfer']);

function normalizedName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

// Allocation buckets earmark money for a goal or future purchase. Generic
// savings allocations stay plan-only and are never offered as transaction
// categories. Investment allocation buckets are the exception: they exist to
// receive recorded investment activity against a planned funding amount, so
// they stay choosable as transaction categories.
export function isInvestmentAllocation(category, settings = {}) {
  const group = String(category?.budgetGroup || settings[category?.id]?.budgetGroup || '');
  return category?.kind === 'allocation' && group === 'Investments';
}

export function isTransactionCategory(category, settings = {}) {
  if (!category) return false;
  if (category.kind === 'allocation') return isInvestmentAllocation(category, settings);
  return TRANSACTION_CATEGORY_KINDS.includes(category.kind) && settings[category.id]?.itemType !== 'allocation';
}

export function isAllocationTransaction(transaction, state = {}) {
  const overridden = typeof transaction.override === 'string' && transaction.override.length > 0;
  const name = overridden ? transaction.override : transaction.category;
  const id = overridden ? transaction.overrideCategoryId : transaction.categoryId;
  const settings = state.budgetItemSettings || {};
  const records = state.categoryRecords || [];
  const record = records.find(category => category.id === id)
    || records.find(category => normalizedName(category.name) === normalizedName(name));
  const isEarmark = category => !!category && (category.kind === 'allocation' || settings[category.id]?.itemType === 'allocation');
  const allocated = (typeof id === 'string' && settings[id]?.itemType === 'allocation')
    || isEarmark(record)
    || settings[`legacy:${encodeURIComponent(normalizedName(name))}`]?.itemType === 'allocation'
    || Object.entries(state.budgetCategoryIds || {}).some(([categoryId, categoryName]) =>
      categoryName === name && settings[categoryId]?.itemType === 'allocation');
  if (!allocated) return false;
  // Earmarks keep savings and transfer allocations plan-only. Investment
  // allocation buckets record real funding activity against a planned amount,
  // so a transaction assigned to one is counted instead of being earmark-only.
  if (record?.kind === 'allocation' && isInvestmentAllocation(record, settings)) return false;
  return true;
}

export function transactionMatchesCategory(transaction, category) {
  const hasOverride = typeof transaction.override === 'string' && transaction.override.length > 0;
  const name = hasOverride ? transaction.override : transaction.category;
  const id = hasOverride ? transaction.overrideCategoryId : transaction.categoryId;
  return name === category || typeof id === 'string' && id === category;
}
