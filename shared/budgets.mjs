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
