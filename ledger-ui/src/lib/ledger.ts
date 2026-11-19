export type ProfileId = "combined" | "peter" | "maddie" | "joint"

export const PROFILE_OPTIONS: ReadonlyArray<{
  value: ProfileId
  label: string
}> = [
  { value: "combined", label: "Combined Budget" },
  { value: "peter", label: "Peter" },
  { value: "maddie", label: "Maddie" },
  { value: "joint", label: "Joint" },
]

export type PageId =
  | "overview"
  | "transactions"
  | "budgets"
  | "commitments"
  | "accounts"
  | "investments"
  | "goals"
  | "home"
  | "settings"

export const PAGE_TITLES: Record<PageId, string> = {
  overview: "Overview",
  transactions: "Transactions",
  budgets: "Budgets",
  commitments: "Bills",
  accounts: "Accounts",
  investments: "Investments",
  goals: "Goals",
  home: "Home planner",
  settings: "Settings",
}

export const PAGE_DESCRIPTIONS: Record<PageId, string> = {
  overview: "A clearer picture of your money, all in one place.",
  transactions: "The details behind your day to day.",
  budgets: "Make room for what matters to you.",
  commitments: "Track recurring bills by their actual due dates.",
  accounts: "Connect banks or record accounts you manage manually.",
  investments: "See investment accounts and their reported holdings.",
  goals: "Plan savings using eligible cash you already hold.",
  home: "Record a property or compare a hypothetical purchase.",
  settings: "Connection, data freshness, and local recovery status.",
}

export type LedgerRecord = Record<string, unknown>

export type Account = LedgerRecord & {
  id: string
  name: string
  balance?: number | null
  currency?: string
  profileId?: string | null
  manual?: boolean
  source?: string | null
  archivedAt?: string | null
  type?: string
  subtype?: string | null
  mask?: string | null
  itemId?: string | null
  includeInReporting?: boolean
}

export type Category = LedgerRecord & {
  id: string
  name: string
  kind?: string
  system?: boolean
  archivedAt?: string | null
  profileId?: string | null
  order?: number
}

export type Transaction = LedgerRecord & {
  id: string
  date: string
  merchant?: string
  amount: number
  currency?: string
  category?: string
  override?: string
  review?: boolean
  reviewReason?: string
  reviewedAt?: string
  pending?: boolean
  accountId?: string
  profileId?: string | null
  categoryEditVersion?: number
  confidence?: number
  source?: string
}

export type BudgetTemplate = LedgerRecord & {
  categoryId: string
  amount: number
  effectiveFrom?: string
  effectiveTo?: string | null
}

export type BudgetSummary = LedgerRecord & {
  month?: string
  categories?: Record<string, number>
  income?: number
  activity?: Record<string, number>
  plannedIncome?: number | null
  projectedIncome?: number | null
  plannedSpending?: number | null
  remaining?: number | null
  rollovers?: Record<string, number>
  coverage?: LedgerRecord
  warnings?: string[]
  unassignedActual?: number
}

export type MonthSummary = LedgerRecord & {
  month?: string
  current?: { income?: number; spending?: number; transactions?: number }
  weekly?: unknown[]
  recent?: Transaction[]
  count?: number
}

export type LedgerState = LedgerRecord & {
  revision: number
  accounts: Account[]
  transactions: Transaction[]
  categoryCatalog: Category[]
  categories: string[]
  items: Array<LedgerRecord & { id: string; lastSync?: string | null; error?: unknown }>
  reviewCount: number
  lastReview?: { reviewedAt: string; ids: string[] } | null
  budgets: Record<string, number | null>
  budgetTemplates: BudgetTemplate[]
  monthlyBudgets: Record<string, number>
  monthlyBudgetSchedules: Record<string, unknown>
  budgetTemplateSchedules: Record<string, unknown>
  incomePlanTemplates: BudgetTemplate[]
  monthlyIncomePlans: Record<string, number>
  monthlyBudgetOutlooks: Record<string, unknown>
  annualIncomeRecords: Array<LedgerRecord & { year: string; amount: number }>
  annualGrossIncomeRecords: Array<LedgerRecord & { year: string; amount: number }>
  categoryRules: Array<LedgerRecord & { id: string; enabled?: boolean }>
  commitments: Array<LedgerRecord & { id: string }>
  commitmentMatches: Array<LedgerRecord>
  goalSummary?: LedgerRecord
  goals?: Array<LedgerRecord & { id: string }>
  properties?: Array<LedgerRecord & { id: string }>
  mortgages?: Array<LedgerRecord & { id: string }>
  balanceSheet?: LedgerRecord
  scenarios?: Array<LedgerRecord & { id: string }>
  importBatches?: Array<LedgerRecord & { id: string }>
  transactionSplits?: Array<LedgerRecord>
  transactionReimbursements?: Array<LedgerRecord>
  setup?: {
    localOnly?: boolean
    configured?: boolean
    environment?: string
    syncTimer?: LedgerRecord
    backup?: LedgerRecord
  }
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})
const compactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 0,
})

