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
  return {
    id: transaction.transaction_id,
    itemId,
    accountId: transaction.account_id,
    date: transaction.date,
    merchant: transaction.merchant_name || transaction.name || 'Transaction',
    amount: Math.round(transaction.amount * 100),
    category: categoryFor(transaction),
    pending: !!transaction.pending,
    currency: transaction.iso_currency_code || transaction.unofficial_currency_code || 'UNKNOWN'
  };
}

export function totals(rows) {
  return rows.filter(transaction => !transaction.pending && transaction.currency === 'USD').reduce((summary, transaction) => {
    const category = transaction.override || transaction.category;
    if (category === 'Income') summary.income -= transaction.amount;
    else if (category !== 'Transfers') {
      summary.spend += transaction.amount;
      summary.categories[category] = (summary.categories[category] || 0) + transaction.amount;
    }
    return summary;
  }, { income: 0, spend: 0, categories: {} });
}
