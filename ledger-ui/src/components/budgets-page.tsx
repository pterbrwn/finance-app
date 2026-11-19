import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  HistoryIcon,
  InformationCircleIcon,
  LockIcon,
  PlusSignIcon,
  RefreshIcon,
  SaveIcon,
  Undo02Icon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons"
import { cn } from "cn"
import { useEffect, useMemo, useState, type FormEvent } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { PageShell } from "@/components/page-shell"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { toast } from "@/components/ui/toast"
import { useLedger } from "@/context/ledger-context"
import {
  useBudgetSummary,
  useHouseholdSummary,
} from "@/hooks/use-ledger-resource"
import { api } from "@/lib/api"
import {
  asArray,
  asRecord,
  formatCents,
  formatDollarsInput,
  formatMonthLabel,
  monthShift,
  parseDollarsToCents,
  PROFILE_OPTIONS,
  profileLabel,
  type LedgerRecord,
  type LedgerState,
  type ProfileId,
} from "@/lib/ledger"

const MAX_BUDGET_CENTS = 100_000_000
const MAX_CATEGORY_NAME = 80
const COVERAGE_WARNING =
  "Expense plans have not been established. An income plan alone does not show whether expenses are covered."

const FREQUENCY_OPTIONS = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "semiannual", label: "Every 6 months" },
  { value: "annual", label: "Yearly" },
] as const

const MODE_OPTIONS = [
  { value: "template", label: "Recurring" },
  { value: "month", label: "This month" },
] as const

const ITEM_TYPE_OPTIONS = [
  { value: "expense", label: "Expense" },
  { value: "allocation", label: "Transfer / savings allocation" },
] as const

type Frequency = (typeof FREQUENCY_OPTIONS)[number]["value"]
type PlanMode = (typeof MODE_OPTIONS)[number]["value"]
type ItemType = (typeof ITEM_TYPE_OPTIONS)[number]["value"]
type WriteProfile = Exclude<ProfileId, "combined">
type RowStatusKind = "on-plan" | "over" | "not-planned" | "incomplete"

type BudgetRow = {
  id: string
  name: string
  group: string
  order: number
  itemType: ItemType
  system: boolean
  archived: boolean
  plannedCents: number | null
  periodCents: number | null
  rolloverCents: number
  actualCents: number
  remainingCents: number | null
  hasActivity: boolean
  frequency: Frequency
  dueMonth: number | null
  mode: PlanMode
  source: "template" | "month" | "none"
  ownerPlans?: Array<{ profile: ProfileId; cents: number | null }>
}

type RowDraft = {
  amount: string
  frequency: Frequency
  mode: PlanMode
  dueMonth: number | null
}

type HistoryEntry = {
  id: string
  action: string
  recordType: string
  scope: string
  month: string
  categoryId: string
  revision: number | null
  createdAt: string
  before: unknown
  after: unknown
}

type StopPreview = {
  category: string
  month: string
  laterTemplates: LedgerRecord[]
  laterOverrides: LedgerRecord[]
}

type BudgetView = {
  summary: LedgerRecord
  household: LedgerRecord
  rows: BudgetRow[]
  plannedIncomeCents: number | null
  projectedIncomeCents: number | null
  actualIncomeCents: number | null
  plannedSpendingCents: number | null
  plannedNetCents: number | null
  incomeSource: "template" | "month" | "none"
  expensePlanEstablished: boolean
  unplannedCount: number
  warnings: string[]
  incomplete: boolean
}

const FREQUENCY_ITEMS: Record<string, string> = Object.fromEntries(
  FREQUENCY_OPTIONS.map((option): [string, string] => [option.value, option.label])
)
const MODE_ITEMS: Record<string, string> = Object.fromEntries(
  MODE_OPTIONS.map((option): [string, string] => [option.value, option.label])
)
const ITEM_TYPE_ITEMS: Record<string, string> = Object.fromEntries(
  ITEM_TYPE_OPTIONS.map((option): [string, string] => [option.value, option.label])
)
const PROFILE_ITEMS: Record<string, string> = Object.fromEntries(
  PROFILE_OPTIONS.map((option): [string, string] => [option.value, option.label])
)
const DUE_MONTH_ITEMS: Record<string, string> = Object.fromEntries(
  Array.from({ length: 12 }, (_, index): [string, string] => [
    String(index + 1),
    new Intl.DateTimeFormat("en-US", {
      month: "long",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(2020, index, 1))),
  ])
)
const HISTORY_ALL = "all"
const GROUP_ORDER = [
  "Automated",
  "Truck",
  "Personal Bills",
  "Investments",
  "Rental Property",
  "Other",
]

function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

function readCents(value: unknown): number | null {
  return isCents(value) ? value : null
}

function readText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function readFrequency(value: unknown): Frequency {
  return FREQUENCY_OPTIONS.find((option) => option.value === value)?.value ?? "monthly"
}

function readDueMonth(value: unknown): number | null {
  return isCents(value) && value >= 1 && value <= 12 ? value : null
}

function writeProfileId(profile: ProfileId): WriteProfile {
  return profile === "combined" ? "peter" : profile
}

function monthlyPlanCents(amount: number | null, frequency: Frequency): number | null {
  if (amount === null || amount < 0 || amount > MAX_BUDGET_CENTS) return null
  const numerator = frequency === "weekly" ? amount * 4 : amount
  const denominator =
    frequency === "semiannual" ? 6 : frequency === "annual" ? 12 : 1
  const result = Math.round(numerator / denominator)
  return Number.isSafeInteger(result) && result <= MAX_BUDGET_CENTS ? result : null
}

function parseAmount(value: string): { cents: number | null; error: string | null } {
  const cents = parseDollarsToCents(value)
  if (cents === null) {
    return { cents: null, error: "Enter dollars with at most two decimal places." }
  }
  if (cents < 0 || cents > MAX_BUDGET_CENTS) {
    return { cents: null, error: "Enter an amount between $0 and $1,000,000." }
  }
  return { cents, error: null }
}

function normalizeBucketName(value: string): string | null {
  const name = value.trim().replace(/\s+/g, " ")
  if (!name || name.length > MAX_CATEGORY_NAME) return null
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .&'’()/_-]*$/u.test(name)) return null
  return name
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error && caught.message
    ? caught.message
    : "Ledger could not complete this request. Try again."
}

function compactJson(value: unknown): string {
  if (value === null || value === undefined) return "None"
  if (isCents(value)) return formatCents(value)
  if (typeof value === "string") return value
  const text = JSON.stringify(value)
  if (!text) return "None"
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}

function sumCents(values: number[]): number | null {
  let total = 0
  for (const value of values) {
    const next = total + value
    if (!Number.isSafeInteger(next)) return null
    total = next
  }
  return total
}

function statusForRow(row: BudgetRow, incomplete: boolean): {
  kind: RowStatusKind
  label: string
} {
  if (row.plannedCents === null) {
    if (row.actualCents !== 0 || row.hasActivity) {
      return { kind: "incomplete", label: "Incomplete estimate" }
    }
    return { kind: "not-planned", label: "Not planned" }
  }
  if (row.remainingCents !== null && row.remainingCents < 0) {
    return { kind: "over", label: `Over by ${formatCents(-row.remainingCents)}` }
  }
  if (incomplete) {
    return { kind: "incomplete", label: "Incomplete estimate" }
  }
  return { kind: "on-plan", label: "On plan" }
}

function statusVariant(kind: RowStatusKind) {
  if (kind === "over") return "destructive" as const
  if (kind === "not-planned") return "outline" as const
  if (kind === "incomplete") return "default" as const
  return "secondary" as const
}

