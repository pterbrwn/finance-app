import { useMemo, useState, type FormEvent } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Link01Icon,
  PlusSignIcon,
  RefreshIcon,
  Unlink01Icon,
} from "@hugeicons/core-free-icons"
import { cn } from "cn"

import { PageShell } from "@/components/page-shell"
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
import { Checkbox } from "@/components/ui/checkbox"
import {
  Card,
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "@/components/ui/toast"
import { useLedger } from "@/context/ledger-context"
import { useCommitments } from "@/hooks/use-ledger-resource"
import {
  asArray,
  asRecord,
  formatCents,
  formatDate,
  parseDollarsToCents,
  PROFILE_OPTIONS,
  type LedgerRecord,
} from "@/lib/ledger"

type BillFrequency = "weekly" | "monthly" | "annual"
type OwnerId = "peter" | "maddie" | "joint"

type BillDraft = {
  name: string
  amount: string
  frequency: BillFrequency
  startDate: string
  endDate: string
  profileId: OwnerId
}

type MatchDraft = {
  commitmentId: string
  dueDate: string
  transactionId: string
  confirmed: boolean
}

type PendingAction =
  | { kind: "cancel"; commitmentId: string }
  | { kind: "unlink"; commitmentId: string; dueDate: string }

const FREQUENCY_ITEMS: ReadonlyArray<{ value: BillFrequency; label: string }> = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Yearly" },
]

const OWNER_ITEMS: ReadonlyArray<{ value: OwnerId; label: string }> =
  PROFILE_OPTIONS.filter(
    (option): option is { value: OwnerId; label: string } =>
      option.value !== "combined"
  ).map((option) => ({ value: option.value, label: option.label }))

function dateOnly(daysFromToday: number) {
  const now = new Date()
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function safeCents(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}

function text(value: unknown, fallback = "—") {
  return typeof value === "string" && value.trim() ? value : fallback
}

function ownerLabel(value: unknown) {
  const id = typeof value === "string" ? value : ""
  return PROFILE_OPTIONS.find((option) => option.value === id)?.label ?? "Needs ownership review"
}

function frequencyLabel(value: unknown) {
  return FREQUENCY_ITEMS.find((option) => option.value === value)?.label ?? text(value, "Not recorded")
}

function statusLabel(commitment: LedgerRecord | undefined, rows: LedgerRecord[]) {
  if (commitment && text(commitment.status, "active") === "cancelled") return "Cancelled"
  if (rows.some((row) => text(row.status) === "needs-review")) return "Needs review"
  if (rows.some((row) => text(row.status) === "user-confirmed")) return "Matched"
  return "Upcoming"
}

function scheduleCopy(frequency: BillFrequency, startDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return "Choose the first due date to preview the schedule."
  }
  if (frequency === "weekly") return `Repeats every week from ${startDate}.`
  if (frequency === "annual") {
    return `Repeats each year on ${startDate.slice(5)}. If that date does not exist, the last day of the month is used.`
  }
  const day = Number(startDate.slice(8, 10))
  return `Repeats monthly on day ${day}. Shorter months use their last day.`
}

