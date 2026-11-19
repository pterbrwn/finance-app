import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  ChartLineData01Icon,
  FlaskConicalIcon,
  ReceiptTextIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { PageShell } from "@/components/page-shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useLedger } from "@/context/ledger-context"
import { monthlyTrend, overviewMetrics, recentTransactions } from "@/data/overview"
import {
  useHouseholdSummary,
  useMonthSummary,
} from "@/hooks/use-ledger-resource"
import {
  PAGE_DESCRIPTIONS,
  PAGE_TITLES,
  accountName,
  asArray,
  asRecord,
  formatCents,
  formatCompactCents,
  formatDate,
  formatMonthLabel,
  formatSignedCents,
  isReviewable,
  profileLabel,
  transactionCategory,
  type LedgerRecord,
  type LedgerState,
  type Transaction,
} from "@/lib/ledger"
import { cn } from "cn"

type Tone = "good" | "warn" | "error" | "muted"

type StatusView = {
  label: string
  tone: Tone
}

type MetricView = {
  id: string
  label: string
  value: number | null
  kind: "recorded" | "plan"
  note: string
  loading?: boolean
}

type ChartRow = {
  label: string
  recorded: number | null
  planned: number | null
}

type TransactionView = {
  id: string
  date: string
  merchant: string
  category: string
  account: string
  amount: number | null
  review: boolean
}

type DetailRow = {
  label: string
  value: string
  hint?: string
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}

function formatTimestamp(value: unknown) {
  if (typeof value !== "string" || !value) return "Not recorded"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? "Not recorded" : parsed.toLocaleString()
}

function statusLabel(value: unknown) {
  if (typeof value !== "string" || !value) return "Not recorded"
  const labels: Record<string, string> = {
    success: "Current",
    current: "Current",
    complete: "Complete",
    failed: "Failed",
    error: "Error",
    stale: "Stale",
    incomplete: "Incomplete",
    unverified: "Unverified",
    "never run": "Never run",
    "not run": "Never run",
    "not configured": "Not configured",
    unavailable: "Unknown",
    unknown: "Unknown",
    available: "Available",
    enabled: "Enabled",
    disabled: "Disabled",
    active: "Active",
    inactive: "Inactive",
    manual: "Manual / CSV",
  }
  const key = value.replaceAll("-", " ").replaceAll("_", " ").toLowerCase()
  return labels[key] ?? key.replace(/^./, (letter) => letter.toUpperCase())
}

function badgeVariant(tone: Tone): "secondary" | "outline" | "destructive" {
  if (tone === "good") return "secondary"
  if (tone === "error") return "destructive"
  return "outline"
}

function bankStatus(state: LedgerState | null): StatusView {
  const items = asArray<LedgerRecord>(state?.items)
  if (!items.length) {
    const setup = asRecord(state?.setup)
    return setup.localOnly === true
      ? { label: "Local only", tone: "muted" }
      : { label: "No connections", tone: "muted" }
  }
  if (items.some((item) => item.error)) {
    return { label: "Needs attention", tone: "warn" }
  }
  if (items.every((item) => typeof item.lastSync === "string" && item.lastSync)) {
    return { label: "Connected", tone: "good" }
  }
  return { label: "First sync pending", tone: "warn" }
}

function backupStatus(state: LedgerState | null): StatusView {
  const backup = asRecord(asRecord(state?.setup).backup)
  const raw = typeof backup.state === "string" ? backup.state : ""
  const key = raw.replaceAll("-", " ").replaceAll("_", " ").toLowerCase()
  if (!key) return { label: "Not recorded", tone: "muted" }
  if (key === "not configured") {
    return { label: "Not configured", tone: "muted" }
  }
  const recovery =
    typeof backup.recoveryState === "string"
      ? backup.recoveryState.replaceAll("-", " ").toLowerCase()
      : ""
  const incomplete =
    backup.recoveryStale === true ||
    ["database only", "not configured", "incomplete"].includes(recovery)
  if (["current", "success", "complete"].includes(key)) {
    return incomplete
      ? { label: "Recovery incomplete", tone: "warn" }
      : { label: "Current", tone: "good" }
  }
  if (
    ["failed", "error", "stale", "incomplete", "unverified", "never run", "not run"].includes(
      key
    )
  ) {
    return { label: statusLabel(raw), tone: "warn" }
  }
  return { label: statusLabel(raw), tone: "muted" }
}

function truncateLabel(value: string, max = 14) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function StatusItem({ label, status }: { label: string; status: StatusView }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Badge variant={badgeVariant(status.tone)}>{status.label}</Badge>
    </div>
  )
}

