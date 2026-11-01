const PEER_TO_PEER_PATTERN = /(^|[^a-z])(venmo|cash app|paypal|zelle)([^a-z]|$)/i;
const DAY_MS = 86_400_000;

export function normalizeRuleText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function categoryRuleConstraintCount(rule = {}) {
  return (rule.merchant ? 1 : 0) + (rule.counterparty ? 1 : 0) + (rule.accountId ? 1 : 0) + (Number.isSafeInteger(rule.amount) ? 1 : 0)
    + (rule.monthFrom ? 1 : 0) + (rule.monthTo ? 1 : 0) + (Array.isArray(rule.sources) && rule.sources.length ? 1 : 0);
}

// More constraints win, then amount > account > counterparty > merchant, then
// longer text. Every constraint band is larger than the longest text band so a
// specific rule can never be beaten by a longer generic one.
export function categoryRuleScore(rule = {}) {
  let score = 0;
  if (rule.merchant) score += 1_000 + Math.min(normalizeRuleText(rule.merchant).length, 200);
  if (rule.counterparty) score += 2_000 + Math.min(normalizeRuleText(rule.counterparty).length, 200);
  if (rule.accountId) score += 4_000;
  if (Number.isSafeInteger(rule.amount)) score += 8_000;
  if (rule.monthFrom) score += 16_000;
  if (rule.monthTo) score += 16_000;
  if (Array.isArray(rule.sources) && rule.sources.length) score += 32_000;
  return score;
}

function transactionMonth(transaction) {
  const date = String(transaction?.date || '').trim();
  return date.length >= 7 ? date.slice(0, 7) : '';
}

export function categoryRuleMatches(rule, transaction) {
  if (!rule || rule.enabled === false || !categoryRuleConstraintCount(rule)) return false;
  if (rule.merchant && !normalizeRuleText(transaction?.merchant).includes(normalizeRuleText(rule.merchant))) return false;
  if (rule.counterparty) {
    const names = (transaction?.counterparties || []).map(counterparty => normalizeRuleText(counterparty?.name)).filter(Boolean);
    if (!names.some(name => name.includes(normalizeRuleText(rule.counterparty)))) return false;
  }
  if (rule.accountId && transaction?.accountId !== rule.accountId) return false;
  if (Number.isSafeInteger(rule.amount) && transaction?.amount !== rule.amount) return false;
  if (rule.monthFrom && transactionMonth(transaction) < String(rule.monthFrom)) return false;
  if (rule.monthTo && transactionMonth(transaction) > String(rule.monthTo)) return false;
  if (Array.isArray(rule.sources) && rule.sources.length) {
    if (!rule.sources.includes(transaction?.source)) return false;
  }
  return true;
}

export function matchingCategoryRules(transaction, rules = []) {
  return rules
    .filter(rule => categoryRuleMatches(rule, transaction))
    .sort((left, right) => categoryRuleScore(right) - categoryRuleScore(left)
      || String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
      || String(left.id || '').localeCompare(String(right.id || '')));
}

export function bestCategoryRule(transaction, rules = []) {
  return matchingCategoryRules(transaction, rules)[0] || null;
}

function transactionOwnerOf(state, transaction) {
  if (transaction?.profileId !== undefined && transaction?.profileId !== null) return transaction.profileId;
  return (state.accounts || []).find(account => account.id === transaction?.accountId)?.profileId ?? null;
}

/**
 * Apply enabled rules to transactions that have not been edited by hand.
 * Rules only own the override they set themselves; disabling or deleting a
 * rule restores the provider category. Manual category edits are never
 * overwritten because `categoryEditVersion` marks them.
 */
