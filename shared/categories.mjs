export const CATEGORIES = Object.freeze([
  'Housing', 'Groceries', 'Dining', 'Shopping', 'Transport', 'Utilities',
  'Health', 'Entertainment', 'Travel', 'Other', 'Income', 'Transfers'
]);

export function transactionMatchesCategory(transaction, category) {
  const hasOverride = typeof transaction.override === 'string' && transaction.override.length > 0;
  const name = hasOverride ? transaction.override : transaction.category;
  const id = hasOverride ? transaction.overrideCategoryId : transaction.categoryId;
  return name === category || typeof id === 'string' && id === category;
}
