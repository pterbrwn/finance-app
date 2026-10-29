export function validMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false;
  const year = Number(month.slice(0, 4));
  return year >= 1900 && year <= 2200;
}

export function resolveBudget(templates = [], monthOverrides = {}, categoryId, month, monthSchedules = {}) {
  if (!validMonth(month) || typeof categoryId !== 'string') {
    throw new TypeError('A category and YYYY-MM budget month are required.');
  }
  const key = `${month}:${categoryId}`;
  if (Object.hasOwn(monthOverrides, key)) {
    return { amount: monthOverrides[key], source: 'month', month, categoryId, ...(monthSchedules[key] || {}) };
  }
  const template = templates
    .filter(entry => entry.categoryId === categoryId && validMonth(entry.effectiveFrom) && entry.effectiveFrom <= month)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return template
    ? {
        amount: template.amount,
        source: 'template',
        effectiveFrom: template.effectiveFrom,
        month,
        categoryId,
        ...(template.frequency
          ? {
              frequency: template.frequency,
              dueMonth: template.dueMonth ?? null,
              sourceAmount: template.sourceAmount ?? template.amount
            }
          : {})
      }
    : { amount: null, source: 'none', month, categoryId };
}

export function budgetMonthKey(month, categoryId) {
  if (!validMonth(month) || typeof categoryId !== 'string' || !categoryId) {
    throw new TypeError('A category and YYYY-MM budget month are required.');
  }
  return `${month}:${categoryId}`;
}

export function mapBudgetRolloversByName(rollovers = {}, categories = [], legacyCategoryNames = {}) {
  const names = new Map(categories.map(category => [category.id, category.name]));
  for (const [id, name] of Object.entries(legacyCategoryNames)) {
    if (!names.has(id)) names.set(id, name);
  }
  return Object.fromEntries(Object.entries(rollovers).map(([id, amount]) => [names.get(id) || id, amount]));
}

export function resolveIncomePlan(templates = [], monthOverrides = {}, month) {
  if (!validMonth(month)) {
    throw new TypeError('A YYYY-MM income plan month is required.');
  }
  if (Object.hasOwn(monthOverrides, month)) {
    return { amount: monthOverrides[month], source: 'month', month };
  }
  const template = templates.filter(row => validMonth(row.effectiveFrom) && row.effectiveFrom <= month)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return template
    ? { amount: template.amount, source: 'template', effectiveFrom: template.effectiveFrom, month }
    : { amount: null, source: 'none', month };
}