export function applyCategoryRules(state, { onlyIds = null } = {}) {
  const rules = (state.categoryRules || []).filter(rule => rule.enabled !== false);
  const changed = [];
  for (const transaction of state.transactions || []) {
    if (onlyIds && !onlyIds.has(transaction.id)) continue;
    if (Number.isSafeInteger(transaction.categoryEditVersion) && transaction.categoryEditVersion > 0) continue;
    const owner = transactionOwnerOf(state, transaction);
    const match = matchingCategoryRules(transaction, rules).find(rule => !rule.profileId || rule.profileId === owner) || null;
    const before = {
      override: transaction.override ?? null,
      overrideCategoryId: transaction.overrideCategoryId ?? null,
      ruleId: transaction.ruleId ?? null
    };
    if (match) {
      if (before.override === match.category && before.overrideCategoryId === match.categoryId && before.ruleId === match.id) continue;
      transaction.override = match.category;
      transaction.overrideCategoryId = match.categoryId;
      transaction.ruleId = match.id;
      transaction.ruleAppliedAt = new Date().toISOString();
      changed.push({ id: transaction.id, before, after: { override: match.category, overrideCategoryId: match.categoryId, ruleId: match.id } });
    } else if (transaction.ruleId) {
      delete transaction.override;
      delete transaction.overrideCategoryId;
      delete transaction.ruleId;
      delete transaction.ruleAppliedAt;
      changed.push({ id: transaction.id, before, after: { override: transaction.category ?? null, overrideCategoryId: transaction.categoryId ?? null, ruleId: null }, cleared: true });
    }
  }
  return changed;
}

export function isPeerToPeerTransaction(transaction) {
  if (PEER_TO_PEER_PATTERN.test(String(transaction?.merchant || ''))) return true;
  return (transaction?.counterparties || []).some(counterparty => counterparty && ['person', 'payment_app'].includes(counterparty.type));
}

export function buildCounterLegIndex(transactions = []) {
  const index = new Map();
  for (const transaction of transactions) {
    if (transaction.pending || !Number.isSafeInteger(transaction.amount)) continue;
    const key = String(Math.abs(transaction.amount));
    const rows = index.get(key);
    if (rows) rows.push(transaction);
    else index.set(key, [transaction]);
  }
  return index;
}

export function hasCounterLeg(transaction, index) {
  const rows = index.get(String(Math.abs(transaction.amount))) || [];
  const date = Date.parse(`${transaction.date}T12:00:00Z`);
  if (!Number.isFinite(date)) return false;
  return rows.some(other => other.id !== transaction.id
    && other.accountId !== transaction.accountId
    && other.amount === -transaction.amount
    && Number.isFinite(Date.parse(`${other.date}T12:00:00Z`))
    && Math.abs(Date.parse(`${other.date}T12:00:00Z`) - date) <= 5 * DAY_MS);
}

export function reviewFingerprint(transaction) {
  return JSON.stringify([
    transaction.amount,
    transaction.date,
    transaction.merchant || '',
    transaction.accountId || '',
    transaction.override || '',
    transaction.overrideCategoryId || '',
    transaction.ruleId || '',
    transaction.confidence || null,
    transaction.personalFinanceCategory?.confidence || null
  ]);
}

export function reviewReasonFor(transaction, { counterLeg } = {}) {
  const category = transaction.override || transaction.category;
  // A rule explicitly resolved this transaction, regardless of category.
  // Such transactions are never flagged as needing review.
  if (transaction.ruleId) return null;
  if (category === 'Other') return 'Uncategorized';
  if (category !== 'Transfers') {
    if (transaction.confidence !== undefined && transaction.confidence < 0.5) return 'Low-confidence category';
    return null;
  }
  if (isPeerToPeerTransaction(transaction)) return 'Peer-to-peer transfer needs a category';
  if (!counterLeg) return 'Transfer has no matching account leg';
  return null;
}

/**
 * Recompute persisted review flags. A full refresh rebuilds the counter-leg
 * cache used by later single-transaction edits, which only touch the rows in a
 * transaction subset.
 */
