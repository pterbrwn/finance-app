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

function providerCounterparties(transaction) {
  const rows = Array.isArray(transaction.counterparties) ? transaction.counterparties : [];
  const cleaned = rows.flatMap(counterparty => {
    if (!counterparty || typeof counterparty !== 'object') return [];
    const name = typeof counterparty.name === 'string' ? counterparty.name.normalize('NFKC').trim().slice(0, 200) : '';
    const type = typeof counterparty.type === 'string' ? counterparty.type.slice(0, 40) : null;
    const confidence = typeof counterparty.confidence_level === 'string' ? counterparty.confidence_level.slice(0, 40) : null;
    return name || type ? [{ ...(name ? { name } : {}), ...(type ? { type } : {}), ...(confidence ? { confidence } : {}) }] : [];
  });
  return cleaned.length ? cleaned : undefined;
}

function providerCategory(transaction) {
  const category = transaction.personal_finance_category;
  if (!category || typeof category !== 'object') return undefined;
  const primary = typeof category.primary === 'string' ? category.primary.slice(0, 80) : null;
  const detailed = typeof category.detailed === 'string' ? category.detailed.slice(0, 120) : null;
  const confidence = typeof category.confidence_level === 'string' ? category.confidence_level.slice(0, 40) : null;
  return primary || detailed ? { ...(primary ? { primary } : {}), ...(detailed ? { detailed } : {}), ...(confidence ? { confidence } : {}) } : undefined;
}

// One numeric confidence contract for provider categories, imported rows, and
// manual records. Provider text levels are normalized here so review decisions
// never have to compare a string such as "LOW" against a number.
export const LOW_CONFIDENCE_THRESHOLD = 0.5;
const PROVIDER_CONFIDENCE = Object.freeze({ VERY_HIGH: 1, HIGH: 0.9, MEDIUM: 0.7, LOW: 0.3, UNKNOWN: 0 });

export function normalizeConfidence(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const provider = PROVIDER_CONFIDENCE[text.toUpperCase().replace(/[\s-]+/g, '_')];
  if (provider !== undefined) return provider;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : null;
}

export function transactionConfidence(transaction) {
  const direct = normalizeConfidence(transaction?.confidence);
  if (direct !== null) return direct;
  return normalizeConfidence(transaction?.personalFinanceCategory?.confidence);
}

export function hasLowConfidence(transaction) {
  const confidence = transactionConfidence(transaction);
  return confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD;
}

export function fromPlaid(transaction, itemId) {
  if (!Number.isFinite(transaction.amount)) throw new Error('Invalid transaction amount');
  const amount=Math.round(transaction.amount*100);
  if(!Number.isSafeInteger(amount))throw new RangeError('Provider transaction amount exceeds the safe integer-cent range.');
  const personalFinanceCategory=providerCategory(transaction), counterparties=providerCounterparties(transaction),confidence=normalizeConfidence(personalFinanceCategory?.confidence);
  return {
    id: transaction.transaction_id,
    itemId,
    accountId: providerAccountKey(itemId, transaction.account_id),
    date: transaction.date,
    merchant: transaction.merchant_name || transaction.name || 'Transaction',
    amount,
    category: categoryFor(transaction),
    pending: !!transaction.pending,
    currency: transaction.iso_currency_code || transaction.unofficial_currency_code || 'UNKNOWN',
    ...(confidence !== null ? { confidence } : {}),
    ...(personalFinanceCategory ? { personalFinanceCategory } : {}),
    ...(counterparties ? { counterparties } : {})
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