const cents = (value, label) => {
  if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} must be integer cents or unknown.`);
  }
  return value ?? null;
};
const arithmetic = (left, right, label, sign = 1) => {
  const result = left + sign * right;
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`${label} exceeds the safe integer-cent range.`);
  }
  return result;
};

export function calculateBudgetPlan({ month, incomePlan = null, buckets = [], actualIncome = 0, outlook = null, closed = false }) {
  if (!validMonth(month)) {
    throw new TypeError('A YYYY-MM budget month is required.');
  }
  actualIncome = cents(actualIncome, 'Actual income') ?? 0;
  const plannedIncome = cents(incomePlan?.amount, 'Planned income');
  let plannedExpenses = 0;
  let plannedAllocations = 0;
  let availableExpenses = 0;
  let bucketRemaining = 0;
  let allocationRemaining = 0;
  let actualSpending = 0;
  let complete = plannedIncome !== null;
  let plannedExpenseBuckets = 0;
  let activeExpenseBuckets = 0;
  let unplannedExpenseActivity = 0;
  let running = plannedIncome;
  let hasIncome = plannedIncome !== null;
  const rows = buckets.map(bucket => {
    if (typeof bucket.categoryId !== 'string' || !bucket.categoryId) {
      throw new TypeError('Each budget bucket needs a stable category ID.');
    }
    const plan = cents(bucket.plan?.amount, 'Planned bucket amount');
    const rollover = cents(bucket.rollover, 'Bucket rollover') ?? 0;
    const actual = cents(bucket.actual, 'Actual bucket spending') ?? 0;
    const allocation = bucket.itemType === 'allocation';
    if (!allocation) {
      activeExpenseBuckets++;
      if (plan !== null) plannedExpenseBuckets++;
      else if (actual !== 0 || bucket.hasActivity) unplannedExpenseActivity++;
    }
    if (!allocation) actualSpending = arithmetic(actualSpending, actual, 'Actual spending');
    if (plan === null && (actual !== 0 || bucket.hasActivity)) complete = false;
    if (plan !== null) {
      if (allocation) plannedAllocations = arithmetic(plannedAllocations, plan, 'Planned allocations');
      else plannedExpenses = arithmetic(plannedExpenses, plan, 'Planned expenses');
      const available = arithmetic(plan, rollover, 'Bucket available balance');
      if (!allocation) availableExpenses = arithmetic(availableExpenses, available, 'Available bucket balances');
      if (running !== null) {
        running = arithmetic(running, plan, 'Running planned balance', -1);
      }
    }
    const available = plan === null ? null : arithmetic(plan, rollover, 'Bucket available balance');
    const remaining = available === null ? null : arithmetic(available, actual, 'Bucket remaining', -1);
    if (remaining !== null) {
      if (allocation) allocationRemaining = arithmetic(allocationRemaining, remaining, 'Remaining allocation balances');
      else bucketRemaining = arithmetic(bucketRemaining, remaining, 'Remaining bucket balances');
    }
    const defaultRemaining = plan === null ? 0 : Math.max(0, remaining);
    const savedOutlook = outlook?.expenses?.[bucket.categoryId];
    const target = savedOutlook?.expectedTotal;
    const expectedTotal = allocation ? 0 : closed ? actual : Number.isSafeInteger(target) ? Math.max(actual, target) : arithmetic(actual, defaultRemaining, 'Expected bucket total');
    const expectedRemaining = allocation ? 0 : Math.max(0, arithmetic(expectedTotal, actual, 'Expected bucket remaining', -1));
    return { ...bucket, plan: { ...(bucket.plan || {}), amount: plan }, rollover, available, actual, remaining, runningBalance: running, defaultRemaining, expectedRemaining, expectedTotal };
  });
  const plannedNet = hasIncome ? running : null;
  const actualNet = arithmetic(actualIncome, actualSpending, 'Actual net', -1);
  const incomeTarget = outlook?.income?.expectedTotal;
  const remainingIncome = closed ? 0 : Number.isSafeInteger(incomeTarget)
    ? Math.max(0, incomeTarget - actualIncome)
    : hasIncome ? Math.max(0, plannedIncome - actualIncome) : null;
  const expectedIncome = remainingIncome === null ? null : arithmetic(actualIncome, remainingIncome, 'Expected income');
  const expectedSpending = rows
    .filter(row => row.itemType !== 'allocation')
    .reduce((sum, row) => arithmetic(arithmetic(sum, row.actual, 'Expected spending'), row.expectedRemaining, 'Expected spending'), 0);
  const expectedNet = expectedIncome === null ? null : arithmetic(expectedIncome, expectedSpending, 'Expected net', -1);
  // Absence of activity cannot establish that a plan is complete. At least one
  // expense plan and no unplanned expense activity are required even for this
  // limited structural signal; it is not a claim of financial completeness.
  const expensePlanEstablished = plannedExpenseBuckets > 0;
  if (!expensePlanEstablished || unplannedExpenseActivity > 0) complete = false;
  return {
    month,
    plannedIncome,
    actualIncome,
    incomeRemaining: plannedIncome === null ? null : arithmetic(plannedIncome, actualIncome, 'Income remaining', -1),
    plannedExpenses,
    plannedAllocations,
    remainingAfterCommitments: plannedNet,
    availableExpenses,
    bucketRemaining,
    allocationRemaining,
    actualSpending,
    plannedExpenseBuckets,
    activeExpenseBuckets,
    expensePlanEstablished,
    unplannedExpenseActivity,
    plannedNet,
    actualNet,
    complete,
    rows,
    expectedIncome,
    expectedSpending,
    expectedNet,
    hasOutlookAdjustment: !!(outlook?.income || Object.keys(outlook?.expenses || {}).length)
  };
}