export function CommitmentsPage() {
  const { state, profile, preview, write } = useLedger()
  const range = useMemo(() => ({ from: dateOnly(0), to: dateOnly(90) }), [])
  const resource = useCommitments(range.from, range.to, profile)

  const [addOpen, setAddOpen] = useState(false)
  const [draft, setDraft] = useState<BillDraft>(() => ({
    name: "",
    amount: "",
    frequency: "monthly",
    startDate: range.from,
    endDate: "",
    profileId:
      profile === "peter" || profile === "maddie" || profile === "joint"
        ? profile
        : "peter",
  }))
  const [addError, setAddError] = useState<string | null>(null)
  const [savingBill, setSavingBill] = useState(false)

  const [matchDraft, setMatchDraft] = useState<MatchDraft | null>(null)
  const [matchError, setMatchError] = useState<string | null>(null)
  const [savingMatch, setSavingMatch] = useState(false)

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [busyAction, setBusyAction] = useState(false)

  const payload = asRecord(resource.data)
  const resourceBills = asArray<LedgerRecord>(payload.commitments)
  const savedBills = resourceBills.length
    ? resourceBills
    : asArray<LedgerRecord>(state?.commitments)
  const forecast = asArray<LedgerRecord>(payload.forecast)
  const rawMatches = asArray<LedgerRecord>(
    Array.isArray(payload.matches) && payload.matches.length
      ? payload.matches
      : state?.commitmentMatches
  )
  const matches = rawMatches.filter(
    (row) => text(row.status, "user-confirmed") !== "unlinked"
  )

  const combinedProfile = profile === "combined"
  const writesDisabled = preview || combinedProfile || busyAction || savingBill || savingMatch
  const combinedNote = combinedProfile
    ? "Bills belong to Peter, Maddie, or Joint. Switch the household view to an owner before adding, cancelling, or matching a bill."
    : null

  const forecastFor = (commitmentId: string) =>
    forecast.filter((row) => text(row.commitmentId) === commitmentId)

  const nextDueDate = (commitmentId: string, fallback: string) => {
    const dates = forecastFor(commitmentId)
      .map((row) => text(row.dueDate, ""))
      .filter((date) => date && date >= range.from)
      .sort()
    return dates[0] ?? fallback
  }

  const activeMatchTransactionIds = new Set(
    matches.map((row) => text(row.transactionId)).filter((id) => id !== "—")
  )

  const candidateTransactions = (() => {
    if (!matchDraft) return []
    const bill = savedBills.find((row) => text(row.id) === matchDraft.commitmentId)
    const target = safeCents(bill?.amount)
    return asArray<LedgerRecord>(state?.transactions).filter((row) => {
      const amount = safeCents(row.amount)
      if (target === null || amount !== target) return false
      if (text(row.currency, "USD") !== "USD" || row.pending === true) return false
      if (activeMatchTransactionIds.has(text(row.id))) return false
      if (combinedProfile) return true
      const owner = text(row.profileId, "")
      return !owner || owner === profile
    })
  })()

  const openMatchDialog = (bill: LedgerRecord) => {
    const id = text(bill.id)
    const dates = forecastFor(id)
      .map((row) => text(row.dueDate, ""))
      .filter(Boolean)
      .sort()
    setMatchError(null)
    setMatchDraft({
      commitmentId: id,
      dueDate: dates[0] ?? text(bill.startDate, range.from),
      transactionId: "",
      confirmed: false,
    })
  }

  const closeMatchDialog = () => {
    if (savingMatch) return
    setMatchDraft(null)
    setMatchError(null)
  }

  const saveBill = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (writesDisabled) return
    const amount = parseDollarsToCents(draft.amount)
    if (!draft.name.trim()) {
      setAddError("Enter a name for this bill.")
      return
    }
    if (amount === null || amount <= 0) {
      setAddError("Enter a positive amount in dollars.")
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate)) {
      setAddError("Choose the first due date.")
      return
    }
    if (draft.endDate && draft.endDate < draft.startDate) {
      setAddError("The end date must be on or after the first due date.")
      return
    }
    const day = Number(draft.startDate.slice(8, 10))
    const dueMonth = Number(draft.startDate.slice(5, 7))
    const weekday = new Date(`${draft.startDate}T12:00:00Z`).getUTCDay()
    const commitment: LedgerRecord = {
      name: draft.name.trim(),
      amount,
      frequency: draft.frequency,
      startDate: draft.startDate,
      endDate: draft.endDate || null,
      dayOfMonth: day,
      dueMonth,
      ...(draft.frequency === "weekly" ? { weekday } : {}),
    }
    setSavingBill(true)
    setAddError(null)
    try {
      await write("commitments", {
        commitment,
        profileId: draft.profileId,
        revision: state?.revision ?? 0,
      })
      await resource.refresh()
      toast.add({
        type: "success",
        title: "Bill saved",
        description: `${draft.name.trim()} now has a dated schedule.`,
      })
      setAddOpen(false)
      setDraft({
        name: "",
        amount: "",
        frequency: "monthly",
        startDate: range.from,
        endDate: "",
        profileId: draft.profileId,
      })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The bill could not be saved."
      setAddError(message)
      toast.add({ type: "error", title: "Bill not saved", description: message })
    } finally {
      setSavingBill(false)
    }
  }

  const confirmPendingAction = async () => {
    if (!pendingAction || busyAction || writesDisabled) return
    setBusyAction(true)
    try {
      if (pendingAction.kind === "cancel") {
        await write("commitments", {
          action: "cancel",
          id: pendingAction.commitmentId,
          revision: state?.revision ?? 0,
        })
        toast.add({
          type: "success",
          title: "Future dates cancelled",
          description: "Past dates and confirmed payments stay saved.",
        })
      } else {
        await write("commitment-match", {
          action: "unlink",
          commitmentId: pendingAction.commitmentId,
          dueDate: pendingAction.dueDate,
          confirmed: true,
          revision: state?.revision ?? 0,
        })
        toast.add({
          type: "success",
          title: "Payment unlinked",
          description: "The payment remains in your transactions.",
        })
      }
      await resource.refresh()
      setPendingAction(null)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The change could not be saved."
      toast.add({ type: "error", title: "Change not saved", description: message })
    } finally {
      setBusyAction(false)
    }
  }

  const saveMatch = async () => {
    if (!matchDraft || savingMatch || writesDisabled) return
    if (!matchDraft.dueDate) {
      setMatchError("Choose a scheduled due date for this bill.")
      return
    }
    if (!matchDraft.transactionId) {
      setMatchError("Choose the transaction that paid this bill.")
      return
    }
    if (!matchDraft.confirmed) {
      setMatchError("Confirm that you reviewed the payment match.")
      return
    }
    setSavingMatch(true)
    setMatchError(null)
    try {
      await write("commitment-match", {
        commitmentId: matchDraft.commitmentId,
        dueDate: matchDraft.dueDate,
        transactionId: matchDraft.transactionId,
        confirmed: true,
        revision: state?.revision ?? 0,
      })
      await resource.refresh()
      toast.add({
        type: "success",
        title: "Payment matched",
        description: "The bill date now shows a reviewed payment.",
      })
      setMatchDraft(null)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The match could not be saved."
      setMatchError(message)
      toast.add({ type: "error", title: "Match not saved", description: message })
    } finally {
      setSavingMatch(false)
    }
  }

  const pendingBill = pendingAction
    ? savedBills.find((row) => text(row.id) === pendingAction.commitmentId)
    : undefined
  const matchBill = matchDraft
    ? savedBills.find((row) => text(row.id) === matchDraft.commitmentId)
    : undefined
  const matchDates = matchDraft
    ? forecastFor(matchDraft.commitmentId)
        .map((row) => text(row.dueDate, ""))
        .filter((date, index, all) => date && all.indexOf(date) === index)
        .sort()
    : []

  return (
    <PageShell
      title="Bills"
      description="Track recurring bills by their actual due dates."
      actions={
        <Button
          type="button"
          onClick={() => {
            setAddError(null)
            setAddOpen(true)
          }}
          disabled={writesDisabled}
        >
          <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
          Add a bill
        </Button>
      }
    >
      {combinedNote ? (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Choose an owner to edit bills</AlertTitle>
          <AlertDescription>{combinedNote}</AlertDescription>
        </Alert>
      ) : null}

      {resource.error ? (
        <Alert variant="destructive" role="alert">
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Bill schedule could not load</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{resource.error}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void resource.refresh()}
            >
              <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {resource.stale && resource.data ? (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Saved bill dates may be stale</AlertTitle>
          <AlertDescription>
            Reload this section before confirming a payment against these dates.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Upcoming bills · next 90 days</CardTitle>
          <CardDescription>
            {range.from} through {range.to}. Expected dates are plans, not proof of
            payment. A date counts as matched only after you review and confirm a
            posted transaction.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 px-0 pb-0">
          {forecast.length === 0 ? (
            <p className="px-(--card-spacing) pb-(--card-spacing) text-sm text-muted-foreground">
              {resource.loading
                ? "Loading scheduled dates…"
                : "No due dates fall in the next 90 days. Add a bill to create a schedule."}
            </p>
          ) : (
            <Table>
              <TableBody>
                {forecast.map((row, index) => {
                  const commitmentId = text(row.commitmentId)
                  const bill = savedBills.find((item) => text(item.id) === commitmentId)
                  const match = matches.find(
                    (item) =>
                      text(item.commitmentId) === commitmentId &&
                      text(item.dueDate) === text(row.dueDate)
                  )
                  const status = statusLabel(bill, [row])
                  return (
                    <TableRow
                      key={`${commitmentId}-${text(row.dueDate)}-${index}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 p-3 sm:table-row sm:p-0"
                    >
                      <TableCell className="order-1 min-w-0 p-0 font-medium sm:order-none sm:p-3">
                        <span className="block truncate">{text(row.name, "Bill")}</span>
                        <span className="block text-xs font-normal text-muted-foreground">
                          {frequencyLabel(bill?.frequency)} · {ownerLabel(bill?.profileId)}
                        </span>
                      </TableCell>
                      <TableCell
                        data-numeric
                        className="order-2 p-0 text-right tabular-nums sm:order-none sm:p-3"
                      >
                        {formatCents(safeCents(row.amount) ?? safeCents(bill?.amount))}
                      </TableCell>
                      <TableCell className="order-3 p-0 text-xs text-muted-foreground sm:order-none sm:p-3">
                        Due {formatDate(text(row.dueDate))}
                      </TableCell>
                      <TableCell className="order-4 p-0 sm:order-none sm:p-3">
                        <Badge
                          variant={status === "Matched" ? "secondary" : "outline"}
                          className={cn(status === "Needs review" && "text-destructive")}
                        >
                          {status}
                        </Badge>
                      </TableCell>
                      <TableCell className="order-5 col-span-2 p-0 sm:order-none sm:col-span-1 sm:p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {match ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={writesDisabled}
                              onClick={() =>
                                setPendingAction({
                                  kind: "unlink",
                                  commitmentId,
                                  dueDate: text(row.dueDate),
                                })
                              }
                            >
                              <HugeiconsIcon icon={Unlink01Icon} data-icon="inline-start" />
                              Unlink payment
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={writesDisabled}
                              onClick={() => bill && openMatchDialog(bill)}
                            >
                              <HugeiconsIcon icon={Link01Icon} data-icon="inline-start" />
                              Review payment match
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Saved bills</CardTitle>
          <CardDescription>
            Each bill keeps its owner, recurrence, and source account when one is
            assigned. Cancelling stops future dates without changing history.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 px-0 pb-0">
          {savedBills.length === 0 ? (
            <p className="px-(--card-spacing) pb-(--card-spacing) text-sm text-muted-foreground">
              No bills saved yet.
            </p>
          ) : (
            <Table>
              <TableHeader className="hidden sm:table-header-group">
                <TableRow>
                  <TableHead scope="col">Bill</TableHead>
                  <TableHead scope="col">Amount</TableHead>
                  <TableHead scope="col">Frequency</TableHead>
                  <TableHead scope="col">First due</TableHead>
                  <TableHead scope="col">Next due</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Owner / account</TableHead>
                  <TableHead scope="col">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {savedBills.map((bill) => {
                  const id = text(bill.id)
                  const billForecast = forecastFor(id)
                  const status = statusLabel(bill, billForecast)
                  const account = state?.accounts.find(
                    (row) => row.id === text(bill.accountId)
                  )
                  return (
                    <TableRow
                      key={id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 p-3 sm:table-row sm:p-0"
                    >
                      <TableCell className="order-1 min-w-0 p-0 font-medium sm:order-none sm:p-3">
                        <span className="block truncate">{text(bill.name, "Bill")}</span>
                      </TableCell>
                      <TableCell
                        data-numeric
                        className="order-2 p-0 text-right tabular-nums sm:order-none sm:p-3"
                      >
                        {formatCents(safeCents(bill.amount))}
                      </TableCell>
                      <TableCell className="order-3 p-0 text-xs text-muted-foreground sm:order-none sm:p-3">
                        {frequencyLabel(bill.frequency)}
                      </TableCell>
                      <TableCell className="order-4 p-0 text-xs text-muted-foreground sm:order-none sm:p-3">
                        {formatDate(text(bill.startDate))}
                      </TableCell>
                      <TableCell className="order-5 p-0 text-xs text-muted-foreground sm:order-none sm:p-3">
                        {formatDate(nextDueDate(id, text(bill.startDate)))}
                      </TableCell>
                      <TableCell className="order-6 p-0 sm:order-none sm:p-3">
                        <Badge
                          variant={status === "Matched" ? "secondary" : "outline"}
                          className={cn(status === "Needs review" && "text-destructive")}
                        >
                          {status}
                        </Badge>
                      </TableCell>
                      <TableCell className="order-7 p-0 text-xs text-muted-foreground sm:order-none sm:p-3">
                        <span className="block">{ownerLabel(bill.profileId)}</span>
                        <span className="block">{account?.name ?? "No account linked"}</span>
                      </TableCell>
                      <TableCell className="order-8 col-span-2 p-0 sm:order-none sm:col-span-1 sm:p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={writesDisabled || status === "Cancelled"}
                            onClick={() => openMatchDialog(bill)}
                          >
                            <HugeiconsIcon icon={Link01Icon} data-icon="inline-start" />
                            Review payment match
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={writesDisabled || status === "Cancelled"}
                            onClick={() => setPendingAction({ kind: "cancel", commitmentId: id })}
                          >
                            <HugeiconsIcon icon={Cancel01Icon} data-icon="inline-start" />
                            Cancel future dates
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Reviewed payments</CardTitle>
          <CardDescription>
            Matching never changes a transaction’s category or amount. Unlink a
            payment to return that due date to expected.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          {matches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reviewed payment matches yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {matches.map((match, index) => {
                const bill = savedBills.find(
                  (row) => text(row.id) === text(match.commitmentId)
                )
                const transaction = state?.transactions.find(
                  (row) => row.id === text(match.transactionId)
                )
                return (
                  <li
                    key={`${text(match.commitmentId)}-${text(match.dueDate)}-${index}`}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {text(bill?.name, "Bill")} · {formatDate(text(match.dueDate))}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {text(transaction?.merchant, "Payment")} · {formatDate(text(transaction?.date))} ·{" "}
                        {formatCents(safeCents(match.observedAmount) ?? safeCents(transaction?.amount))}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={writesDisabled}
                      onClick={() =>
                        setPendingAction({
                          kind: "unlink",
                          commitmentId: text(match.commitmentId),
                          dueDate: text(match.dueDate),
                        })
                      }
                    >
                      <HugeiconsIcon icon={Unlink01Icon} data-icon="inline-start" />
                      Unlink
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a bill</DialogTitle>
            <DialogDescription>
              The first due date sets the recurring day or month. Expected dates are
              plans, not proof that a payment was made.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={(event) => void saveBill(event)}>
            <Field>
              <FieldLabel htmlFor="bill-name">Name</FieldLabel>
              <Input
                id="bill-name"
                value={draft.name}
                maxLength={100}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                disabled={savingBill}
                required
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="bill-amount">Amount (USD)</FieldLabel>
                <Input
                  id="bill-amount"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={draft.amount}
                  onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
                  disabled={savingBill}
                  required
                />
              </Field>
              <Field>
                <FieldLabel>Frequency</FieldLabel>
                <Select
                  items={FREQUENCY_ITEMS}
                  value={draft.frequency}
                  onValueChange={(value) =>
                    setDraft({ ...draft, frequency: value as BillFrequency })
                  }
                  disabled={savingBill}
                >
                  <SelectTrigger className="w-full" aria-label="Bill frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {FREQUENCY_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="bill-start">First due date</FieldLabel>
                <Input
                  id="bill-start"
                  type="date"
                  value={draft.startDate}
                  onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
                  disabled={savingBill}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="bill-end">End date (optional)</FieldLabel>
                <Input
                  id="bill-end"
                  type="date"
                  value={draft.endDate}
                  onChange={(event) => setDraft({ ...draft, endDate: event.target.value })}
                  disabled={savingBill}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>Owner profile</FieldLabel>
              <Select
                items={OWNER_ITEMS}
                value={draft.profileId}
                onValueChange={(value) => setDraft({ ...draft, profileId: value as OwnerId })}
                disabled={savingBill || combinedProfile}
              >
                <SelectTrigger className="w-full" aria-label="Owner profile">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {OWNER_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{combinedNote ?? "Only this profile’s view will list the bill."}</FieldDescription>
            </Field>
            <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              {scheduleCopy(draft.frequency, draft.startDate)}
            </p>
            {addError ? (
              <p role="alert" className="text-sm text-destructive">
                {addError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={writesDisabled}>
                <HugeiconsIcon icon={CheckmarkCircle02Icon} data-icon="inline-start" />
                {savingBill ? "Saving…" : "Save bill"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={matchDraft !== null} onOpenChange={(open) => (open ? undefined : closeMatchDialog())}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Review payment match</DialogTitle>
            <DialogDescription>
              {text(matchBill?.name, "This bill")} · {formatCents(safeCents(matchBill?.amount))}.
              Choose the posted payment that satisfies a scheduled due date.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Due date</FieldLabel>
              <Select
                items={matchDates.map((date) => ({ value: date, label: formatDate(date) }))}
                value={matchDraft?.dueDate ?? ""}
                onValueChange={(value) =>
                  setMatchDraft((current) =>
                    current && value
                      ? { ...current, dueDate: String(value) }
                      : current
                  )
                }
                disabled={savingMatch || matchDates.length === 0}
              >
                <SelectTrigger className="w-full" aria-label="Scheduled due date">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {matchDates.map((date) => (
                      <SelectItem key={date} value={date}>
                        {formatDate(date)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Candidate transactions</p>
              {candidateTransactions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No posted, unmatched USD payments for this amount are available.
                  Add the payment as a transaction first.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {candidateTransactions.map((row) => {
                    const id = text(row.id)
                    const selected = matchDraft?.transactionId === id
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={() =>
                            setMatchDraft((current) =>
                              current ? { ...current, transactionId: id } : current
                            )
                          }
                          disabled={savingMatch}
                          className={cn(
                            "flex w-full min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                            selected && "border-primary bg-muted"
                          )}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {text(row.merchant, "Payment")}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {formatDate(text(row.date))} · {text(row.accountId, "Account")}
                            </span>
                          </span>
                          <span data-numeric className="shrink-0 tabular-nums">
                            {formatCents(safeCents(row.amount))}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <Field orientation="horizontal">
              <Checkbox
                id="match-confirm"
                aria-label="I reviewed and confirm this payment matches the commitment"
                checked={matchDraft?.confirmed ?? false}
                onCheckedChange={(checked) =>
                  setMatchDraft((current) =>
                    current ? { ...current, confirmed: checked === true } : current
                  )
                }
                disabled={savingMatch}
              />
              <FieldLabel htmlFor="match-confirm" className="leading-snug">
                I reviewed and confirm this payment matches the commitment
              </FieldLabel>
            </Field>
            {matchError ? (
              <p role="alert" className="text-sm text-destructive">
                {matchError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeMatchDialog}>
                Back
              </Button>
              <Button
                type="button"
                onClick={() => void saveMatch()}
                disabled={writesDisabled || !matchDraft?.confirmed || !matchDraft.transactionId}
              >
                <HugeiconsIcon icon={Link01Icon} data-icon="inline-start" />
                {savingMatch ? "Saving…" : "Confirm match"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open && !busyAction) setPendingAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction?.kind === "cancel"
                ? "Cancel future dates?"
                : "Unlink this payment?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.kind === "cancel"
                ? `Cancel future dates for ${text(pendingBill?.name, "this bill")}? Past transactions and reviewed matches remain saved.`
                : "Unlink this payment from the bill? The payment stays in your transactions and the due date returns to expected."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction}>Keep as is</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmPendingAction()}
              disabled={writesDisabled}
            >
              {busyAction ? "Working…" : pendingAction?.kind === "cancel" ? "Cancel future dates" : "Unlink payment"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  )
}
