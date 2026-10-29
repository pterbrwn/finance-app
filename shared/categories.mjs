export const CATEGORIES = Object.freeze([
  'Housing', 'Groceries', 'Dining', 'Shopping', 'Transport', 'Utilities',
  'Health', 'Entertainment', 'Travel', 'Other', 'Income', 'Transfers'
]);

function normalizedName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function isAllocationTransaction(transaction, state = {}) {
  const overridden = typeof transaction.override === 'string' && transaction.override.length > 0;
  const name = overridden ? transaction.override : transaction.category;
  const id = overridden ? transaction.overrideCategoryId : transaction.categoryId;
  const settings = state.budgetItemSettings || {};
  if (typeof id === 'string' && settings[id]?.itemType === 'allocation') return true;

  const records = state.categoryRecords || [];
  const record = records.find(category => category.id === id)
    || records.find(category => normalizedName(category.name) === normalizedName(name));
  if (record?.kind === 'allocation' || settings[record?.id]?.itemType === 'allocation') return true;

  const legacyId = `legacy:${encodeURIComponent(normalizedName(name))}`;
  if (settings[legacyId]?.itemType === 'allocation') return true;
  return Object.entries(state.budgetCategoryIds || {}).some(([categoryId, categoryName]) =>
    categoryName === name && settings[categoryId]?.itemType === 'allocation');
}

export function transactionMatchesCategory(transaction, category) {
  const hasOverride = typeof transaction.override === 'string' && transaction.override.length > 0;
  const name = hasOverride ? transaction.override : transaction.category;
  const id = hasOverride ? transaction.overrideCategoryId : transaction.categoryId;
  return name === category || typeof id === 'string' && id === category;
}