export function refreshReviewFlags(state, { full = true, onlyIds = null } = {}) {
  const transactions = state.transactions || [];
  const index = full ? buildCounterLegIndex(transactions) : null;
  let flagged = 0;
  for (const transaction of transactions) {
    if (onlyIds && !onlyIds.has(transaction.id)) continue;
    let counterLeg;
    if (full) {
      counterLeg = hasCounterLeg(transaction, index);
      transaction.hasCounterLeg = counterLeg;
    } else {
      counterLeg = transaction.hasCounterLeg === true;
    }
    const reason = reviewReasonFor(transaction, { counterLeg });
    if (reason) {
      if (transaction.reviewedAt && transaction.reviewFingerprint === reviewFingerprint(transaction)) {
        transaction.review = false;
        delete transaction.reviewReason;
      } else {
        transaction.review = true;
        transaction.reviewReason = reason;
        flagged += 1;
      }
    } else {
      transaction.review = false;
      delete transaction.reviewReason;
    }
  }
  return flagged;
}

export const CATEGORY_RULE_DEFAULTS_VERSION = 1;

// Seeded once per install. Rules are matched by merchant text (case-insensitive
// substring) plus optional amount/account/counterparty constraints. Users can
// disable or delete any of them; a defaults-version marker keeps deleted rules
// from coming back on the next sync.
export const DEFAULT_CATEGORY_RULES = Object.freeze([
  { key: 'nathan-thurston-income', merchant: 'NATHAN THURSTON', categoryName: 'Income' },
  { key: 'lmcu-south-haven-mortgage', merchant: 'LMCU South Haven Mortgage', categoryName: 'Rental Mortgage' },
  { key: 'card-autopay-mobile', merchant: 'Payment Thank You-Mobile', categoryName: 'Transfers' },
  { key: 'chase-card-payment', merchant: 'Payment to Chase card', categoryName: 'Transfers' },
  { key: 'fidelity-transfer', merchant: 'Fidelity', categoryName: 'Transfers' },
  { key: 'coinbase-transfer', merchant: 'Coinbase', categoryName: 'Transfers' },
  { key: 'online-transfer', merchant: 'Online Transfer', categoryName: 'Transfers' },
  { key: 'share-transfer-to', merchant: 'Transfer To Share', categoryName: 'Transfers' },
  { key: 'share-transfer-from', merchant: 'Transfer From Share', categoryName: 'Transfers' },
  { key: 'jpmorgan-deposit', merchant: 'DEPOSIT JPMorgan Chase', categoryName: 'Transfers' },
  { key: 'venmo-rent-850', merchant: 'Venmo', amount: 85000, categoryName: 'Housing' },
  { key: 'venmo-rent-700', merchant: 'Venmo', amount: 70000, categoryName: 'Housing' }
]);

export function seedDefaultCategoryRules(state, catalog = [], { version = CATEGORY_RULE_DEFAULTS_VERSION, now = new Date().toISOString() } = {}) {
  if ((state.categoryRuleDefaultsVersion || 0) >= version) return 0;
  state.categoryRules ||= [];
  let added = 0;
  for (const spec of DEFAULT_CATEGORY_RULES) {
    if (state.categoryRules.some(rule => rule.defaultKey === spec.key)) continue;
    const category = catalog.find(candidate => candidate.name === spec.categoryName && !candidate.archivedAt);
    if (!category) continue;
    state.categoryRules.push({
      id: 'default:' + spec.key,
      defaultKey: spec.key,
      merchant: spec.merchant,
      counterparty: '',
      accountId: null,
      amount: Number.isSafeInteger(spec.amount) ? spec.amount : null,
      category: category.name,
      categoryId: category.id,
      profileId: category.system ? null : (category.profileId || 'peter'),
      enabled: true,
      createdAt: now
    });
    added += 1;
  }
  state.categoryRuleDefaultsVersion = version;
  return added;
}

export function reconcileTransactionAutomation(state, { seed = null } = {}) {
  if (seed) seed(state);
  const rulesChanged = applyCategoryRules(state);
  const reviewCount = refreshReviewFlags(state, { full: true });
  return { rulesChanged: rulesChanged.length, reviewCount };
}

export function markTransactionsReviewed(transactions, { reviewed = true, at = new Date().toISOString() } = {}) {
  for (const transaction of transactions) {
    if (reviewed) {
      transaction.reviewedAt = at;
      transaction.reviewFingerprint = reviewFingerprint(transaction);
    } else {
      delete transaction.reviewedAt;
      delete transaction.reviewFingerprint;
    }
  }
}
