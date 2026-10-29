import { providerAccountKey } from './investments.mjs';

export function addSafeCents(total,amount,label='Money total') {
  const result=total+amount;
  if(!Number.isSafeInteger(total)||!Number.isSafeInteger(amount)||!Number.isSafeInteger(result))throw new RangeError(`${label} exceeds the safe integer-cent range.`);
  return result;
}

export function categoryFor(transaction) {
  const primary = transaction.personal_finance_category?.primary || '';
  const detailed = transaction.personal_finance_category?.detailed || '';
  if (primary.startsWith('TRANSFER') || detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') return 'Transfers';
  if (detailed === 'LOAN_PAYMENTS_MORTGAGE_PAYMENT') return 'Housing';
  return ({
    INCOME: 'Income',
    RENT_AND_UTILITIES: detailed === 'RENT_AND_UTILITIES_RENT' ? 'Housing' : 'Utilities',
    FOOD_AND_DRINK: detailed.includes('GROCER') ? 'Groceries' : 'Dining',
    TRANSPORTATION: 'Transport',
    TRAVEL: 'Travel',
    MEDICAL: 'Health',
    PERSONAL_CARE: 'Health',
    ENTERTAINMENT: 'Entertainment',
    GENERAL_MERCHANDISE: 'Shopping',
    HOME_IMPROVEMENT: 'Housing'
  })[primary] || 'Other';
}

export function fromPlaid(transaction, itemId) {
  if (!Number.isFinite(transaction.amount)) throw new Error('Invalid transaction amount');
  const amount=Math.round(transaction.amount*100);
  if(!Number.isSafeInteger(amount))throw new RangeError('Provider transaction amount exceeds the safe integer-cent range.');
  return {
    id: transaction.transaction_id,
    itemId,
    accountId: providerAccountKey(itemId, transaction.account_id),
    date: transaction.date,
    merchant: transaction.merchant_name || transaction.name || 'Transaction',
    amount,
    category: categoryFor(transaction),
    pending: !!transaction.pending,
    currency: transaction.iso_currency_code || transaction.unofficial_currency_code || 'UNKNOWN'
  };
}

export function totals(rows) {
  return rows.filter(transaction => !transaction.pending && transaction.currency === 'USD').reduce((summary, transaction) => {
    if(!Number.isSafeInteger(transaction.amount))throw new RangeError('Transaction amount exceeds the safe integer-cent range.');
    const category = transaction.override || transaction.category;
    if (category === 'Income') summary.income = addSafeCents(summary.income,-transaction.amount,'Income total');
    else if (category !== 'Transfers') {
      summary.spend = addSafeCents(summary.spend,transaction.amount,'Spending total');
      summary.categories[category] = addSafeCents(summary.categories[category] || 0,transaction.amount,'Category total');
    }
    return summary;
  }, { income: 0, spend: 0, categories: {} });
}