function fallbackDraft(row: BudgetRow): RowDraft {
  return {
    amount: formatDollarsInput(row.periodCents ?? row.plannedCents),
    frequency: row.frequency,
    mode: row.mode,
    dueMonth: row.dueMonth,
  }
}

function draftFor(row: BudgetRow, drafts: Record<string, RowDraft>): RowDraft {
  return drafts[row.id] ?? fallbackDraft(row)
}

function resolveIncomePlan(
  summary: LedgerRecord,
  state: LedgerState | null,
  month: string
): { amount: number | null; source: "template" | "month" | "none" } {
  const overrides = asRecord(summary.monthlyIncomePlans ?? state?.monthlyIncomePlans)
  const override = readCents(overrides[month])
  if (override !== null) return { amount: override, source: "month" }

  const templates = asArray<LedgerRecord>(
    summary.incomePlanTemplates ?? state?.incomePlanTemplates
  )
  const template = templates
    .map((entry) => asRecord(entry))
    .filter((entry) => {
      const from = readText(entry.effectiveFrom)
      return from.length > 0 && from <= month
    })
    .sort((a, b) => readText(b.effectiveFrom).localeCompare(readText(a.effectiveFrom)))[0]
  if (template) {
    const amount = readCents(template.amount)
    if (amount !== null) return { amount, source: "template" }
  }
  return { amount: null, source: "none" }
}

function categoryRowsFromSummary(
  summary: LedgerRecord,
  state: LedgerState | null,
  month: string
): BudgetRow[] {
  const catalog = asArray<LedgerRecord>(summary.categories ?? state?.categoryCatalog)
  const settingsMap = asRecord(summary.budgetItemSettings ?? state?.budgetItemSettings)
  const templates = asArray<LedgerRecord>(
    summary.budgetTemplates ?? state?.budgetTemplates
  )
  const overrides = asRecord(summary.monthlyBudgets ?? state?.monthlyBudgets)
  const monthlySchedules = asRecord(
    summary.monthlyBudgetSchedules ?? state?.monthlyBudgetSchedules
  )
  const templateSchedules = asRecord(
    summary.budgetTemplateSchedules ?? state?.budgetTemplateSchedules
  )
  const actuals = asRecord(summary.actuals)
  const actualMap = asRecord(actuals.categories)
  const activityMap = asRecord(actuals.activity)
  const rolloverMap = asRecord(summary.budgetRollovers ?? summary.rollovers)
  const aliases = asRecord(summary.budgetCategoryIds ?? state?.budgetCategoryIds)

  const aliasFor = (id: string, name: string) => readText(aliases[id], name)
  const metricFor = (map: LedgerRecord, id: string, name: string): number | null => {
    for (const key of [id, aliasFor(id, name), name]) {
      const value = readCents(map[key])
      if (value !== null) return value
    }
    return null
  }

  const rows: BudgetRow[] = []
  for (const rawCategory of catalog) {
    const category = asRecord(rawCategory)
    const id = readText(category.id)
    if (!id) continue
    const name = readText(category.name, id)
    const kind = readText(category.kind, "expense")
    const settings = asRecord(settingsMap[id])
    const itemType: ItemType =
      readText(settings.itemType, kind) === "allocation" ? "allocation" : "expense"
    if (kind !== "expense" || itemType === "allocation") continue

    const overrideKey = `${month}:${id}`
    let plannedCents: number | null = readCents(overrides[overrideKey])
    let source: BudgetRow["source"] = plannedCents === null ? "none" : "month"
    let schedule: LedgerRecord = {}
    if (plannedCents === null) {
      const template = templates
        .map((entry) => asRecord(entry))
        .filter((entry) => {
          if (readText(entry.categoryId) !== id) return false
          const from = readText(entry.effectiveFrom)
          return from.length > 0 && from <= month
        })
        .sort((a, b) =>
          readText(b.effectiveFrom).localeCompare(readText(a.effectiveFrom))
        )[0]
      if (template) {
        const amount = readCents(template.amount)
        if (amount !== null) {
          plannedCents = amount
          source = "template"
          schedule = asRecord(
            templateSchedules[`${id}:${readText(template.effectiveFrom)}`]
          )
          if (Object.keys(schedule).length === 0) {
            schedule = asRecord(template.schedule ?? template)
          }
        }
      }
    } else {
      schedule = asRecord(monthlySchedules[overrideKey])
    }

    if (plannedCents === null) {
      source = "none"
      schedule = {}
    }

    const frequency = readFrequency(schedule.frequency ?? settings.frequency)
    const dueMonth = readDueMonth(schedule.dueMonth ?? settings.dueMonth)
    const sourceAmount =
      readCents(schedule.sourceAmount ?? settings.sourceAmount) ?? plannedCents
    const periodCents =
      plannedCents !== null && monthlyPlanCents(sourceAmount, frequency) === plannedCents
        ? sourceAmount
        : plannedCents

    let actualCents = metricFor(actualMap, id, name) ?? 0
    const linkedActualIds = asArray<unknown>(settings.actualCategoryIds).filter(
      (value): value is string => typeof value === "string"
    )
    for (const linkedId of linkedActualIds) {
      actualCents += readCents(actualMap[linkedId]) ?? 0
    }
    const hasActivity = (metricFor(activityMap, id, name) ?? 0) > 0
    const rolloverCents =
      readCents(
        rolloverMap[id] ?? rolloverMap[aliasFor(id, name)] ?? rolloverMap[name]
      ) ?? 0
    const remainingCents =
      plannedCents === null ? null : plannedCents + rolloverCents - actualCents
    const archived = Boolean(category.archivedAt)
    if (archived && plannedCents === null && actualCents === 0 && !hasActivity && rolloverCents === 0) {
      continue
    }

    rows.push({
      id,
      name,
      group: readText(settings.budgetGroup ?? category.budgetGroup, "Other"),
      order: typeof category.order === "number" ? category.order : 9999,
      itemType,
      system: category.system === true,
      archived,
      plannedCents,
      periodCents,
      rolloverCents,
      actualCents,
      remainingCents,
      hasActivity,
      frequency,
      dueMonth,
      mode: source === "month" ? "month" : "template",
      source,
    })
  }

  return rows.sort(
    (a, b) =>
      (GROUP_ORDER.indexOf(a.group) < 0 ? 99 : GROUP_ORDER.indexOf(a.group)) -
        (GROUP_ORDER.indexOf(b.group) < 0 ? 99 : GROUP_ORDER.indexOf(b.group)) ||
      a.order - b.order ||
      a.name.localeCompare(b.name)
  )
}

