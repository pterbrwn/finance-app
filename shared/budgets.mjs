export function validMonth(month) {
  return typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

export function resolveBudget(templates = [], monthOverrides = {}, categoryId, month) {
  if (!validMonth(month) || typeof categoryId !== 'string') throw new TypeError('A category and YYYY-MM budget month are required.');
  const key = `${month}:${categoryId}`;
  if (Object.hasOwn(monthOverrides, key)) return { amount: monthOverrides[key], source: 'month', month, categoryId };
  const template = templates
    .filter(entry => entry.categoryId === categoryId && validMonth(entry.effectiveFrom) && entry.effectiveFrom <= month)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return template ? { amount: template.amount, source: 'template', effectiveFrom: template.effectiveFrom, month, categoryId } : { amount: null, source: 'none', month, categoryId };
}

export function budgetMonthKey(month, categoryId) {
  if (!validMonth(month) || typeof categoryId !== 'string' || !categoryId) throw new TypeError('A category and YYYY-MM budget month are required.');
  return `${month}:${categoryId}`;
}

export function resolveIncomePlan(templates = [], monthOverrides = {}, month) {
  if (!validMonth(month)) throw new TypeError('A YYYY-MM income plan month is required.');
  if (Object.hasOwn(monthOverrides, month)) return { amount: monthOverrides[month], source: 'month', month };
  const template = templates.filter(row => validMonth(row.effectiveFrom) && row.effectiveFrom <= month)
    .sort((a,b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return template ? { amount: template.amount, source: 'template', effectiveFrom: template.effectiveFrom, month } : { amount: null, source: 'none', month };
}

const cents = (value, label) => {
  if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw new TypeError(`${label} must be integer cents or unknown.`);
  return value ?? null;
};
const arithmetic = (left, right, label, sign = 1) => {
  const result = left + sign * right;
  if (!Number.isSafeInteger(result)) throw new TypeError(`${label} exceeds the safe integer-cent range.`);
  return result;
};

export function calculateBudgetPlan({ month, incomePlan = null, buckets = [], actualIncome = 0, outlook = null, closed = false }) {
  if (!validMonth(month)) throw new TypeError('A YYYY-MM budget month is required.');
  actualIncome = cents(actualIncome, 'Actual income') ?? 0;
  const plannedIncome = cents(incomePlan?.amount, 'Planned income');
  let plannedExpenses = 0, actualSpending = 0, complete = plannedIncome !== null, running = plannedIncome, hasIncome = plannedIncome !== null;
  const rows = buckets.map(bucket => {
    if (typeof bucket.categoryId !== 'string' || !bucket.categoryId) throw new TypeError('Each budget bucket needs a stable category ID.');
    const plan = cents(bucket.plan?.amount, 'Planned bucket amount');
    const actual = cents(bucket.actual, 'Actual bucket spending') ?? 0;
    actualSpending = arithmetic(actualSpending, actual, 'Actual spending');
    if (plan === null && (actual !== 0 || bucket.hasActivity)) complete = false;
    if (plan !== null) {
      plannedExpenses = arithmetic(plannedExpenses, plan, 'Planned expenses');
      if (running !== null) running = arithmetic(running, plan, 'Running planned balance', -1);
    }
    const remaining = plan === null ? null : arithmetic(plan, actual, 'Bucket remaining', -1);
    const defaultRemaining = plan === null ? 0 : Math.max(0, remaining);
    const savedOutlook = outlook?.expenses?.[bucket.categoryId];
    const target = savedOutlook?.expectedTotal;
    const expectedTotal = closed ? actual : Number.isSafeInteger(target) ? Math.max(actual, target) : arithmetic(actual, defaultRemaining, 'Expected bucket total');
    const expectedRemaining = Math.max(0, arithmetic(expectedTotal, actual, 'Expected bucket remaining', -1));
    return { ...bucket, plan: { ...(bucket.plan || {}), amount: plan }, actual, remaining, runningBalance: running, defaultRemaining, expectedRemaining, expectedTotal };
  });
  const plannedNet = hasIncome ? running : null;
  const actualNet = arithmetic(actualIncome, actualSpending, 'Actual net', -1);
  const incomeTarget = outlook?.income?.expectedTotal;
  const remainingIncome = closed ? 0 : Number.isSafeInteger(incomeTarget)
    ? Math.max(0, incomeTarget - actualIncome)
    : hasIncome ? Math.max(0, plannedIncome - actualIncome) : null;
  const expectedIncome = remainingIncome === null ? null : arithmetic(actualIncome, remainingIncome, 'Expected income');
  const expectedSpending = rows.reduce((sum, row) => arithmetic(arithmetic(sum, row.actual, 'Expected spending'), row.expectedRemaining, 'Expected spending'), 0);
  const expectedNet = expectedIncome === null ? null : arithmetic(expectedIncome, expectedSpending, 'Expected net', -1);
  return { month, plannedIncome, actualIncome, incomeRemaining: plannedIncome === null ? null : arithmetic(plannedIncome, actualIncome, 'Income remaining', -1),
    plannedExpenses, actualSpending, plannedNet, actualNet, complete, rows,
    expectedIncome, expectedSpending, expectedNet, hasOutlookAdjustment: !!(outlook?.income || Object.keys(outlook?.expenses || {}).length) };
}
