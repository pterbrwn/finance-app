import { hasLowConfidence } from './reporting.mjs';

const PEER_TO_PEER_PATTERN = /(^|[^a-z])(venmo|cash app|paypal|zelle)([^a-z]|$)/i;
const DAY_MS = 86_400_000;
const COUNTER_LEG_WINDOW_DAYS = 5;

export function normalizeRuleText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function categoryRuleConstraintCount(rule = {}) {
  return (rule.merchant ? 1 : 0) + (rule.counterparty ? 1 : 0) + (rule.accountId ? 1 : 0) + (Number.isSafeInteger(rule.amount) ? 1 : 0)
    + (rule.monthFrom ? 1 : 0) + (rule.monthTo ? 1 : 0) + (Array.isArray(rule.sources) && rule.sources.length ? 1 : 0);
}

// More constraints win first. Within the same constraint count, amount >
// account > date bounds > sources > counterparty > merchant, then longer text.
// Constraint count is the widest band, so a source-only rule can never beat a
// narrower merchant+account+amount rule.
export function categoryRuleScore(rule = {}) {
  const constraints = categoryRuleConstraintCount(rule);
  let score = constraints * 1_000_000;
  if (Number.isSafeInteger(rule.amount)) score += 100_000;
  if (rule.accountId) score += 50_000;
  if (rule.monthFrom) score += 20_000;
  if (rule.monthTo) score += 20_000;
  if (Array.isArray(rule.sources) && rule.sources.length) score += 10_000;
  if (rule.counterparty) score += 5_000 + Math.min(normalizeRuleText(rule.counterparty).length, 200);
  if (rule.merchant) score += 1_000 + Math.min(normalizeRuleText(rule.merchant).length, 200);
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

function counterLegDay(transaction) {
  const value = Date.parse(`${transaction?.date}T12:00:00Z`);
  return Number.isFinite(value) ? value : null;
}

function canHaveCounterLeg(transaction) {
  return !!transaction && !transaction.pending && Number.isSafeInteger(transaction.amount) && transaction.amount !== 0
    && typeof transaction.accountId === 'string' && !!transaction.accountId
    && typeof transaction.currency === 'string' && !!transaction.currency && transaction.currency !== 'UNKNOWN';
}

export function buildCounterLegIndex(transactions = []) {
  const index = new Map();
  for (const transaction of transactions) {
    if (!canHaveCounterLeg(transaction)) continue;
    const key = `${transaction.currency}:${Math.abs(transaction.amount)}`;
    const rows = index.get(key);
    if (rows) rows.push(transaction);
    else index.set(key, [transaction]);
  }
  // Pair one-to-one inside each currency/amount bucket. A row with more than
  // one viable counterpart is ambiguous and stays reviewable instead of
  // borrowing another transfer's leg.
  const pairs = new Map();
  const ambiguous = new Set();
  for (const rows of index.values()) {
    const sorted = [...rows].sort((left, right) => String(left.date || '').localeCompare(String(right.date || '')) || String(left.id || '').localeCompare(String(right.id || '')));
    const candidatesFor = new Map();
    for (const row of sorted) {
      const day = counterLegDay(row);
      const candidates = day === null ? [] : sorted.filter(other => {
        if (other.id === row.id) return false;
        if (other.amount !== -row.amount || other.accountId === row.accountId) return false;
        const otherDay = counterLegDay(other);
        return otherDay !== null && Math.abs(otherDay - day) <= COUNTER_LEG_WINDOW_DAYS * DAY_MS;
      });
      candidatesFor.set(row.id, candidates);
      if (candidates.length > 1) {
        ambiguous.add(row.id);
        for (const candidate of candidates) ambiguous.add(candidate.id);
      }
    }
    const used = new Set();
    for (const row of sorted) {
      if (used.has(row.id) || ambiguous.has(row.id)) continue;
      const partner = (candidatesFor.get(row.id) || []).find(candidate => !used.has(candidate.id) && !ambiguous.has(candidate.id));
      if (!partner) continue;
      used.add(row.id);
      used.add(partner.id);
      pairs.set(row.id, partner.id);
      pairs.set(partner.id, row.id);
    }
  }
  index.pairs = pairs;
  index.ambiguous = ambiguous;
  return index;
}

export function hasCounterLeg(transaction, index) {
  return index?.pairs?.get(transaction?.id) !== undefined;
}

export function counterLegIsAmbiguous(transaction, index) {
  return index?.ambiguous?.has(transaction?.id) === true;
}

export function reviewFingerprint(transaction) {
  return JSON.stringify([
    transaction.amount,
    transaction.currency || '',
    transaction.date,
    transaction.merchant || '',
    transaction.accountId || '',
    transaction.pending === true,
    transaction.override || '',
    transaction.overrideCategoryId || '',
    transaction.ruleId || '',
    transaction.confidence || null,
    transaction.personalFinanceCategory?.confidence || null
  ]);
}

export function reviewReasonFor(transaction, { counterLeg, ambiguous = false } = {}) {
  const category = transaction.override || transaction.category;
  if (category === 'Other') return 'Uncategorized';
  if (category !== 'Transfers') {
    if (hasLowConfidence(transaction)) return 'Low-confidence category';
    return null;
  }
  if (isPeerToPeerTransaction(transaction)) return 'Peer-to-peer transfer needs a category';
  if (ambiguous) return 'Transfer matches more than one account leg';
  if (!counterLeg) return 'Transfer has no matching account leg';
  return null;
}

/**
 * Recompute persisted review flags. A full refresh rebuilds the one-to-one
 * counter-leg cache used by later single-transaction edits, which only touch
 * the rows in a transaction subset.
 */
export function refreshReviewFlags(state, { full = true, onlyIds = null } = {}) {
  const transactions = state.transactions || [];
  const index = full ? buildCounterLegIndex(transactions) : null;
  let flagged = 0;
  for (const transaction of transactions) {
    if (onlyIds && !onlyIds.has(transaction.id)) continue;
    let counterLeg, ambiguous;
    if (full) {
      counterLeg = hasCounterLeg(transaction, index);
      ambiguous = counterLegIsAmbiguous(transaction, index);
      transaction.hasCounterLeg = counterLeg;
      if (ambiguous) transaction.counterLegAmbiguous = true;
      else delete transaction.counterLegAmbiguous;
    } else {
      counterLeg = transaction.hasCounterLeg === true;
      ambiguous = transaction.counterLegAmbiguous === true;
    }
    const reason = reviewReasonFor(transaction, { counterLeg: counterLeg && !ambiguous, ambiguous });
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

export const CATEGORY_RULE_DEFAULTS_VERSION = 2;

// Distributable defaults are intentionally empty after version 2. Merchant and
// amount rules that describe one household belong to an explicit user-created
// rule, not to every installation. Users can still create, preview, disable,
// and delete their own rules.
export const DEFAULT_CATEGORY_RULES = Object.freeze([]);

export function seedDefaultCategoryRules(state, catalog = [], { version = CATEGORY_RULE_DEFAULTS_VERSION, now = new Date().toISOString() } = {}) {
  // Earlier upgrades could persist the retired rule list without updating every
  // transaction. Repair those orphaned references even after the version marker.
  const knownRuleIds = new Set((state.categoryRules || []).map(rule => rule.id));
  for (const transaction of state.transactions || []) {
    if (!String(transaction.ruleId || '').startsWith('default:') || knownRuleIds.has(transaction.ruleId)) continue;
    delete transaction.ruleId;
    delete transaction.ruleAppliedAt;
    if (transaction.override !== undefined || transaction.overrideCategoryId !== undefined) {
      transaction.categoryEditVersion = Math.max(1, Number.isSafeInteger(transaction.categoryEditVersion) ? transaction.categoryEditVersion : 0);
    }
  }
  if ((state.categoryRuleDefaultsVersion || 0) >= version) return 0;
  state.categoryRules ||= [];
  // Retire untouched rules that an older release seeded automatically. Rules a
  // user edited or disabled keep their updatedAt/enabled state and are kept.
  const retiredRuleIds = new Set(state.categoryRules.filter(rule => rule && rule.defaultKey
    && rule.id === 'default:' + rule.defaultKey && !rule.updatedAt && rule.enabled !== false).map(rule => rule.id));
  state.categoryRules = state.categoryRules.filter(rule => !(rule && rule.defaultKey
    && rule.id === 'default:' + rule.defaultKey && !rule.updatedAt && rule.enabled !== false));
  // Preserve classifications owned by a retired default. Migration must not
  // silently recategorize historical records when distributable defaults change.
  for (const transaction of state.transactions || []) {
    if (!retiredRuleIds.has(transaction.ruleId)) continue;
    delete transaction.ruleId;
    delete transaction.ruleAppliedAt;
    if (transaction.override !== undefined) {
      transaction.categoryEditVersion = Math.max(1, Number.isSafeInteger(transaction.categoryEditVersion) ? transaction.categoryEditVersion : 0);
    }
  }
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
