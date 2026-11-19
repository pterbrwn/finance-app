import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  ArchiveIcon,
  Calendar03Icon,
  Edit02Icon,
  PlusSignIcon,
  UndoIcon,
} from "@hugeicons/core-free-icons"
import { useLedger } from "@/context/ledger-context"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/toast"
import { PageShell } from "@/components/page-shell"
import {
  asArray,
  asRecord,
  formatCents,
  formatDate,
  formatDollarsInput,
  parseDollarsToCents,
  profileLabel,
  type LedgerRecord,
  type ProfileId,
} from "@/lib/ledger"

type Owner = "peter" | "maddie" | "joint"

type GoalDialogState =
  | { mode: "create" }
  | { mode: "edit"; goal: LedgerRecord }
  | null

const OWNER_ITEMS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "none", label: "Choose an owner" },
  { value: "peter", label: "Peter" },
  { value: "maddie", label: "Maddie" },
  { value: "joint", label: "Joint" },
]

function isOwner(value: string): value is Owner {
  return value === "peter" || value === "maddie" || value === "joint"
}

function asCents(value: unknown) {
  return Number.isSafeInteger(value) ? (value as number) : null
}

function asText(value: unknown, fallback = "Not recorded") {
  return typeof value === "string" && value.trim() ? value : fallback
}

function asDate(value: unknown) {
  return formatDate(typeof value === "string" ? value : undefined)
}

function showSaved(message: string) {
  toast.add({ title: "Saved", description: message, type: "success" })
}