export function assertCents(value: number) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Expected integer cents, received ${value}`)
  }
}

export function formatCents(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return "Not recorded"
  assertCents(cents)
  return currency.format(cents / 100)
}

export function formatCompactCents(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return "Not recorded"
  return compactCurrency.format(Math.round(cents) / 100)
}

export function formatSignedCents(cents: number) {
  assertCents(cents)
  const sign = cents < 0 ? "+" : "−"
  return `${sign}${currency.format(Math.abs(cents) / 100)}`
}

export function formatDollarsInput(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return ""
  assertCents(cents)
  return (cents / 100).toFixed(2)
}

export function parseDollarsToCents(value: string) {
  const text = value.trim().replace(/[$,]/g, "")
  if (!text) return null
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null
  const negative = text.startsWith("-")
  const [whole, fraction = ""] = text.replace("-", "").split(".")
  const cents =
    Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}

export function formatDate(isoDate: string | undefined) {
  if (!isoDate) return "—"
  const parts = isoDate.slice(0, 10).split("-").map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return isoDate
  }
  const [year, month, day] = parts as [number, number, number]
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: year === new Date().getUTCFullYear() ? undefined : "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

export function formatMonthLabel(month: string) {
  const [year, number] = month.split("-").map(Number)
  if (!year || !number) return month
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, number - 1, 1)))
}

export function currentMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

export function monthShift(month: string, offset: number) {
  const [year, number] = month.split("-").map(Number)
  const date = new Date(Date.UTC(year, number - 1 + offset, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

export function profileLabel(profile: ProfileId) {
  return PROFILE_OPTIONS.find((option) => option.value === profile)?.label ?? "Combined Budget"
}

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export function asRecord(value: unknown): LedgerRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LedgerRecord)
    : {}
}

export function transactionCategory(transaction: Transaction) {
  return transaction.override || transaction.category || "Uncategorized"
}

export function accountName(state: LedgerState | null, accountId?: string | null) {
  if (!accountId || !state) return "Unknown account"
  return state.accounts.find((account) => account.id === accountId)?.name ?? "Unknown account"
}

export function reviewReason(transaction: Transaction) {
  if (transaction.reviewReason) return transaction.reviewReason
  const category = transactionCategory(transaction)
  if (category === "Transfers") return "Transfer needs a matching account leg"
  if (category === "Other" || category === "Uncategorized") return "Uncategorized"
  const confidence = transaction.confidence
  if (typeof confidence === "number" && confidence < 0.7) {
    return "Low-confidence category"
  }
  if (transaction.pending) return "Pending transaction"
  return "Needs review"
}

export function isReviewable(transaction: Transaction) {
  return (
    transaction.review === true ||
    transaction.review === undefined &&
      (transaction.reviewReason !== undefined ||
        transactionCategory(transaction) === "Other" ||
        transactionCategory(transaction) === "Uncategorized" ||
        transactionCategory(transaction) === "Transfers")
  )
}

export function reviewableTransactions(state: LedgerState | null) {
  if (!state) return []
  return state.transactions.filter(isReviewable)
}

export function signedNetCents(transactions: readonly Transaction[]) {
  return transactions.reduce((total, transaction) => {
    if (!Number.isSafeInteger(transaction.amount)) return total
    return total + transaction.amount
  }, 0)
}

export function spendingCents(transactions: readonly Transaction[]) {
  return transactions.reduce(
    (total, transaction) =>
      transaction.amount > 0 ? total + transaction.amount : total,
    0
  )
}

export function incomeCents(transactions: readonly Transaction[]) {
  return transactions.reduce(
    (total, transaction) =>
      transaction.amount < 0 ? total - transaction.amount : total,
    0
  )
}

export function budgetKey(month: string, categoryId: string) {
  return `${month}:${categoryId}`
}

export function resolveBudgetAmount(
  state: LedgerState,
  categoryId: string,
  month: string
): number | null {
  const override = state.monthlyBudgets[budgetKey(month, categoryId)]
  if (Number.isSafeInteger(override)) return override
  const templates = [...state.budgetTemplates]
    .filter((template) => template.categoryId === categoryId)
    .sort((a, b) => String(a.effectiveFrom ?? "").localeCompare(String(b.effectiveFrom ?? "")))
  let amount: number | null = null
  for (const template of templates) {
    if (String(template.effectiveFrom ?? "") > month) break
    if (
      Number.isSafeInteger(template.amount) &&
      (!template.effectiveTo || String(template.effectiveTo) >= month)
    ) {
      amount = template.amount
    }
  }
  return amount
}

export function setupWarnings(state: LedgerState | null) {
  if (!state?.setup) return []
  const warnings: string[] = []
  const backup = asRecord(state.setup.backup)
  const syncTimer = asRecord(state.setup.syncTimer)
  if (backup.state && !["current", "not-configured"].includes(String(backup.state))) {
    warnings.push(`Backup: ${String(backup.state).replaceAll("-", " ")}`)
  }
  if (syncTimer.state && !["active", "enabled", "not-configured"].includes(String(syncTimer.state))) {
    warnings.push(`Bank update schedule: ${String(syncTimer.state).replaceAll("-", " ")}`)
  }
  return warnings
}
