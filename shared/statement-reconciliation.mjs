export const STATEMENT_RECONCILIATION_VERSION = 1;
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

export function calculateStatementReconciliation({ account, opening, closing, transactions = [], historyComplete = false }) {
  if (!account || !['depository', 'credit'].includes(account.type) || account.currency !== 'USD') {
    return { supported: false, complete: false, reason: 'Only USD depository and credit accounts are supported.' };
  }
  if (!opening || !closing || !dateOnly(opening.date) || !dateOnly(closing.date) || opening.date >= closing.date || !Number.isSafeInteger(opening.balance) || !Number.isSafeInteger(closing.balance)) {
    return { supported: true, complete: false, reason: 'Enter valid opening and later closing statement dates and balances.' };
  }
  let transactionDelta = 0, postedCount = 0, pendingCount = 0;
  for (const row of transactions) {
    if (row.accountId !== account.id || !dateOnly(row.date) || row.date <= opening.date || row.date > closing.date || row.currency !== 'USD') continue;
    if (row.pending) { pendingCount++; continue; }
    if (!Number.isSafeInteger(row.amount)) return { supported: true, complete: false, reason: 'A posted transaction has an invalid amount.' };
    const delta = account.type === 'depository' ? -row.amount : row.amount;
    transactionDelta += delta;
    if (!Number.isSafeInteger(transactionDelta)) return { supported: true, complete: false, reason: 'The statement period exceeds the safe integer-cent range.' };
    postedCount++;
  }
  const expectedClosing = opening.balance + transactionDelta;
  if (!Number.isSafeInteger(expectedClosing)) return { supported: true, complete: false, reason: 'The expected balance exceeds the safe integer-cent range.' };
  return {
    supported: true,
    complete: historyComplete === true,
    coverage: historyComplete === true ? 'user-confirmed-complete' : 'incomplete-or-unconfirmed',
    opening: { date: opening.date, balance: opening.balance }, closing: { date: closing.date, balance: closing.balance },
    transactionDelta, expectedClosing, observedClosing: closing.balance,
    discrepancy: closing.balance - expectedClosing, postedCount, pendingCount,
    dateConvention: 'Transactions after the opening date through and including the closing date; opening-date activity is already reflected in the opening balance. Pending transactions are excluded.',
    calculationVersion: STATEMENT_RECONCILIATION_VERSION
  };
}

export function statementTransactionFingerprint(transactions, accountId, fromDate, toDate) {
  return JSON.stringify(transactions.filter(row => row.accountId === accountId && row.date > fromDate && row.date <= toDate)
    .map(row => ({ id: row.id, date: row.date, amount: row.amount, currency: row.currency, pending: row.pending === true, accountId: row.accountId }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)));
}
