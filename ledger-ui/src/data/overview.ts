export type OverviewTransaction = {
  id: string
  date: string
  merchant: string
  category: string
  account: string
  amountCents: number
}

export type TrendPoint = {
  month: string
  recordedCents: number
  plannedCents: number
}

export type OverviewMetric = {
  id: string
  label: string
  valueCents: number
  note: string
  kind: "recorded" | "plan"
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

function assertCents(value: number) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Expected integer cents, received ${value}`)
  }
}

export function formatCents(cents: number) {
  assertCents(cents)
  return currency.format(cents / 100)
}

export function formatCompactCents(cents: number) {
  return compactCurrency.format(Math.round(cents) / 100)
}

export function formatSignedCents(cents: number) {
  assertCents(cents)
  const sign = cents < 0 ? "+" : "−"
  return `${sign}${currency.format(Math.abs(cents) / 100)}`
}

export function formatTransactionDate(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number)
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

// Positive cents are money out; negative cents are money in, matching the
// signed-cent representation used by the existing ledger API.
export const recentTransactions: readonly OverviewTransaction[] = [
  {
    id: "preview-0414-green-grocer",
    date: "2026-04-14",
    merchant: "Green Grocer",
    category: "Groceries",
    account: "Everyday checking",
    amountCents: 8450,
  },
  {
    id: "preview-0413-transit",
    date: "2026-04-13",
    merchant: "Transit pass",
    category: "Transport",
    account: "Everyday checking",
    amountCents: 5600,
  },
  {
    id: "preview-0412-electricity",
    date: "2026-04-12",
    merchant: "Electricity",
    category: "Utilities",
    account: "Joint checking",
    amountCents: 18425,
  },
  {
    id: "preview-0410-payroll",
    date: "2026-04-10",
    merchant: "Employer deposit",
    category: "Income",
    account: "Everyday checking",
    amountCents: -385000,
  },
  {
    id: "preview-0408-pharmacy",
    date: "2026-04-08",
    merchant: "Pharmacy",
    category: "Health",
    account: "Everyday checking",
    amountCents: 3270,
  },
  {
    id: "preview-0406-supplies",
    date: "2026-04-06",
    merchant: "Household supplies",
    category: "Household",
    account: "Joint checking",
    amountCents: 5000,
  },
  {
    id: "preview-0405-rent",
    date: "2026-04-05",
    merchant: "Rent",
    category: "Housing",
    account: "Joint checking",
    amountCents: 88200,
  },
]

const plannedAllowanceCents = 250000

const recordedSpendingCents = recentTransactions
  .filter((transaction) => transaction.amountCents > 0)
  .reduce((total, transaction) => total + transaction.amountCents, 0)

const recordedIncomeCents = -recentTransactions
  .filter((transaction) => transaction.amountCents < 0)
  .reduce((total, transaction) => total + transaction.amountCents, 0)

export const overviewMetrics: readonly OverviewMetric[] = [
  {
    id: "spending",
    label: "Recorded spending",
    valueCents: recordedSpendingCents,
    note: "7 posted purchases · 1–14 April",
    kind: "recorded",
  },
  {
    id: "income",
    label: "Recorded income",
    valueCents: recordedIncomeCents,
    note: "1 posted deposit",
    kind: "recorded",
  },
  {
    id: "cash-flow",
    label: "Actual cash flow",
    valueCents: recordedIncomeCents - recordedSpendingCents,
    note: "Recorded income less spending",
    kind: "recorded",
  },
  {
    id: "allowance",
    label: "Category allowance left",
    valueCents: plannedAllowanceCents - recordedSpendingCents,
    note: `${formatCents(plannedAllowanceCents)} plan · not a bank balance`,
    kind: "plan",
  },
]

export const monthlyTrend: readonly TrendPoint[] = [
  { month: "Oct", recordedCents: 142310, plannedCents: plannedAllowanceCents },
  { month: "Nov", recordedCents: 168940, plannedCents: plannedAllowanceCents },
  { month: "Dec", recordedCents: 213760, plannedCents: plannedAllowanceCents },
  { month: "Jan", recordedCents: 119880, plannedCents: plannedAllowanceCents },
  { month: "Feb", recordedCents: 134220, plannedCents: plannedAllowanceCents },
  { month: "Mar", recordedCents: 157620, plannedCents: plannedAllowanceCents },
  {
    month: "Apr",
    recordedCents: recordedSpendingCents,
    plannedCents: plannedAllowanceCents,
  },
]