function GoalFormDialog({
  goal,
  onClose,
}: {
  goal: LedgerRecord | null
  onClose: () => void
}) {
  const { state, write } = useLedger()
  const [name, setName] = useState(asText(goal?.name, ""))
  const [target, setTarget] = useState(() =>
    formatDollarsInput(asCents(goal?.target) ?? null)
  )
  const [targetDate, setTargetDate] = useState(asText(goal?.targetDate, ""))
  const [priority, setPriority] = useState(String(goal?.priority ?? 100))
  const [owner, setOwner] = useState(
    isOwner(String(goal?.profileId ?? "")) ? String(goal?.profileId) : "none"
  )
  const [monthly, setMonthly] = useState(() =>
    formatDollarsInput(asCents(goal?.monthlyContribution) ?? null)
  )
  const [apy, setApy] = useState(() => {
    const bps = asCents(goal?.apyBps)
    return bps ? (bps / 100).toFixed(2) : ""
  })
  const [apyAsOf, setApyAsOf] = useState(asText(goal?.apyAsOf, ""))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const revision = state?.revision
    if (!Number.isSafeInteger(revision)) {
      setError("Refresh this dashboard before saving a goal.")
      return
    }
    const targetCents = parseDollarsToCents(target)
    const monthlyCents = monthly.trim() ? parseDollarsToCents(monthly) : 0
    const priorityNumber = Number(priority)
    const apyBps =
      apy.trim() === ""
        ? 0
        : /^\d{1,2}(?:\.\d{1,2})?$/.test(apy.trim())
          ? Math.round(Number(apy.trim()) * 100)
          : -1

    if (!name.trim() || name.trim().length > 100) {
      setError("Enter a goal name up to 100 characters.")
      return
    }
    if (!isOwner(owner)) {
      setError("Choose Peter, Maddie, or Joint as the goal owner.")
      return
    }
    if (targetCents === null || targetCents < 0) {
      setError("Enter a valid target amount in dollars.")
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      setError("Choose a target date.")
      return
    }
    if (
      !Number.isSafeInteger(priorityNumber) ||
      priorityNumber < 0 ||
      priorityNumber > 1000
    ) {
      setError("Choose a priority from 0 to 1000.")
      return
    }
    if (monthlyCents === null || monthlyCents < 0) {
      setError("Enter a valid planned monthly contribution.")
      return
    }
    if (!Number.isSafeInteger(apyBps) || apyBps < 0 || apyBps > 3000) {
      setError("Enter an annual APY from 0 to 30 percent.")
      return
    }
    if (apyBps > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(apyAsOf)) {
      setError("Add the date for this APY assumption.")
      return
    }

    const input: Record<string, unknown> = {
      name: name.trim(),
      target: targetCents,
      targetDate,
      profileId: owner,
      priority: priorityNumber,
      monthlyContribution: monthlyCents,
      apyBps,
      apyAsOf: apyBps > 0 ? apyAsOf : null,
      revision,
    }
    if (goal && typeof goal.id === "string") input.id = goal.id

    setSaving(true)
    try {
      await write("goal", input)
      showSaved(goal ? "Goal updated." : "Goal created.")
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this goal.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{goal ? "Edit savings goal" : "New savings goal"}</DialogTitle>
        <DialogDescription>
          A goal is a plan backed by eligible cash you already hold. It does not
          move money or create assets.
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="goal-name">Name</FieldLabel>
            <Input
              id="goal-name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="goal-owner">Owner</FieldLabel>
            <Select
              items={OWNER_ITEMS}
              value={owner}
              onValueChange={(value) => setOwner(typeof value === "string" ? value : "none")}
            >
              <SelectTrigger id="goal-owner" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {OWNER_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>Peter, Maddie, or Joint only.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="goal-priority">Priority</FieldLabel>
            <Input
              id="goal-priority"
              type="number"
              min={0}
              max={1000}
              step={1}
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
            <FieldDescription>Lower numbers are funded first.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="goal-target">Target amount (USD)</FieldLabel>
            <Input
              id="goal-target"
              inputMode="decimal"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="goal-date">Target date</FieldLabel>
            <Input
              id="goal-date"
              type="date"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="goal-monthly">Planned monthly contribution (USD)</FieldLabel>
            <Input
              id="goal-monthly"
              inputMode="decimal"
              value={monthly}
              onChange={(event) => setMonthly(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="goal-apy">Annual cash APY (%)</FieldLabel>
            <Input
              id="goal-apy"
              inputMode="decimal"
              value={apy}
              onChange={(event) => setApy(event.target.value)}
            />
            <FieldDescription>Zero is the default when left blank.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="goal-apy-date">APY assumption date</FieldLabel>
            <Input
              id="goal-apy-date"
              type="date"
              value={apyAsOf}
              onChange={(event) => setApyAsOf(event.target.value)}
            />
          </Field>
        </div>
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save goal"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function AllocationDialog({
  goal,
  onClose,
}: {
  goal: LedgerRecord
  onClose: () => void
}) {
  const { state, write } = useLedger()
  const summary = asRecord(state?.goalSummary)
  const summaryAccounts = asArray<LedgerRecord>(summary.accounts).filter(
    (account) => account.eligible === true
  )
  const accounts = asArray<LedgerRecord>(state?.accounts)
  const allocations = asArray<LedgerRecord>(state?.goalAllocations)
  const goalId = typeof goal.id === "string" ? goal.id : ""

  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const account of summaryAccounts) {
      const accountId = typeof account.accountId === "string" ? account.accountId : ""
      if (!accountId) continue
      const own = allocations.find(
        (row) => row.goalId === goalId && row.accountId === accountId && row.active !== false
      )
      initial[accountId] = formatDollarsInput(asCents(own?.amount) ?? 0)
    }
    return initial
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const revision = state?.revision
    if (!Number.isSafeInteger(revision)) {
      setError("Refresh this dashboard before changing allocations.")
      return
    }
    const requested: Array<{ accountId: string; amount: number }> = []
    for (const account of summaryAccounts) {
      const accountId = typeof account.accountId === "string" ? account.accountId : ""
      if (!accountId) continue
      const amount = parseDollarsToCents(amounts[accountId] ?? "")
      const own = allocations.find(
        (row) => row.goalId === goalId && row.accountId === accountId && row.active !== false
      )
      const capacity = Math.max(
        0,
        (asCents(account.unallocated) ?? 0) + (asCents(own?.amount) ?? 0)
      )
      if (amount === null || amount < 0) {
        setError("Enter a non-negative dollar amount for every account.")
        return
      }
      if (amount > capacity) {
        setError("An allocation exceeds the fresh unallocated cash in that account.")
        return
      }
      if (amount > 0) requested.push({ accountId, amount })
    }

    setSaving(true)
    try {
      await write("goal-allocations", { goalId, allocations: requested, revision })
      showSaved("Goal allocations saved.")
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save allocations.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Allocate cash to {asText(goal.name, "this goal")}</DialogTitle>
        <DialogDescription>
          Only fresh, included USD cash from your accounts can back a goal. Saving
          replaces this goal’s current set-aside amounts; no money is moved.
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {summaryAccounts.length === 0 ? (
          <EmptyAccounts />
        ) : (
          <div className="flex flex-col gap-3">
            {summaryAccounts.map((account) => {
              const accountId = typeof account.accountId === "string" ? account.accountId : ""
              const saved = accounts.find((row) => row.id === accountId)
              const own = allocations.find(
                (row) =>
                  row.goalId === goalId && row.accountId === accountId && row.active !== false
              )
              const capacity = Math.max(
                0,
                (asCents(account.unallocated) ?? 0) + (asCents(own?.amount) ?? 0)
              )
              return (
                <Field key={accountId}>
                  <FieldLabel htmlFor={`allocation-${accountId}`}>
                    {asText(saved?.name ?? account.name, "Cash account")}
                  </FieldLabel>
                  <Input
                    id={`allocation-${accountId}`}
                    inputMode="decimal"
                    value={amounts[accountId] ?? "0.00"}
                    onChange={(event) =>
                      setAmounts((current) => ({
                        ...current,
                        [accountId]: event.target.value,
                      }))
                    }
                  />
                  <FieldDescription>
                    {formatCents(asCents(account.balance))} balance ·{" "}
                    {formatCents(capacity)} available after other goals.
                  </FieldDescription>
                </Field>
              )
            })}
          </div>
        )}
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || summaryAccounts.length === 0}>
            {saving ? "Saving…" : "Save allocations"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function EmptyAccounts() {
  return (
    <Alert>
      <HugeiconsIcon icon={Alert02Icon} />
      <AlertTitle>No fresh eligible cash accounts</AlertTitle>
      <AlertDescription>
        Sync or update a manual balance before allocating cash to a goal.
      </AlertDescription>
    </Alert>
  )
}

function ProjectionDialog({ goal }: { goal: LedgerRecord }) {
  const { state, preview, profile, write } = useLedger()
  const [projection, setProjection] = useState<LedgerRecord>(
    asRecord(goal.projection)
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const revision = state?.revision
  const canRefresh =
    !preview &&
    profile !== "combined" &&
    Number.isSafeInteger(revision) &&
    typeof goal.id === "string"

  async function refresh() {
    if (!canRefresh || typeof goal.id !== "string") return
    setLoading(true)
    setError(null)
    try {
      const result = asRecord(await write("goal-projection", { id: goal.id, revision }))
      setProjection(result)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not refresh this projection.")
    } finally {
      setLoading(false)
    }
  }

  const rows: Array<[string, unknown]> = [
    ["Target", projection.target],
    ["Funded from fresh cash", projection.funded],
    ["Shortfall", projection.shortfall],
    ["Contribution months", projection.contributionDates],
    ["Suggested monthly amount", projection.requiredMonthly],
    ["Planned monthly contribution", projection.monthlyContribution],
    ["Projected at target", projection.projectedAtTarget],
    ["Projected shortfall", projection.projectedShortfall],
    ["Annual APY (basis points)", projection.apyBps],
  ]

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Projection details</DialogTitle>
        <DialogDescription>
          Estimates for {asText(goal.name, "this goal")}. Projected values are
          separate from cash you have actually set aside.
        </DialogDescription>
      </DialogHeader>
      <Accordion>
        <AccordionItem value="projection">
          <AccordionTrigger>Projection figures</AccordionTrigger>
          <AccordionContent>
            <dl className="flex flex-col gap-2">
              {rows.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd data-numeric className="tabular-nums">
                    {Number.isSafeInteger(value) && label.includes("amount")
                      ? formatCents(value as number)
                      : Number.isSafeInteger(value) && label.includes("Projected")
                        ? formatCents(value as number)
                        : Number.isSafeInteger(value) && ["Target", "Funded from fresh cash", "Shortfall", "Projected shortfall"].includes(label)
                          ? formatCents(value as number)
                          : value === null || value === undefined
                            ? "Not recorded"
                            : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
            {Array.isArray(projection.scheduledDates) ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Scheduled month-end contributions:{" "}
                {projection.scheduledDates
                  .map((date: unknown) => String(date))
                  .join(", ") || "None"}
              </p>
            ) : null}
            {projection.growthAvailable === false ? (
              <p className="mt-3 text-sm">
                {asText(projection.growthReason, "Growth projection unavailable.")}
              </p>
            ) : null}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <DialogFooter showCloseButton>
        <Button type="button" variant="outline" onClick={() => void refresh()} disabled={!canRefresh || loading}>
          {loading ? "Refreshing…" : "Refresh projection"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function GoalsPage() {
  const { state, preview, profile, write } = useLedger()
  const [goalDialog, setGoalDialog] = useState<GoalDialogState>(null)
  const [allocationGoal, setAllocationGoal] = useState<LedgerRecord | null>(null)
  const [projectionGoal, setProjectionGoal] = useState<LedgerRecord | null>(null)
  const [archiveGoal, setArchiveGoal] = useState<LedgerRecord | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const summary = asRecord(state?.goalSummary)
  const summaryGoals = asArray<LedgerRecord>(summary.goals)
  const rawGoals = asArray<LedgerRecord>(state?.goals)
  const goals = summaryGoals.length > 0 ? summaryGoals : rawGoals
  const allocations = asArray<LedgerRecord>(state?.goalAllocations)
  const undo = asRecord(state?.lastGoalAllocationUndo)
  const revision = state?.revision
  const canWriteState =
    !preview && profile !== "combined" && Number.isSafeInteger(revision)

  const activeGoals = goals.filter((goal) => goal.archived !== true && !goal.archivedAt)
  const archivedGoals = goals.filter((goal) => goal.archived === true || !!goal.archivedAt)

  function allocatedCents(goalId: unknown) {
    return allocations
      .filter(
        (row) =>
          row.goalId === goalId && row.active !== false && asCents(row.amount) !== null
      )
      .reduce((total, row) => total + (asCents(row.amount) ?? 0), 0)
  }

  async function archiveSelected() {
    if (!archiveGoal || !canWriteState) return
    const id = typeof archiveGoal.id === "string" ? archiveGoal.id : ""
    if (!id) return
    setArchiving(true)
    setActionError(null)
    try {
      await write("goal", { action: "archive", id, revision })
      showSaved("Goal archived. Its cash is no longer set aside for this plan.")
      setArchiveGoal(null)
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not archive this goal.")
    } finally {
      setArchiving(false)
    }
  }

  async function undoLastAllocation() {
    if (!canWriteState || typeof undo.id !== "string") return
    setActionError(null)
    try {
      await write("goal-allocation-undo", { batchId: undo.id, revision })
      showSaved("The last goal allocation change was undone.")
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not undo that allocation.")
    }
  }

  function goalCard(goal: LedgerRecord) {
    const goalId = typeof goal.id === "string" ? goal.id : ""
    const projection = asRecord(goal.projection)
    const owner = isOwner(String(goal.profileId ?? ""))
      ? profileLabel(goal.profileId as ProfileId)
      : "Needs ownership review"
    const projected = asCents(projection.projectedAtTarget)
    const allocated = allocatedCents(goalId)

    return (
      <Card key={goalId} size="sm" className="min-w-0">
        <CardHeader>
          <div className="flex min-w-0 flex-col gap-2">
            <CardTitle className="min-w-0 break-words">
              {asText(goal.name, "Untitled goal")}
            </CardTitle>
            <CardDescription>
              Target {formatCents(asCents(goal.target))} by {asDate(goal.targetDate)} · Priority{" "}
              {Number.isSafeInteger(goal.priority) ? String(goal.priority) : "Not recorded"} · {owner}
            </CardDescription>
          </div>
          <CardAction className="flex flex-wrap items-center gap-2">
            {goal.archived === true || goal.archivedAt ? (
              <Badge variant="outline">Archived</Badge>
            ) : null}
            <Badge variant={projection.overdue === true ? "destructive" : "secondary"}>
              {projection.overdue === true
                ? "Overdue"
                : asCents(goal.shortfall) === 0
                  ? "On target"
                  : "In progress"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Allocated cash</p>
              <p data-numeric className="font-medium tabular-nums">
                {formatCents(allocated)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Backed by fresh cash</p>
              <p data-numeric className="font-medium tabular-nums">
                {formatCents(asCents(goal.backed ?? goal.funded))}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Remaining to target</p>
              <p data-numeric className="font-medium tabular-nums">
                {formatCents(asCents(goal.shortfall))}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Projected at target date</p>
              <p data-numeric className="font-medium tabular-nums">
                {projection.growthAvailable === false || projected === null
                  ? "Unavailable"
                  : formatCents(projected)}
              </p>
            </div>
          </div>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <HugeiconsIcon icon={Calendar03Icon} className="size-4" />
            Projection uses the planned monthly contribution and APY assumption through{" "}
            {asDate(goal.targetDate)}. Projected dates are estimates, not recorded balances.
          </p>
          {asCents(goal.provisional) ? (
            <p className="text-xs">
              {formatCents(asCents(goal.provisional))} of this goal’s backing comes from a
              stale cash balance and is provisional only.
            </p>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setAllocationGoal(goal)}
              disabled={!canWriteState || !!goal.archivedAt}
            >
              <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
              Allocate cash
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setProjectionGoal(goal)}
            >
              Projection details
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setGoalDialog({ mode: "edit", goal })}
              disabled={!canWriteState}
            >
              <HugeiconsIcon icon={Edit02Icon} data-icon="inline-start" />
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => setArchiveGoal(goal)}
              disabled={!canWriteState || !!goal.archivedAt}
            >
              <HugeiconsIcon icon={ArchiveIcon} data-icon="inline-start" />
              Archive
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <PageShell
      title="Goals"
      description="Plan savings using eligible cash you already hold."
      actions={
        <Button
          type="button"
          onClick={() => setGoalDialog({ mode: "create" })}
          disabled={!canWriteState}
        >
          <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
          New goal
        </Button>
      }
    >
      <Alert>
        <HugeiconsIcon icon={Alert02Icon} />
        <AlertTitle>Goals are plans, not transfers</AlertTitle>
        <AlertDescription>
          A goal is backed by eligible cash you already hold. Creating or funding a goal
          does not move money, create an asset, or make the amount freely spendable.
        </AlertDescription>
      </Alert>

      {asCents(summary.provisionalTotal) ? (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>
            <span className="inline-flex items-center gap-2">
              <Badge variant="outline">Provisional</Badge>
              Backing includes stale cash
            </span>
          </AlertTitle>
          <AlertDescription>
            {formatCents(asCents(summary.provisionalTotal))} comes from cash whose observed
            balance is no longer fresh. Treat it as provisional, never as confirmed backing.
          </AlertDescription>
        </Alert>
      ) : null}

      {actionError ? (
        <Alert variant="destructive" role="alert">
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Need attention</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {profile === "combined" ? (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Read-only view</AlertTitle>
          <AlertDescription>
            Goal creation, allocation, edit, and archive actions are disabled in the
            combined profile. Switch to an individual profile to make changes.
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="Goal funding" className="grid gap-3 sm:grid-cols-3">
        <Card size="sm">
          <CardHeader className="gap-1">
            <CardTitle className="text-sm text-muted-foreground">Eligible cash</CardTitle>
          </CardHeader>
          <CardContent>
            <p data-numeric className="text-xl font-semibold tabular-nums">
              {formatCents(asCents(summary.eligibleTotal))}
            </p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="gap-1">
            <CardTitle className="text-sm text-muted-foreground">Unallocated cash</CardTitle>
          </CardHeader>
          <CardContent>
            <p data-numeric className="text-xl font-semibold tabular-nums">
              {formatCents(asCents(summary.unallocatedTotal))}
            </p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="gap-1">
            <CardTitle className="text-sm text-muted-foreground">Provisional backing</CardTitle>
            {asCents(summary.provisionalTotal) ? (
              <Badge variant="outline" className="w-fit">Provisional</Badge>
            ) : null}
          </CardHeader>
          <CardContent>
            <p data-numeric className="text-xl font-semibold tabular-nums">
              {formatCents(asCents(summary.provisionalTotal))}
            </p>
          </CardContent>
        </Card>
      </section>

      {undo.id ? (
        <Alert>
          <HugeiconsIcon icon={UndoIcon} />
          <AlertTitle>Last allocation change can be undone</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Batch {asText(undo.id, "unknown")} · {asText(undo.createdAt, "time unavailable")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void undoLastAllocation()}
              disabled={!canWriteState}
            >
              Undo last allocation
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="Savings goals" className="flex min-w-0 flex-col gap-3">
        <h2 className="text-sm font-medium">Active goals</h2>
        {activeGoals.length === 0 ? (
          <EmptyGoals onCreate={() => setGoalDialog({ mode: "create" })} disabled={!canWriteState} />
        ) : (
          activeGoals.map(goalCard)
        )}
      </section>

      {archivedGoals.length > 0 ? (
        <Accordion>
          <AccordionItem value="archived-goals">
            <AccordionTrigger>{archivedGoals.length} archived goals</AccordionTrigger>
            <AccordionContent className="flex flex-col gap-3">
              {archivedGoals.map(goalCard)}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Household, Peter, Maddie, and Joint are organisational views, not a privacy boundary.
      </p>

      <Dialog
        open={goalDialog !== null}
        onOpenChange={(open) => {
          if (!open) setGoalDialog(null)
        }}
      >
        {goalDialog ? (
          <GoalFormDialog
            goal={goalDialog.mode === "edit" ? goalDialog.goal : null}
            onClose={() => setGoalDialog(null)}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={allocationGoal !== null}
        onOpenChange={(open) => {
          if (!open) setAllocationGoal(null)
        }}
      >
        {allocationGoal ? (
          <AllocationDialog goal={allocationGoal} onClose={() => setAllocationGoal(null)} />
        ) : null}
      </Dialog>

      <Dialog
        open={projectionGoal !== null}
        onOpenChange={(open) => {
          if (!open) setProjectionGoal(null)
        }}
      >
        {projectionGoal ? <ProjectionDialog goal={projectionGoal} /> : null}
      </Dialog>

      <AlertDialog
        open={archiveGoal !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveGoal(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this goal?</AlertDialogTitle>
            <AlertDialogDescription>
              Archiving {asText(archiveGoal?.name, "this goal")} deactivates it and releases
              its cash allocations. The goal record and its history remain saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep goal</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void archiveSelected()}
              disabled={archiving}
            >
              {archiving ? "Archiving…" : "Archive goal"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  )
}

function EmptyGoals({
  onCreate,
  disabled,
}: {
  onCreate: () => void
  disabled: boolean
}) {
  return (
    <EmptyState title="No savings goals yet" description="Add a goal to plan against eligible cash you already hold.">
      <Button type="button" onClick={onCreate} disabled={disabled}>
        <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
        New goal
      </Button>
    </EmptyState>
  )
}

function EmptyState({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  )
}
