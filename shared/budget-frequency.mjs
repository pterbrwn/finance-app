const MAX_AMOUNT = 100_000_000;

export const BUDGET_FREQUENCIES = Object.freeze(['weekly', 'monthly', 'semiannual', 'annual']);

export function monthlyBudgetAmount(amount, frequency) {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_AMOUNT) throw new TypeError('Budget amount must be non-negative integer cents.');
  if (!BUDGET_FREQUENCIES.includes(frequency)) throw new TypeError('Choose a supported budget frequency.');
  const numerator = frequency === 'weekly' ? amount * 4 : amount;
  const denominator = frequency === 'weekly' ? 1 : frequency === 'semiannual' ? 6 : frequency === 'annual' ? 12 : 1;
  const result = Math.round(numerator / denominator);
  if (!Number.isSafeInteger(result)) throw new TypeError('Monthly budget amount exceeds the safe integer-cent range.');
  return result;
}

export function validateBudgetSchedule({ frequency, dueMonth = null }) {
  if (!BUDGET_FREQUENCIES.includes(frequency)) throw new TypeError('Choose a supported budget frequency.');
  if (dueMonth !== null && (!Number.isInteger(dueMonth) || dueMonth < 1 || dueMonth > 12)) throw new TypeError('Due month must be between 1 and 12.');
  if (frequency === 'annual' && dueMonth === null) throw new TypeError('Choose the month this annual item is due.');
  if (frequency !== 'annual' && dueMonth !== null) throw new TypeError('Only annual items use a due month.');
  return { frequency, dueMonth };
}