export function OverviewPage() {
  const {
    loading: stateLoading,
    month,
    preview,
    profile,
    refresh,
    refreshing,
    stale: stateStale,
    state,
  } = useLedger()
  const summary = useMonthSummary(month, profile)
  const household = useHouseholdSummary(month, profile)

  const balanceSheet = asRecord(state?.balanceSheet)
  const balanceTotals = asRecord(balanceSheet.totals)
  const current = asRecord(asRecord(summary.data).current)
  const categories = asRecord(current.categories)
  const householdData = asRecord(household.data)
  const planScope = preview
    ? asRecord(null)
    : profile === "combined"
      ? asRecord(householdData.household)
      : asRecord(asRecord(householdData.profiles)[profile])
  const setup = asRecord(state?.setup)
  const backupSetup = asRecord(setup.backup)
  const syncTimer = asRecord(setup.syncTimer)

  const purchases = safeInteger(current.purchases)
  const spend = safeInteger(current.spend)
  const income = safeInteger(current.income)
  const plannedSpending = safeInteger(planScope.plannedSpending)
  const plannedRemaining = safeInteger(planScope.plannedSurplus)
  const hasNetWorth = Object.hasOwn(balanceTotals, "netWorth")
  const netWorth = safeInteger(balanceTotals.netWorth)
  const reviewCount = preview ? null : safeInteger(state?.reviewCount)
  const revision = preview ? null : safeInteger(state?.revision)
  const includedAccounts = safeInteger(asRecord(balanceSheet.coverage).includedAccounts)
  const accountCount = preview
    ? null
    : (safeInteger(asRecord(balanceSheet.coverage).accountCount) ??
      asArray<LedgerRecord>(state?.accounts).length)

  const planNote = household.error
    ? "Saved plan unavailable"
    : household.loading && !household.data
      ? "Loading saved plan"
      : "Saved plan · not a bank balance"
  const netWorthNote =
    typeof balanceSheet.netWorthLabel === "string" && balanceSheet.netWorthLabel
      ? balanceSheet.netWorthLabel
      : "From recorded balances · not spendable cash"

  const metrics: MetricView[] = preview
    ? overviewMetrics.map((metric) => ({
        id: metric.id,
        label: metric.label,
        value: metric.valueCents,
        kind: metric.kind,
        note: metric.note,
      }))
    : [
        {
          id: "spending",
          label: "Recorded spending",
          value: spend,
          kind: "recorded",
          note:
            purchases === null
              ? `Posted purchases · ${formatMonthLabel(month)}`
              : `${purchases} posted purchase${purchases === 1 ? "" : "s"} · ${formatMonthLabel(month)}`,
          loading: summary.loading && !summary.data,
        },
        {
          id: "income",
          label: "Recorded income",
          value: income,
          kind: "recorded",
          note: "Posted deposits this month",
          loading: summary.loading && !summary.data,
        },
        {
          id: "planned-spending",
          label: "Planned spending",
          value: plannedSpending,
          kind: "plan",
          note: planNote,
          loading: household.loading && !household.data,
        },
        {
          id: "planned-remaining",
          label: "Planned surplus / shortfall",
          value: plannedRemaining,
          kind: "plan",
          note: "Projected income less planned spending · plan only",
          loading: household.loading && !household.data,
        },
      ]

  if (!preview && hasNetWorth) {
    metrics.push({
      id: "net-worth",
      label: "Net worth",
      value: netWorth,
      kind: "recorded",
      note: netWorthNote,
      loading: stateLoading && !state,
    })
  }

  const chartRows: ChartRow[] = preview
    ? monthlyTrend.map((point) => ({
        label: point.month,
        recorded: safeInteger(point.recordedCents),
        planned: safeInteger(point.plannedCents),
      }))
    : Object.entries(categories)
        .flatMap(([name, value]) => {
          const cents = safeInteger(value)
          if (cents === null || cents === 0) return []
          return [{ label: name, recorded: Math.abs(cents), planned: null }]
        })
        .sort((a, b) => b.recorded - a.recorded)
        .slice(0, 8)
  const hasPlanSeries = chartRows.some((row) => row.planned !== null)
  const chartConfig: ChartConfig = {
    recorded: {
      label: preview ? "Synthetic recorded spending" : "Recorded spending",
      color: "var(--chart-1)",
    },
    ...(hasPlanSeries
      ? {
          planned: {
            label: "Synthetic monthly plan",
            color: "var(--chart-2)",
          },
        }
      : {}),
  }

  const transactionRows: TransactionView[] = preview
    ? recentTransactions.map((transaction) => ({
        id: transaction.id,
        date: transaction.date,
        merchant: transaction.merchant,
        category: transaction.category,
        account: transaction.account,
        amount: safeInteger(transaction.amountCents),
        review: false,
      }))
    : asArray<Transaction>(state?.transactions)
        .slice()
        .sort(
          (a, b) =>
            String(b.date ?? "").localeCompare(String(a.date ?? "")) ||
            String(a.id ?? "").localeCompare(String(b.id ?? ""))
        )
        .slice(0, 6)
        .map((transaction) => ({
          id:
            typeof transaction.id === "string"
              ? transaction.id
              : String(transaction.id ?? transaction.date ?? ""),
          date: typeof transaction.date === "string" ? transaction.date : "",
          merchant:
            typeof transaction.merchant === "string" && transaction.merchant
              ? transaction.merchant
              : "Transaction",
          category: transactionCategory(transaction),
          account: accountName(
            state,
            typeof transaction.accountId === "string" ? transaction.accountId : null
          ),
          amount: safeInteger(transaction.amount),
          review: isReviewable(transaction),
        }))

  const summaryStatus: StatusView = preview
    ? { label: "Synthetic", tone: "muted" }
    : summary.error
      ? { label: "Unavailable", tone: "error" }
      : summary.loading && !summary.data
        ? { label: "Loading", tone: "muted" }
        : summary.stale
          ? { label: "Outdated", tone: "warn" }
          : summary.data
            ? { label: "Loaded", tone: "good" }
            : { label: "Not recorded", tone: "muted" }
  const recordStatus: StatusView = preview
    ? { label: "Not used", tone: "muted" }
    : stateStale
      ? { label: "Stale", tone: "warn" }
      : stateLoading && !state
        ? { label: "Loading", tone: "muted" }
        : state
          ? { label: "Loaded", tone: "good" }
          : { label: "Not recorded", tone: "muted" }
  const planStatus: StatusView = preview
    ? { label: "Synthetic", tone: "muted" }
    : household.error
      ? { label: "Unavailable", tone: "error" }
      : household.loading && !household.data
        ? { label: "Loading", tone: "muted" }
        : household.stale
          ? { label: "Outdated", tone: "warn" }
          : household.data
            ? { label: "Loaded", tone: "good" }
            : { label: "Not recorded", tone: "muted" }
  const bank = preview
    ? { label: "Not shown", tone: "muted" as Tone }
    : bankStatus(state)
  const backup = preview
    ? { label: "Not shown", tone: "muted" as Tone }
    : backupStatus(state)
  const reviewStatus: StatusView = preview
    ? { label: "Not used", tone: "muted" }
    : reviewCount === null
      ? { label: "Not recorded", tone: "muted" }
      : reviewCount > 0
        ? { label: `${reviewCount} to review`, tone: "warn" }
        : { label: "Clear", tone: "good" }
  const lastBankSync = preview
    ? null
    : asArray<LedgerRecord>(state?.items)
        .map((item) => item.lastSync)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .sort()
        .at(-1) ?? (typeof state?.lastSync === "string" ? state.lastSync : null)

  const details: DetailRow[] = preview
    ? [
        { label: "Source", value: "Local synthetic sample" },
        { label: "Saved records", value: "Not read" },
        { label: "Changes", value: "Disabled in preview" },
        { label: "Bank and backup status", value: "Not applicable" },
      ]
    : [
        {
          label: "Accounts",
          value: accountCount === null ? "Not recorded" : `${accountCount} saved`,
          hint:
            includedAccounts === null
              ? undefined
              : `${includedAccounts} included in net worth`,
        },
        {
          label: "Needs review",
          value: reviewCount === null ? "Not recorded" : `${reviewCount} transactions`,
        },
        {
          label: "Bank connections",
          value: bank.label,
          hint: bank.tone === "good" ? "Last successful sync shown below." : undefined,
        },
        { label: "Last successful bank sync", value: formatTimestamp(lastBankSync) },
        { label: "Backup status", value: backup.label },
        {
          label: "Last verified backup",
          value: formatTimestamp(backupSetup.lastSuccess),
        },
        {
          label: "Bank update schedule",
          value: statusLabel(syncTimer.state),
          hint: "A schedule is not evidence of a successful update.",
        },
        {
          label: "Saved revision",
          value: revision === null ? "Not recorded" : String(revision),
        },
        {
          label: "Month summary",
          value: summaryStatus.label,
          hint: summary.error ?? undefined,
        },
        { label: "Household plan", value: planStatus.label },
      ]

  async function refreshAll() {
    await Promise.all([refresh(), summary.refresh(), household.refresh()])
  }

  return (
    <PageShell
      title={PAGE_TITLES.overview}
      description={PAGE_DESCRIPTIONS.overview}
      actions={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {preview ? (
            <Badge variant="secondary">
              <HugeiconsIcon icon={FlaskConicalIcon} data-icon="inline-start" />
              Synthetic · no writes
            </Badge>
          ) : (
            <>
              <Badge variant="outline">{profileLabel(profile)}</Badge>
              <Badge variant="outline">{formatMonthLabel(month)}</Badge>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="min-h-11"
                onClick={() => void refreshAll()}
                disabled={refreshing}
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  data-icon="inline-start"
                  className={cn(refreshing && "animate-spin")}
                />
                Refresh
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-5">
        <Card size="sm" className="min-w-0">
          <CardHeader className="gap-1">
            <CardTitle>Data freshness</CardTitle>
            <CardDescription>
              {preview
                ? "These figures are generated locally. Saved Ledger records and setup are not shown."
                : "Status reported by the saved Ledger, month summary, and household plan."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-wrap gap-x-5 gap-y-2">
            <StatusItem label="Month summary" status={summaryStatus} />
            <StatusItem label="Saved records" status={recordStatus} />
            <StatusItem label="Bank data" status={bank} />
            <StatusItem label="Backup" status={backup} />
            <StatusItem label="Review" status={reviewStatus} />
          </CardContent>
          {!preview && summary.error ? (
            <CardContent className="pt-0">
              <Alert variant="destructive">
                <HugeiconsIcon icon={Alert02Icon} />
                <AlertTitle>Month summary could not load</AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <span>{summary.error}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => void summary.refresh()}
                    disabled={summary.loading}
                  >
                    <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" />
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            </CardContent>
          ) : null}
        </Card>

        <section
          aria-label="Key figures"
          className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5"
        >
          {metrics.map((metric) => (
            <Card key={metric.id} size="sm" className="min-w-0">
              <CardHeader className="gap-1 pb-0">
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <CardTitle className="min-w-0 text-sm font-medium text-muted-foreground">
                    {metric.label}
                  </CardTitle>
                  <Badge
                    variant={metric.kind === "plan" ? "outline" : "secondary"}
                    className="shrink-0"
                  >
                    {metric.kind === "plan" ? "Plan" : "Recorded"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-2">
                {metric.loading ? (
                  <Skeleton className="h-8 w-28" />
                ) : (
                  <p
                    data-numeric
                    className="whitespace-nowrap text-[1.75rem] font-semibold leading-none tracking-tight tabular-nums"
                  >
                    {formatCents(metric.value)}
                  </p>
                )}
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {metric.note}
                </p>
              </CardContent>
            </Card>
          ))}
        </section>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>
              {preview ? "Synthetic spending against plan" : "Spending by category"}
            </CardTitle>
            <CardDescription>
              {preview
                ? "Generated locally for interface review. Plan amounts are examples, not saved records."
                : `Recorded category totals reported for ${formatMonthLabel(month)}. Plan values appear only when a saved plan is available.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 pb-0">
            {chartRows.length === 0 ? (
              <Empty className="min-h-48">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HugeiconsIcon icon={ChartLineData01Icon} />
                  </EmptyMedia>
                  <EmptyTitle>No category spending recorded</EmptyTitle>
                  <EmptyDescription>
                    Category totals for the selected month will appear here once
                    transactions are recorded.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <ChartContainer
                  config={chartConfig}
                  className="aspect-auto h-64 w-full min-w-0 sm:h-72"
                >
                  <BarChart
                    data={chartRows}
                    layout="vertical"
                    accessibilityLayer
                    margin={{ top: 4, right: 12, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                    <XAxis
                      type="number"
                      tickFormatter={(value) => formatCompactCents(Number(value))}
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={104}
                      tickFormatter={(value) => truncateLabel(String(value))}
                      tickLine={false}
                      axisLine={false}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          formatter={(value, name) => (
                            <div className="flex w-full justify-between gap-4">
                              <span className="text-muted-foreground">
                                {chartConfig[String(name)]?.label ?? String(name)}
                              </span>
                              <span data-numeric className="font-medium tabular-nums">
                                {Number.isSafeInteger(value)
                                  ? formatCents(Number(value))
                                  : "Not recorded"}
                              </span>
                            </div>
                          )}
                        />
                      }
                    />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Bar
                      dataKey="recorded"
                      fill="var(--color-recorded)"
                      radius={[0, 3, 3, 0]}
                    />
                    {hasPlanSeries ? (
                      <Bar
                        dataKey="planned"
                        fill="var(--color-planned)"
                        radius={[0, 3, 3, 0]}
                      />
                    ) : null}
                  </BarChart>
                </ChartContainer>
                <details className="mt-4 rounded-lg border bg-background">
                  <summary className="min-h-11 cursor-pointer px-3 py-2 text-sm font-medium">
                    View spending data table
                  </summary>
                  <div className="border-t p-3">
                    <Table className="min-w-[420px]">
                      <TableCaption className="sr-only">
                        Recorded and planned amounts for each chart row, in USD.
                      </TableCaption>
                      <TableHeader>
                        <TableRow>
                          <TableHead scope="col">Category or month</TableHead>
                          <TableHead scope="col" className="text-right">
                            Recorded
                          </TableHead>
                          <TableHead scope="col" className="text-right">
                            Plan
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {chartRows.map((row) => (
                          <TableRow key={row.label}>
                            <TableCell className="font-medium">{row.label}</TableCell>
                            <TableCell
                              data-numeric
                              className="text-right tabular-nums"
                            >
                              {formatCents(row.recorded)}
                            </TableCell>
                            <TableCell
                              data-numeric
                              className="text-right tabular-nums"
                            >
                              {formatCents(row.planned)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </details>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Recent transactions</CardTitle>
            <CardDescription>
              {preview
                ? "Synthetic rows from the local sample, newest first."
                : "Saved transactions sorted by date, newest first."}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {transactionRows.length === 0 ? (
              <Empty className="m-4">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HugeiconsIcon icon={ReceiptTextIcon} />
                  </EmptyMedia>
                  <EmptyTitle>No recent transactions</EmptyTitle>
                  <EmptyDescription>
                    Posted transactions will appear here once records are saved.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table className="min-w-0">
                <TableCaption className="sr-only">
                  Recent transactions with date, description, category, and signed
                  amount. Positive amounts are money out.
                </TableCaption>
                <TableHeader className="hidden sm:table-header-group">
                  <TableRow>
                    <TableHead scope="col">Transaction</TableHead>
                    <TableHead scope="col">Date</TableHead>
                    <TableHead scope="col">Category</TableHead>
                    <TableHead scope="col" className="text-right">
                      Amount
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transactionRows.map((transaction) => (
                    <TableRow
                      key={transaction.id}
                      className={cn(
                        "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b p-3 sm:table-row sm:p-0",
                        transaction.review && "bg-muted/40"
                      )}
                    >
                      <TableCell
                        data-label="Transaction"
                        className="mobile-label order-1 min-w-0 p-0 font-medium sm:order-none sm:p-3"
                      >
                        <span className="block truncate">{transaction.merchant}</span>
                        <span className="block truncate text-xs font-normal text-muted-foreground">
                          {transaction.account}
                        </span>
                      </TableCell>
                      <TableCell
                        data-label="Amount"
                        data-numeric
                        className="mobile-label order-2 p-0 text-right tabular-nums sm:order-none sm:p-3"
                      >
                        {transaction.amount === null
                          ? "Not recorded"
                          : formatSignedCents(transaction.amount)}
                      </TableCell>
                      <TableCell
                        data-label="Date"
                        className="mobile-label order-3 p-0 text-xs text-muted-foreground sm:order-none sm:p-3"
                      >
                        {formatDate(transaction.date)}
                      </TableCell>
                      <TableCell
                        data-label="Category"
                        className="mobile-label order-4 min-w-0 p-0 sm:order-none sm:p-3"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-1">
                          <Badge variant="outline" className="max-w-full truncate">
                            {transaction.category}
                          </Badge>
                          {transaction.amount !== null && transaction.amount < 0 ? (
                            <Badge variant="secondary">Received</Badge>
                          ) : null}
                          {transaction.review ? (
                            <Badge variant="secondary">Needs review</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Setup and records</CardTitle>
            <CardDescription>
              {preview
                ? "Synthetic preview details. Saved setup and freshness are not shown."
                : "Counts and reported status from the saved Ledger. A schedule is not evidence of a successful update."}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <Table className="min-w-0">
              <TableCaption className="sr-only">
                Overview data status and setup details.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Item</TableHead>
                  <TableHead scope="col">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {details.map((detail) => (
                  <TableRow key={detail.label}>
                    <TableCell className="whitespace-normal font-medium">
                      {detail.label}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <span>{detail.value}</span>
                      {detail.hint ? (
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                          {detail.hint}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  )
}