function categoryRowsFromHousehold(household: LedgerRecord): BudgetRow[] {
  return asArray<LedgerRecord>(household.categories)
    .map((rawCategory, index) => {
      const category = asRecord(rawCategory)
      const name = readText(category.name, "Unnamed bucket")
      const totals = asRecord(category.household)
      const profiles = asRecord(category.profiles)
      const plannedCents = readCents(totals.planned)
      const actualCents = readCents(totals.actual) ?? 0
      const unassignedActual = readCents(category.unassignedActual) ?? 0
      const ownerPlans: Array<{ profile: ProfileId; cents: number | null }> = (
        ["peter", "maddie", "joint"] as const
      ).map((profile) => ({
        profile,
        cents: readCents(asRecord(profiles[profile]).planned),
      }))
      return {
        id: readText(category.id, `combined:${index}:${name}`),
        name,
        group: "Household",
        order: index,
        itemType: "expense" as const,
        system: true,
        archived: false,
        plannedCents,
        periodCents: plannedCents,
        rolloverCents: 0,
        actualCents,
        remainingCents: plannedCents === null ? null : plannedCents - actualCents,
        hasActivity: actualCents !== 0 || unassignedActual !== 0,
        frequency: "monthly" as const,
        dueMonth: null,
        mode: "template" as const,
        source: "none" as const,
        ownerPlans,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function BudgetsPage() {
  const {
    month,
    preview,
    profile,
    refreshing,
    setMonth,
    setProfile,
    state,
    write,
  } = useLedger()
  const budgetSummary = useBudgetSummary(month, profile)
  const householdSummary = useHouseholdSummary(month, profile)

  const [incomeOpen, setIncomeOpen] = useState(false)
  const [incomeAmount, setIncomeAmount] = useState("")
  const [incomeMode, setIncomeMode] = useState<PlanMode>("template")
  const [incomeError, setIncomeError] = useState("")
  const [incomeBusy, setIncomeBusy] = useState(false)

  const [bucketOpen, setBucketOpen] = useState(false)
  const [bucketName, setBucketName] = useState("")
  const [bucketGroup, setBucketGroup] = useState("Other")
  const [bucketAmount, setBucketAmount] = useState("")
  const [bucketType, setBucketType] = useState<ItemType>("expense")
  const [bucketMode, setBucketMode] = useState<PlanMode>("template")
  const [bucketFrequency, setBucketFrequency] = useState<Frequency>("monthly")
  const [bucketDueMonth, setBucketDueMonth] = useState<number | null>(null)
  const [bucketError, setBucketError] = useState("")
  const [bucketBusy, setBucketBusy] = useState(false)

  const [renameTarget, setRenameTarget] = useState<{
    id: string
    name: string
  } | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [renameError, setRenameError] = useState("")
  const [renameBusy, setRenameBusy] = useState(false)
  const [customBusyId, setCustomBusyId] = useState<string | null>(null)

  const [rowDrafts, setRowDrafts] = useState<Record<string, RowDraft>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [busyRow, setBusyRow] = useState<string | null>(null)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyCategoryId, setHistoryCategoryId] = useState("")
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState("")
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [revertBusyId, setRevertBusyId] = useState<string | null>(null)

  const [stopTarget, setStopTarget] = useState<BudgetRow | null>(null)
  const [stopPreview, setStopPreview] = useState<StopPreview | null>(null)
  const [stopLoading, setStopLoading] = useState(false)
  const [stopError, setStopError] = useState("")
  const [stopBusy, setStopBusy] = useState(false)

  const canWrite = !preview && profile !== "combined" && state !== null
  const writeProfile = writeProfileId(profile)
  const revision = state?.revision

  const view = useMemo<BudgetView>(() => {
    const summary = asRecord(budgetSummary.data)
    const household = asRecord(householdSummary.data)
    const isCombined = profile === "combined"
    const incomePlan = resolveIncomePlan(summary, state, month)
    const houseTotals = asRecord(household.household)
    const profileTotals = asRecord(asRecord(household.profiles)[profile])
    const actuals = asRecord(summary.actuals)

    const rows = isCombined
      ? categoryRowsFromHousehold(household)
      : categoryRowsFromSummary(summary, state, month)

    const unplannedCount = rows.filter(
      (row) => row.plannedCents === null && (row.actualCents !== 0 || row.hasActivity)
    ).length
    const expensePlanEstablished = rows.some((row) => row.plannedCents !== null)
    const warnings = asArray<unknown>(summary.warnings)
      .filter((warning): warning is string => typeof warning === "string")
      .filter((warning) => warning.length > 0)
    const plannedIncomeCents = incomePlan.amount
    const projectedIncomeCents = isCombined
      ? readCents(houseTotals.projectedIncome)
      : (readCents(profileTotals.projectedIncome) ??
        readCents(houseTotals.projectedIncome))
    const actualIncomeCents =
      readCents(actuals.income) ??
      (isCombined
        ? readCents(houseTotals.actualIncome)
        : readCents(profileTotals.actualIncome))
    const plannedSpendingCents = sumCents(
      rows
        .filter((row) => row.itemType === "expense" && row.plannedCents !== null)
        .map((row) => row.plannedCents as number)
    )
    const plannedNetCents =
      plannedIncomeCents !== null && plannedSpendingCents !== null
        ? plannedIncomeCents - plannedSpendingCents
        : null
    const incomplete =
      warnings.length > 0 ||
      unplannedCount > 0 ||
      !expensePlanEstablished ||
      plannedIncomeCents === null

    return {
      summary,
      household,
      rows,
      plannedIncomeCents,
      projectedIncomeCents,
      actualIncomeCents,
      plannedSpendingCents,
      plannedNetCents,
      incomeSource: incomePlan.source,
      expensePlanEstablished,
      unplannedCount,
      warnings,
      incomplete,
    }
  }, [budgetSummary.data, householdSummary.data, month, profile, state])

  const customCategories = useMemo(
    () =>
      asArray<LedgerRecord>(view.summary.categories ?? state?.categoryCatalog).filter(
        (category) => {
          const record = asRecord(category)
          const kind = readText(record.kind, "expense")
          return record.system !== true && (kind === "expense" || kind === "allocation")
        }
      ),
    [state, view.summary.categories]
  )

  const historyCategoryItems = useMemo<Record<string, string>>(() => {
    const items: Record<string, string> = { [HISTORY_ALL]: "All categories" }
    for (const category of customCategories) {
      const record = asRecord(category)
      const id = readText(record.id)
      if (id) items[id] = readText(record.name, id)
    }
    for (const row of view.rows) {
      items[row.id] = row.name
    }
    return items
  }, [customCategories, view.rows])

  useEffect(() => {
    if (!historyOpen) return
    let active = true
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        month,
        categoryId: historyCategoryId,
        profile,
        limit: "200",
      })
      setHistoryLoading(true)
      setHistoryError("")
      api<LedgerRecord>(`budget-history?${params.toString()}`)
        .then((result) => {
          if (!active) return
          const entries = asArray<LedgerRecord>(asRecord(result).entries).map(
            (rawEntry, index) => {
              const entry = asRecord(rawEntry)
              return {
                id: readText(entry.id, `entry-${index}`),
                action: readText(entry.action, "Saved change"),
                recordType: readText(entry.recordType),
                scope: readText(entry.scope),
                month: readText(entry.month),
                categoryId: readText(entry.categoryId),
                revision: readCents(entry.revision),
                createdAt: readText(entry.createdAt),
                before: entry.before,
                after: entry.after,
              } satisfies HistoryEntry
            }
          )
          setHistoryEntries(entries)
        })
        .catch((caught: unknown) => {
          if (active) setHistoryError(errorMessage(caught))
        })
        .finally(() => {
          if (active) setHistoryLoading(false)
        })
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [historyCategoryId, historyOpen, historyRefresh, month, profile])

  useEffect(() => {
    if (!stopTarget) return
    let active = true
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        categoryId: stopTarget.id,
        month,
        profile,
      })
      setStopLoading(true)
      setStopError("")
      setStopPreview(null)
      api<LedgerRecord>(`budget-stop-preview?${params.toString()}`)
        .then((result) => {
          if (!active) return
          const previewRecord = asRecord(result)
          setStopPreview({
            category: readText(previewRecord.category, stopTarget.name),
            month: readText(previewRecord.month, month),
            laterTemplates: asArray<LedgerRecord>(previewRecord.laterTemplates),
            laterOverrides: asArray<LedgerRecord>(previewRecord.laterOverrides),
          })
        })
        .catch((caught: unknown) => {
          if (active) setStopError(errorMessage(caught))
        })
        .finally(() => {
          if (active) setStopLoading(false)
        })
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [month, profile, stopTarget])

  async function refreshResources() {
    await Promise.all([budgetSummary.refresh(), householdSummary.refresh()])
  }

  function setRowError(id: string, message: string) {
    setRowErrors((previous) => {
      const next = { ...previous }
      if (message) next[id] = message
      else delete next[id]
      return next
    })
  }

  function clearRowState(id: string) {
    setRowDrafts((previous) => {
      const next = { ...previous }
      delete next[id]
      return next
    })
    setRowError(id, "")
  }

  function patchDraft(row: BudgetRow, patch: Partial<RowDraft>) {
    setRowDrafts((previous) => ({
      ...previous,
      [row.id]: { ...draftFor(row, previous), ...patch },
    }))
  }

  function openIncomeDialog() {
    setIncomeAmount(formatDollarsInput(view.plannedIncomeCents))
    setIncomeMode(view.incomeSource === "month" ? "month" : "template")
    setIncomeError("")
    setIncomeOpen(true)
  }

  function openBucketDialog() {
    setBucketName("")
    setBucketGroup("Other")
    setBucketAmount("")
    setBucketType("expense")
    setBucketMode("template")
    setBucketFrequency("monthly")
    setBucketDueMonth(null)
    setBucketError("")
    setBucketOpen(true)
  }

  async function saveIncome(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canWrite) return
    const parsed = parseAmount(incomeAmount)
    if (parsed.error || parsed.cents === null) {
      setIncomeError(parsed.error ?? "Enter a projected income amount.")
      return
    }
    setIncomeError("")
    setIncomeBusy(true)
    try {
      await write("income-plan", {
        amount: parsed.cents,
        mode: incomeMode,
        month,
        profileId: writeProfile,
        revision,
      })
      await refreshResources()
      setIncomeOpen(false)
      toast.add({
        type: "success",
        title: "Projected income saved",
        description: `${formatCents(parsed.cents)} · ${MODE_ITEMS[incomeMode]}`,
      })
    } catch (caught) {
      setIncomeError(errorMessage(caught))
      toast.add({ type: "error", title: "Income plan not saved", description: errorMessage(caught) })
    } finally {
      setIncomeBusy(false)
    }
  }

  async function resetIncome() {
    if (!canWrite) return
    setIncomeBusy(true)
    setIncomeError("")
    try {
      await write("income-plan-reset", {
        month,
        profileId: writeProfile,
        revision,
      })
      await refreshResources()
      setIncomeOpen(false)
      toast.add({
        type: "success",
        title: "Monthly income plan reset",
        description: `The recurring plan now applies to ${formatMonthLabel(month)}.`,
      })
    } catch (caught) {
      setIncomeError(errorMessage(caught))
      toast.add({ type: "error", title: "Income plan not reset", description: errorMessage(caught) })
    } finally {
      setIncomeBusy(false)
    }
  }

  async function saveRow(row: BudgetRow) {
    if (!canWrite || busyRow !== null) return
    const draft = draftFor(row, rowDrafts)
    const parsed = parseAmount(draft.amount)
    if (parsed.error || parsed.cents === null) {
      setRowError(row.id, parsed.error ?? "Enter a valid plan amount.")
      return
    }
    if (draft.frequency === "annual" && draft.dueMonth === null) {
      setRowError(row.id, "Choose the month this yearly plan is due.")
      return
    }
    const dueMonth = draft.frequency === "annual" ? draft.dueMonth : null
    setRowError(row.id, "")
    setBusyRow(row.id)
    try {
      await write("budget", {
        categoryId: row.id,
        amount: parsed.cents,
        mode: draft.mode,
        month,
        profileId: writeProfile,
        schedule: {
          frequency: draft.frequency,
          dueMonth,
          sourceAmount: parsed.cents,
        },
        revision,
      })
      await refreshResources()
      clearRowState(row.id)
      const monthly = monthlyPlanCents(parsed.cents, draft.frequency)
      toast.add({
        type: "success",
        title: `${row.name} plan saved`,
        description:
          monthly === null
            ? MODE_ITEMS[draft.mode]
            : `${formatCents(monthly)} per month · ${MODE_ITEMS[draft.mode]}`,
      })
    } catch (caught) {
      setRowError(row.id, errorMessage(caught))
      toast.add({ type: "error", title: "Budget not saved", description: errorMessage(caught) })
    } finally {
      setBusyRow(null)
    }
  }

  async function resetRow(row: BudgetRow) {
    if (!canWrite || busyRow !== null) return
    setRowError(row.id, "")
    setBusyRow(row.id)
    try {
      await write("budget-reset", {
        categoryId: row.id,
        month,
        profileId: writeProfile,
        revision,
      })
      await refreshResources()
      clearRowState(row.id)
      toast.add({
        type: "success",
        title: `${row.name} month override reset`,
        description: "The recurring plan applies again for this month.",
      })
    } catch (caught) {
      setRowError(row.id, errorMessage(caught))
      toast.add({ type: "error", title: "Budget not reset", description: errorMessage(caught) })
    } finally {
      setBusyRow(null)
    }
  }

  async function createBucket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canWrite) return
    const name = normalizeBucketName(bucketName)
    if (!name) {
      setBucketError(
        `Use a name up to ${MAX_CATEGORY_NAME} characters, starting with a letter or number.`
      )
      return
    }
    const parsed = parseAmount(bucketAmount)
    if (parsed.error || parsed.cents === null) {
      setBucketError(parsed.error ?? "Enter a starting plan amount.")
      return
    }
    if (bucketFrequency === "annual" && bucketDueMonth === null) {
      setBucketError("Choose the month this yearly bucket is due.")
      return
    }
    setBucketError("")
    setBucketBusy(true)
    try {
      await write("category-create", {
        name,
        amount: parsed.cents,
        itemType: bucketType,
        budgetGroup: bucketGroup.trim().slice(0, 50) || "Other",
        month,
        mode: bucketMode,
        schedule: {
          frequency: bucketFrequency,
          dueMonth: bucketFrequency === "annual" ? bucketDueMonth : null,
          sourceAmount: parsed.cents,
        },
        profileId: writeProfile,
        revision,
      })
      await refreshResources()
      setBucketOpen(false)
      toast.add({
        type: "success",
        title: "Bucket created",
        description: `${name} · ${formatMonthLabel(month)}`,
      })
    } catch (caught) {
      setBucketError(errorMessage(caught))
      toast.add({ type: "error", title: "Bucket not created", description: errorMessage(caught) })
    } finally {
      setBucketBusy(false)
    }
  }

  async function renameBucket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canWrite || !renameTarget) return
    const name = normalizeBucketName(renameValue)
    if (!name) {
      setRenameError(
        `Use a name up to ${MAX_CATEGORY_NAME} characters, starting with a letter or number.`
      )
      return
    }
    setRenameBusy(true)
    setRenameError("")
    try {
      await write("category-update", {
        id: renameTarget.id,
        action: "rename",
        name,
        profileId: writeProfile,
        revision,
      })
      await refreshResources()
      setRenameTarget(null)
      toast.add({ type: "success", title: "Bucket renamed", description: name })
    } catch (caught) {
      setRenameError(errorMessage(caught))
      toast.add({ type: "error", title: "Bucket not renamed", description: errorMessage(caught) })
    } finally {
      setRenameBusy(false)
    }
  }

  async function updateBucket(
    id: string,
    action: "archive" | "restore" | "move",
    direction?: "up" | "down"
  ) {
    if (!canWrite || customBusyId !== null) return
    setCustomBusyId(id)
    try {
      await write("category-update", {
        id,
        action,
        ...(direction ? { direction } : {}),
        profileId: writeProfile,
        revision,
      })
      await refreshResources()
      toast.add({
        type: "success",
        title:
          action === "archive"
            ? "Bucket archived"
            : action === "restore"
              ? "Bucket restored"
              : "Bucket order updated",
      })
    } catch (caught) {
      toast.add({ type: "error", title: "Bucket not updated", description: errorMessage(caught) })
    } finally {
      setCustomBusyId(null)
    }
  }

  async function revertHistory(entry: HistoryEntry) {
    if (!canWrite || revertBusyId !== null) return
    setRevertBusyId(entry.id)
    try {
      await write("budget-history-revert", {
        historyId: entry.id,
        profileId: writeProfile,
        revision,
      })
      await refreshResources()
      setHistoryRefresh((value) => value + 1)
      toast.add({
        type: "success",
        title: "Change reverted",
        description: "The previous value was saved as a new revision.",
      })
    } catch (caught) {
      toast.add({ type: "error", title: "Revert failed", description: errorMessage(caught) })
    } finally {
      setRevertBusyId(null)
    }
  }

  async function confirmStop() {
    if (!canWrite || !stopTarget || stopBusy || stopLoading || stopError) return
    setStopBusy(true)
    try {
      await write("budget-stop-future", {
        categoryId: stopTarget.id,
        month,
        profileId: writeProfile,
        confirmFuture: true,
        revision,
      })
      await refreshResources()
      setStopTarget(null)
      toast.add({
        type: "success",
        title: "Future funding stopped",
        description: `${stopTarget.name} from ${formatMonthLabel(month)} onward.`,
      })
    } catch (caught) {
      setStopError(errorMessage(caught))
      toast.add({ type: "error", title: "Funding not stopped", description: errorMessage(caught) })
    } finally {
      setStopBusy(false)
    }
  }

  const loading =
    budgetSummary.loading || householdSummary.loading || (refreshing && !budgetSummary.data)
  const summaryError = budgetSummary.error ?? householdSummary.error
  const busy = busyRow !== null || customBusyId !== null
  const plannedResult =
    view.plannedNetCents === null
      ? "Not available"
      : view.plannedNetCents > 0
        ? `Planned surplus ${formatCents(view.plannedNetCents)}`
        : view.plannedNetCents === 0
          ? "Fully allocated"
          : `Planned deficit ${formatCents(-view.plannedNetCents)}`

  return (
    <PageShell
      title="Budgets"
      description="Make room for what matters to you."
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() => setMonth(monthShift(month, -1))}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} data-icon="inline-start" aria-hidden="true" />
          </Button>
          <span className="flex min-w-0 items-center gap-2 text-sm font-medium tabular-nums">
            <HugeiconsIcon icon={Calendar03Icon} className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">{formatMonthLabel(month)}</span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Next month"
            onClick={() => setMonth(monthShift(month, 1))}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-start" aria-hidden="true" />
          </Button>
          <Select
            value={profile}
            onValueChange={(value) => setProfile(value as ProfileId)}
            items={PROFILE_ITEMS}
          >
            <SelectTrigger className="w-44" aria-label="Budget view">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {PROFILE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            onClick={() => setHistoryOpen(true)}
          >
            <HugeiconsIcon icon={HistoryIcon} data-icon="inline-start" aria-hidden="true" />
            History
          </Button>
          <Button type="button" onClick={openBucketDialog} disabled={!canWrite || busy}>
            <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" aria-hidden="true" />
            New bucket
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        <Alert>
          <HugeiconsIcon icon={InformationCircleIcon} aria-hidden="true" />
          <AlertTitle>Viewing {profileLabel(profile)}</AlertTitle>
          <AlertDescription>
            Household profiles are organisational views, not an access restriction. Changing the view changes which saved plans and activity are shown.
            {preview ? " Preview mode cannot save changes." : ""}
          </AlertDescription>
        </Alert>

        {profile === "combined" ? (
          <Alert role="alert">
            <HugeiconsIcon icon={LockIcon} aria-hidden="true" />
            <AlertTitle>Combined budgets are read only</AlertTitle>
            <AlertDescription>
              Combined shows the household rollup. Per-person saves require Peter, Maddie, or Joint; choose one above to edit a plan.
            </AlertDescription>
          </Alert>
        ) : null}

        {summaryError ? (
          <Alert variant="destructive" role="alert">
            <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
            <AlertTitle>Budget figures could not load</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{summaryError}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void Promise.all([budgetSummary.refresh(), householdSummary.refresh()])}
              >
                <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" aria-hidden="true" />
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {budgetSummary.stale || householdSummary.stale ? (
          <Alert role="alert">
            <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
            <AlertTitle>Saved budget figures may be stale</AlertTitle>
            <AlertDescription>
              Refresh before saving so a newer revision is not overwritten.
            </AlertDescription>
          </Alert>
        ) : null}

        {loading ? (
          <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading budget plans">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-96 rounded-xl" />
          </div>
        ) : (
          <>
            <Card className="min-w-0">
              <CardHeader>
                <div className="flex min-w-0 items-start gap-3">
                  <HugeiconsIcon icon={Wallet01Icon} className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0">
                    <CardTitle>Income plan · {formatMonthLabel(month)}</CardTitle>
                    <CardDescription>
                      Planned and projected income stay separate from recorded deposits.
                    </CardDescription>
                  </div>
                </div>
                <CardAction className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={openIncomeDialog} disabled={!canWrite}>
                    <HugeiconsIcon icon={SaveIcon} data-icon="inline-start" aria-hidden="true" />
                    Set projected income
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="flex min-w-0 flex-col gap-4">
                <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      Planned income <Badge variant="outline">Plan</Badge>
                    </div>
                    <span data-numeric className="whitespace-nowrap font-medium tabular-nums">
                      {view.plannedIncomeCents === null
                        ? "Unknown"
                        : formatCents(view.plannedIncomeCents)}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      Projected income <Badge variant="secondary">Estimate</Badge>
                    </div>
                    <span data-numeric className="whitespace-nowrap font-medium tabular-nums">
                      {view.projectedIncomeCents === null
                        ? "Unknown"
                        : formatCents(view.projectedIncomeCents)}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      Actual income <Badge variant="secondary">Recorded</Badge>
                    </div>
                    <span data-numeric className="whitespace-nowrap font-medium tabular-nums">
                      {formatCents(view.actualIncomeCents)}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
                    <span className="text-xs text-muted-foreground">Planned month result</span>
                    <span
                      data-numeric
                      className={cn(
                        "whitespace-nowrap font-medium tabular-nums",
                        view.plannedNetCents !== null && view.plannedNetCents < 0
                          ? "text-destructive"
                          : "text-foreground"
                      )}
                    >
                      {plannedResult}
                    </span>
                  </div>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Planned spending: {formatCents(view.plannedSpendingCents)}. The result is a plan, not a bank balance or proof that all income has arrived.
                </p>
              </CardContent>
            </Card>

            {!view.expensePlanEstablished ? (
              <Alert role="alert">
                <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
                <AlertTitle>Expense coverage unknown</AlertTitle>
                <AlertDescription>{COVERAGE_WARNING}</AlertDescription>
              </Alert>
            ) : null}

            {view.unplannedCount > 0 || view.warnings.length > 0 ? (
              <Alert variant="destructive" role="alert">
                <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
                <AlertTitle>Review this estimate</AlertTitle>
                <AlertDescription className="flex flex-col gap-2">
                  {view.unplannedCount > 0 ? (
                    <span>
                      {view.unplannedCount} expense {view.unplannedCount === 1 ? "bucket has" : "buckets have"} recorded activity without a plan. Review those transactions before relying on the estimate.
                    </span>
                  ) : null}
                  {view.warnings.map((warning) => (
                    <span key={warning}>{warning}</span>
                  ))}
                </AlertDescription>
              </Alert>
            ) : null}

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Planned vs actual</CardTitle>
                <CardDescription>
                  Expense buckets for {formatMonthLabel(month)}. Amounts use integer cents; carryover comes from prior saved plans and posted spending.
                </CardDescription>
              </CardHeader>
              <CardContent className="min-w-0 px-0 pb-0">
                {view.rows.length === 0 ? (
                  <Empty className="m-4">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <HugeiconsIcon icon={Wallet01Icon} aria-hidden="true" />
                      </EmptyMedia>
                      <EmptyTitle>No expense buckets to show</EmptyTitle>
                      <EmptyDescription>
                        {canWrite
                          ? "Create a bucket or set a plan to start comparing planned and recorded spending."
                          : "Choose a profile with saved plans, or create one from a writable view."}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <ScrollArea className="w-full">
                    <Table className="min-w-[980px]">
                      <TableCaption className="sr-only">
                        Expense category plans, recorded activity, carryover, remaining allowance, and status for {formatMonthLabel(month)}.
                      </TableCaption>
                      <TableHeader>
                        <TableRow>
                          <TableHead scope="col">Category</TableHead>
                          <TableHead scope="col" className="text-right">
                            <span className="inline-flex items-center gap-2">
                              Allocation / planned <Badge variant="outline">Plan</Badge>
                            </span>
                          </TableHead>
                          <TableHead scope="col" className="text-right">
                            <span className="inline-flex items-center gap-2">
                              Actual / activity <Badge variant="secondary">Recorded</Badge>
                            </span>
                          </TableHead>
                          <TableHead scope="col" className="text-right">
                            Rollover / carryover
                          </TableHead>
                          <TableHead scope="col" className="text-right">
                            Remaining
                          </TableHead>
                          <TableHead scope="col">Status</TableHead>
                          <TableHead scope="col">Plan editor</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {view.rows.map((row) => {
                          const draft = draftFor(row, rowDrafts)
                          const status = statusForRow(row, view.incomplete)
                          const usedPercent =
                            row.plannedCents !== null && row.plannedCents > 0
                              ? Math.min(
                                  100,
                                  Math.max(0, Math.round((row.actualCents / row.plannedCents) * 100))
                                )
                              : 0
                          const monthly = monthlyPlanCents(
                            parseAmount(draft.amount).cents,
                            draft.frequency
                          )
                          return (
                            <TableRow key={row.id}>
                              <TableCell className="min-w-52 whitespace-normal">
                                <div className="flex flex-col gap-1">
                                  <span className="font-medium">{row.name}</span>
                                  <span className="text-xs text-muted-foreground">
                                    {row.group}
                                    {row.archived ? " · archived" : ""}
                                    {row.system && profile === "combined" ? " · household" : ""}
                                  </span>
                                  {row.ownerPlans ? (
                                    <span className="text-xs text-muted-foreground">
                                      {row.ownerPlans
                                        .map(
                                          (owner) =>
                                            `${profileLabel(owner.profile).replace(" Budget", "")}: ${formatCents(owner.cents)}`
                                        )
                                        .join(" · ")}
                                    </span>
                                  ) : null}
                                </div>
                              </TableCell>
                              <TableCell data-numeric className="text-right tabular-nums">
                                <div className="flex flex-col items-end gap-1">
                                  <span>{formatCents(row.plannedCents)}</span>
                                  {row.source === "month" ? (
                                    <span className="text-xs text-muted-foreground">This month only</span>
                                  ) : null}
                                  {row.frequency !== "monthly" && row.periodCents !== null ? (
                                    <span className="text-xs text-muted-foreground">
                                      {formatCents(row.periodCents)} · {FREQUENCY_ITEMS[row.frequency]}
                                      {row.frequency === "weekly" ? " (4 weeks/month)" : ""}
                                    </span>
                                  ) : null}
                                  {row.dueMonth !== null ? (
                                    <span className="text-xs text-muted-foreground">
                                      Due {DUE_MONTH_ITEMS[String(row.dueMonth)]}
                                    </span>
                                  ) : null}
                                </div>
                              </TableCell>
                              <TableCell data-numeric className="text-right tabular-nums">
                                <div className="flex flex-col items-end gap-2">
                                  <span>{formatCents(row.actualCents)}</span>
                                  <div className="flex w-32 items-center gap-2">
                                    <Progress
                                      value={usedPercent}
                                      className="min-w-0 flex-1"
                                      aria-label={`${row.name} plan used`}
                                    />
                                    <span className="sr-only">Plan used {usedPercent}%</span>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell data-numeric className="text-right tabular-nums">
                                {formatCents(row.rolloverCents)}
                              </TableCell>
                              <TableCell data-numeric className="text-right tabular-nums">
                                <div className="flex flex-col items-end gap-1">
                                  <span className={cn(row.remainingCents !== null && row.remainingCents < 0 && "text-destructive")}>
                                    {formatCents(row.remainingCents)}
                                  </span>
                                  {row.rolloverCents !== 0 && row.plannedCents !== null ? (
                                    <span className="text-xs text-muted-foreground">
                                      {formatCents(row.plannedCents + row.rolloverCents)} available
                                    </span>
                                  ) : null}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant={statusVariant(status.kind)}>{status.label}</Badge>
                              </TableCell>
                              <TableCell>
                                {row.system && profile === "combined" ? (
                                  <span className="text-xs text-muted-foreground">
                                    Switch to a person or Joint to edit.
                                  </span>
                                ) : (
                                  <form
                                    className="flex min-w-72 flex-col gap-2"
                                    onSubmit={(event) => {
                                      event.preventDefault()
                                      void saveRow(row)
                                    }}
                                  >
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Input
                                        aria-label={`Plan amount for ${row.name}`}
                                        className="w-28"
                                        inputMode="decimal"
                                        value={draft.amount}
                                        placeholder="Not planned"
                                        disabled={!canWrite || busy}
                                        onChange={(event) =>
                                          patchDraft(row, { amount: event.target.value })
                                        }
                                      />
                                      <Select
                                        value={draft.frequency}
                                        onValueChange={(value) =>
                                          patchDraft(row, {
                                            frequency: value as Frequency,
                                            dueMonth: value === "annual" ? draft.dueMonth : null,
                                          })
                                        }
                                        items={FREQUENCY_ITEMS}
                                      >
                                        <SelectTrigger
                                          size="sm"
                                          className="w-36"
                                          aria-label={`Frequency for ${row.name}`}
                                          disabled={!canWrite || busy}
                                        >
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectGroup>
                                            {FREQUENCY_OPTIONS.map((option) => (
                                              <SelectItem key={option.value} value={option.value}>
                                                {option.label}
                                              </SelectItem>
                                            ))}
                                          </SelectGroup>
                                        </SelectContent>
                                      </Select>
                                      {draft.frequency === "annual" ? (
                                        <Select
                                          value={draft.dueMonth === null ? undefined : String(draft.dueMonth)}
                                          onValueChange={(value) =>
                                            patchDraft(row, { dueMonth: Number(value) })
                                          }
                                          items={DUE_MONTH_ITEMS}
                                        >
                                          <SelectTrigger
                                            size="sm"
                                            className="w-32"
                                            aria-label={`Due month for ${row.name}`}
                                            disabled={!canWrite || busy}
                                          >
                                            <SelectValue placeholder="Due month" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            <SelectGroup>
                                              {Object.entries(DUE_MONTH_ITEMS).map(([value, label]) => (
                                                <SelectItem key={value} value={value}>
                                                  {label}
                                                </SelectItem>
                                              ))}
                                            </SelectGroup>
                                          </SelectContent>
                                        </Select>
                                      ) : null}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Select
                                        value={draft.mode}
                                        onValueChange={(value) =>
                                          patchDraft(row, { mode: value as PlanMode })
                                        }
                                        items={MODE_ITEMS}
                                      >
                                        <SelectTrigger
                                          size="sm"
                                          className="w-36"
                                          aria-label={`Plan scope for ${row.name}`}
                                          disabled={!canWrite || busy}
                                        >
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectGroup>
                                            {MODE_OPTIONS.map((option) => (
                                              <SelectItem key={option.value} value={option.value}>
                                                {option.label}
                                              </SelectItem>
                                            ))}
                                          </SelectGroup>
                                        </SelectContent>
                                      </Select>
                                      <Button
                                        type="submit"
                                        size="sm"
                                        disabled={!canWrite || busy || busyRow === row.id}
                                      >
                                        <HugeiconsIcon icon={SaveIcon} data-icon="inline-start" aria-hidden="true" />
                                        Save
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={
                                          !canWrite || busy || row.source !== "month"
                                        }
                                        onClick={() => void resetRow(row)}
                                      >
                                        <HugeiconsIcon icon={Undo02Icon} data-icon="inline-start" aria-hidden="true" />
                                        Reset
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        disabled={!canWrite || busy}
                                        onClick={() => setStopTarget(row)}
                                      >
                                        Stop future funding
                                      </Button>
                                    </div>
                                    {monthly !== null && draft.frequency !== "monthly" ? (
                                      <span className="text-xs text-muted-foreground">
                                        Saved as {formatCents(monthly)} per month. Weekly counts as four weeks.
                                      </span>
                                    ) : null}
                                    <FieldError>{rowErrors[row.id] ?? ""}</FieldError>
                                  </form>
                                )}
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>

            {canWrite ? (
              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle>Custom buckets</CardTitle>
                  <CardDescription>
                    Rename keeps the same category identity. Archiving preserves history without offering the bucket for new plans. A profile can keep up to 50 custom buckets; the server enforces the limit.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex min-w-0 flex-col gap-3">
                  <span className="text-xs text-muted-foreground">
                    {customCategories.length} of 50 buckets used for {profileLabel(writeProfile)}.
                  </span>
                  {customCategories.length === 0 ? (
                    <Empty className="p-6">
                      <EmptyHeader>
                        <EmptyTitle>No custom buckets yet</EmptyTitle>
                        <EmptyDescription>
                          Use New bucket to add an expense or transfer/savings allocation.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    customCategories.map((rawCategory, index) => {
                      const category = asRecord(rawCategory)
                      const id = readText(category.id)
                      const name = readText(category.name, id)
                      const archived = Boolean(category.archivedAt)
                      return (
                        <div
                          key={id || index}
                          className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                        >
                          <div className="flex min-w-0 flex-col gap-1">
                            <span className="truncate font-medium">{name}</span>
                            <span className="text-xs text-muted-foreground">
                              {readText(category.budgetGroup, "Other")}
                              {archived ? " · archived" : ""}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={archived || busy}
                              onClick={() => {
                                setRenameTarget({ id, name })
                                setRenameValue(name)
                                setRenameError("")
                              }}
                            >
                              Rename
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                void updateBucket(id, archived ? "restore" : "archive")
                              }
                            >
                              {archived ? "Restore" : "Archive"}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-label={`Move ${name} up`}
                              disabled={archived || busy || index === 0}
                              onClick={() => void updateBucket(id, "move", "up")}
                            >
                              <HugeiconsIcon icon={ArrowLeft01Icon} data-icon="inline-start" aria-hidden="true" />
                              Up
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-label={`Move ${name} down`}
                              disabled={archived || busy || index === customCategories.length - 1}
                              onClick={() => void updateBucket(id, "move", "down")}
                            >
                              Down
                              <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-end" aria-hidden="true" />
                            </Button>
                          </div>
                        </div>
                      )
                    })
                  )}
                </CardContent>
              </Card>
            ) : null}
          </>
        )}
      </div>

      <Dialog open={incomeOpen} onOpenChange={setIncomeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set projected income</DialogTitle>
            <DialogDescription>
              Save a plan for {formatMonthLabel(month)} in {profileLabel(profile)}. Planned income is not recorded income.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-5" onSubmit={(event) => void saveIncome(event)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="income-amount">Projected income (USD)</FieldLabel>
                <Input
                  id="income-amount"
                  name="amount"
                  inputMode="decimal"
                  value={incomeAmount}
                  placeholder="Unknown"
                  disabled={incomeBusy}
                  onChange={(event) => {
                    setIncomeAmount(event.target.value)
                    setIncomeError("")
                  }}
                />
                <FieldDescription>Enter dollars, for example 5400 or 5400.50.</FieldDescription>
                <FieldError>{incomeError}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="income-mode">Plan scope</FieldLabel>
                <Select
                  value={incomeMode}
                  onValueChange={(value) => setIncomeMode(value as PlanMode)}
                  items={MODE_ITEMS}
                >
                  <SelectTrigger id="income-mode" disabled={incomeBusy} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {MODE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Recurring applies from this month onward. This month applies only to {formatMonthLabel(month)}.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter showCloseButton>
              <Button type="submit" disabled={incomeBusy || !canWrite}>
                <HugeiconsIcon icon={SaveIcon} data-icon="inline-start" aria-hidden="true" />
                {incomeBusy ? "Saving…" : "Save income"}
              </Button>
              {view.incomeSource === "month" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={incomeBusy || !canWrite}
                  onClick={() => void resetIncome()}
                >
                  <HugeiconsIcon icon={Undo02Icon} data-icon="inline-start" aria-hidden="true" />
                  Reset this month
                </Button>
              ) : null}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={bucketOpen} onOpenChange={setBucketOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a budget bucket</DialogTitle>
            <DialogDescription>
              Add a custom bucket to {profileLabel(writeProfile)} with a starting plan for {formatMonthLabel(month)}.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-5" onSubmit={(event) => void createBucket(event)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="bucket-name">Bucket name</FieldLabel>
                <Input
                  id="bucket-name"
                  value={bucketName}
                  maxLength={MAX_CATEGORY_NAME}
                  placeholder="e.g. Home supplies"
                  disabled={bucketBusy}
                  onChange={(event) => {
                    setBucketName(event.target.value)
                    setBucketError("")
                  }}
                />
                <FieldDescription>
                  Up to {MAX_CATEGORY_NAME} characters, starting with a letter or number. {customCategories.length} of 50 buckets used; the server enforces the limit.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="bucket-group">Budget group</FieldLabel>
                <Input
                  id="bucket-group"
                  value={bucketGroup}
                  maxLength={50}
                  disabled={bucketBusy}
                  onChange={(event) => setBucketGroup(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="bucket-amount">Starting plan (USD)</FieldLabel>
                <Input
                  id="bucket-amount"
                  inputMode="decimal"
                  value={bucketAmount}
                  placeholder="0.00"
                  disabled={bucketBusy}
                  onChange={(event) => {
                    setBucketAmount(event.target.value)
                    setBucketError("")
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="bucket-type">Item type</FieldLabel>
                <Select
                  value={bucketType}
                  onValueChange={(value) => setBucketType(value as ItemType)}
                  items={ITEM_TYPE_ITEMS}
                >
                  <SelectTrigger id="bucket-type" className="w-full" disabled={bucketBusy}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {ITEM_TYPE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="bucket-mode">Plan scope</FieldLabel>
                <Select
                  value={bucketMode}
                  onValueChange={(value) => setBucketMode(value as PlanMode)}
                  items={MODE_ITEMS}
                >
                  <SelectTrigger id="bucket-mode" className="w-full" disabled={bucketBusy}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {MODE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="bucket-frequency">Frequency</FieldLabel>
                <Select
                  value={bucketFrequency}
                  onValueChange={(value) => {
                    const frequency = value as Frequency
                    setBucketFrequency(frequency)
                    if (frequency !== "annual") setBucketDueMonth(null)
                  }}
                  items={FREQUENCY_ITEMS}
                >
                  <SelectTrigger id="bucket-frequency" className="w-full" disabled={bucketBusy}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {FREQUENCY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>Weekly counts as four weeks per month. The server does the conversion.</FieldDescription>
              </Field>
              {bucketFrequency === "annual" ? (
                <Field>
                  <FieldLabel htmlFor="bucket-due-month">Due month</FieldLabel>
                  <Select
                    value={bucketDueMonth === null ? undefined : String(bucketDueMonth)}
                    onValueChange={(value) => setBucketDueMonth(Number(value))}
                    items={DUE_MONTH_ITEMS}
                  >
                    <SelectTrigger id="bucket-due-month" className="w-full" disabled={bucketBusy}>
                      <SelectValue placeholder="Choose month" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {Object.entries(DUE_MONTH_ITEMS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              <FieldError>{bucketError}</FieldError>
            </FieldGroup>
            <DialogFooter showCloseButton>
              <Button type="submit" disabled={bucketBusy || !canWrite}>
                <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" aria-hidden="true" />
                {bucketBusy ? "Creating…" : "Create bucket"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename bucket</DialogTitle>
            <DialogDescription>
              Renaming keeps the same category identity and its saved history.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-5" onSubmit={(event) => void renameBucket(event)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="rename-bucket-name">Bucket name</FieldLabel>
                <Input
                  id="rename-bucket-name"
                  value={renameValue}
                  maxLength={MAX_CATEGORY_NAME}
                  disabled={renameBusy}
                  onChange={(event) => {
                    setRenameValue(event.target.value)
                    setRenameError("")
                  }}
                />
                <FieldError>{renameError}</FieldError>
              </Field>
            </FieldGroup>
            <DialogFooter showCloseButton>
              <Button type="submit" disabled={renameBusy || !canWrite}>
                <HugeiconsIcon icon={SaveIcon} data-icon="inline-start" aria-hidden="true" />
                {renameBusy ? "Saving…" : "Save name"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Budget history · {formatMonthLabel(month)}</DialogTitle>
            <DialogDescription>
              Each row is a saved change. Revert adds a new change and keeps the history.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-4">
            <Select
              value={historyCategoryId || HISTORY_ALL}
              onValueChange={(value) =>
                setHistoryCategoryId(value === HISTORY_ALL ? "" : String(value))
              }
              items={historyCategoryItems}
            >
              <SelectTrigger aria-label="Filter history by category" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {Object.entries(historyCategoryItems).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {historyError ? (
              <Alert variant="destructive" role="alert">
                <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
                <AlertTitle>History could not load</AlertTitle>
                <AlertDescription>{historyError}</AlertDescription>
              </Alert>
            ) : null}
            {historyLoading ? (
              <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading budget history">
                <Skeleton className="h-16 rounded-lg" />
                <Skeleton className="h-16 rounded-lg" />
                <Skeleton className="h-16 rounded-lg" />
              </div>
            ) : historyEntries.length === 0 ? (
              <Empty className="p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HugeiconsIcon icon={HistoryIcon} aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No plan changes recorded</EmptyTitle>
                  <EmptyDescription>
                    Nothing was saved for this month and category filter.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ScrollArea className="max-h-96 w-full">
                <div className="flex flex-col gap-3 pr-3">
                  {historyEntries.map((entry) => (
                    <div key={entry.id} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{entry.action}</span>
                        <Badge variant="outline">
                          {entry.recordType || "plan"} · {entry.scope || "recurring"}
                        </Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {entry.month || month} · revision {entry.revision ?? "unknown"}
                        {entry.createdAt ? ` · ${entry.createdAt}` : ""}
                      </span>
                      <div className="grid min-w-0 gap-2 text-xs sm:grid-cols-2">
                        <span className="min-w-0 break-words">Before: {compactJson(entry.before)}</span>
                        <span className="min-w-0 break-words">After: {compactJson(entry.after)}</span>
                      </div>
                      <div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!canWrite || revertBusyId !== null}
                          onClick={() => void revertHistory(entry)}
                        >
                          <HugeiconsIcon icon={Undo02Icon} data-icon="inline-start" aria-hidden="true" />
                          {revertBusyId === entry.id ? "Reverting…" : "Revert this change"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={stopTarget !== null}
        onOpenChange={(open) => {
          if (!open) setStopTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop future funding</AlertDialogTitle>
            <AlertDialogDescription>
              Review what will change before confirming. Earlier months and carryover are preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex min-w-0 flex-col gap-3 text-sm">
            {stopLoading ? (
              <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading funding preview">
                <Skeleton className="h-4 rounded" />
                <Skeleton className="h-4 rounded" />
              </div>
            ) : null}
            {stopError ? (
              <Alert variant="destructive" role="alert">
                <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
                <AlertTitle>Preview could not load</AlertTitle>
                <AlertDescription>{stopError}</AlertDescription>
              </Alert>
            ) : null}
            {stopPreview ? (
              <>
                <p>
                  <span className="font-medium">{stopPreview.category}</span>: create a recurring known-zero plan from {stopPreview.month}.
                </p>
                {stopPreview.laterTemplates.length + stopPreview.laterOverrides.length === 0 ? (
                  <p className="text-muted-foreground">No later plans need to be changed.</p>
                ) : (
                  <ul className="flex list-disc flex-col gap-2 pl-5">
                    {stopPreview.laterTemplates.map((template, index) => (
                      <li key={`template-${index}`} className="min-w-0 break-words">
                        Recurring plan from {readText(template.effectiveFrom, "unknown month")}: {formatCents(readCents(template.amount))}
                        {template.schedule === null || template.schedule === undefined
                          ? ""
                          : ` · ${compactJson(template.schedule)}`}
                      </li>
                    ))}
                    {stopPreview.laterOverrides.map((override, index) => (
                      <li key={`override-${index}`} className="min-w-0 break-words">
                        Month override for {readText(override.month, "unknown month")}: {formatCents(readCents(override.amount))}
                        {override.schedule === null || override.schedule === undefined
                          ? ""
                          : ` · ${compactJson(override.schedule)}`}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-muted-foreground">
                  Cancel leaves the plan unchanged. Confirm applies only to this bucket from the selected month onward.
                </p>
              </>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmStop()}
              disabled={!canWrite || stopBusy || stopLoading || !stopPreview || stopError !== ""}
            >
              <HugeiconsIcon icon={Alert02Icon} data-icon="inline-start" aria-hidden="true" />
              {stopBusy ? "Stopping…" : "Stop future funding"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  )
}
