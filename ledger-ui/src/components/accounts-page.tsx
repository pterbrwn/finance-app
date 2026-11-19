import { useEffect, useMemo, useState, type FormEvent } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  Archive01Icon,
  BankIcon,
  CheckmarkCircle02Icon,
  Link01Icon,
  PlusSignIcon,
  RefreshIcon,
  Undo02Icon,
  Unlink01Icon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons"

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
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { api } from "@/lib/api"
import { useLedger } from "@/context/ledger-context"
import { useHealth, useSyncStatus } from "@/hooks/use-ledger-resource"
import {
  asArray,
  asRecord,
  formatCents,
  formatDate,
  formatDollarsInput,
  parseDollarsToCents,
  PROFILE_OPTIONS,
  type LedgerRecord,
} from "@/lib/ledger"

type OwnerId = "peter" | "maddie" | "joint"
type ProfileTarget = OwnerId | ""
type AccountType =
  | "depository"
  | "credit"
  | "investment"
  | "retirement"
  | "hsa"
  | "asset"
  | "liability"
  | "other"

type ManualDraft = {
  name: string
  type: AccountType
  institution: string
  subtype: string
  balance: string
  asOf: string
  profileId: ProfileTarget
  includeInReporting: boolean
  notes: string
}

type DestructiveAction =
  | { kind: "archive" | "restore"; accountId: string; name: string; manual: boolean }
  | { kind: "disconnect"; itemId: string; name: string }
  | { kind: "delete-history"; itemId: string; name: string }
  | { kind: "undo-ownership"; batchId: string; name: string }

type OwnershipState = {
  accountId: string
  target: ProfileTarget
  preview: LedgerRecord | null
  loading: boolean
  error: string | null
  confirmed: boolean
}

const ACCOUNT_TYPE_ITEMS: ReadonlyArray<{ value: AccountType; label: string }> = [
  { value: "depository", label: "Checking / savings" },
  { value: "credit", label: "Credit card" },
  { value: "investment", label: "Investment" },
  { value: "retirement", label: "Retirement" },
  { value: "hsa", label: "HSA" },
  { value: "asset", label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "other", label: "Other" },
]

const PROFILE_ITEMS: ReadonlyArray<{ value: ProfileTarget; label: string }> = [
  { value: "", label: "Needs ownership review" },
  ...PROFILE_OPTIONS.filter((option) => option.value !== "combined").map((option) => ({
    value: option.value as ProfileTarget,
    label: option.label,
  })),
]

const PRODUCT_ITEMS: ReadonlyArray<{ value: "transactions" | "investments"; label: string }> = [
  { value: "transactions", label: "Bank / credit" },
  { value: "investments", label: "Investments / retirement / HSA" },
]

const SYNC_LABELS: Record<string, string> = {
  running: "Running",
  succeeded: "Succeeded",
  partial: "Partial",
  failed: "Failed",
  interrupted: "Interrupted",
  skipped: "Skipped",
}

const FRESHNESS_LABELS: Record<string, string> = {
  current: "Current",
  stale: "Stale",
  "needs-attention": "Needs attention",
  "manual-only": "Manual only",
  "no-connected-accounts": "No connected accounts",
}

type PlaidHandler = { open: () => void; destroy: () => void }
type PlaidSdk = {
  create: (options: {
    token: string
    onSuccess: (
      publicToken: string,
      metadata: { institution?: { name?: string } }
    ) => void
    onExit: (error: unknown) => void
  }) => PlaidHandler
}

let plaidPromise: Promise<PlaidSdk> | null = null

function loadPlaidSdk(): Promise<PlaidSdk> {
  if (plaidPromise) return plaidPromise
  plaidPromise = new Promise<PlaidSdk>((resolve, reject) => {
    const existing = (window as Window & { Plaid?: PlaidSdk }).Plaid
    if (existing) {
      resolve(existing)
      return
    }
    const script = document.createElement("script")
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js"
    script.onload = () => {
      const sdk = (window as Window & { Plaid?: PlaidSdk }).Plaid
      if (sdk) resolve(sdk)
      else {
        plaidPromise = null
        reject(new Error("Bank sign-in could not start. Please try again."))
      }
    }
    script.onerror = () => {
      plaidPromise = null
      reject(new Error("Could not load bank sign-in. Check the connection and try again."))
    }
    document.head.append(script)
  })
  return plaidPromise
}

function todayString() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

function safeCents(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}

function text(value: unknown, fallback = "—") {
  return typeof value === "string" && value.trim() ? value : fallback
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : text(value, "0")
}

function ownerLabel(value: unknown) {
  const id = typeof value === "string" ? value : ""
  return PROFILE_OPTIONS.find((option) => option.value === id)?.label ?? "Needs ownership review"
}

function typeLabel(value: unknown) {
  return ACCOUNT_TYPE_ITEMS.find((item) => item.value === value)?.label ?? text(value, "Account")
}

function errorsFrom(value: unknown) {
  return asArray<LedgerRecord>(value)
    .map((row) => text(row.message))
    .filter((message) => message !== "—")
}

function emptyManualDraft(): ManualDraft {
  return {
    name: "",
    type: "depository",
    institution: "",
    subtype: "",
    balance: "",
    asOf: "",
    profileId: "",
    includeInReporting: true,
    notes: "",
  }
}

export function AccountsPage() {
  const { state, preview, write } = useLedger()
  const syncStatus = useSyncStatus()
  const health = useHealth()

  const accounts = asArray<LedgerRecord & { id: string }>(state?.accounts)
  const items = asArray<LedgerRecord & { id: string }>(state?.items)
  const setup = asRecord(state?.setup)
  const healthData = asRecord(health.data)
  const syncJob = asRecord(asRecord(syncStatus.data).job)

  const [manualOpen, setManualOpen] = useState(false)
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [manualDraft, setManualDraft] = useState<ManualDraft>(emptyManualDraft)
  const [manualError, setManualError] = useState<string | null>(null)
  const [savingManual, setSavingManual] = useState(false)

  const [destructive, setDestructive] = useState<DestructiveAction | null>(null)
  const [busyAction, setBusyAction] = useState(false)
  const [bankProduct, setBankProduct] = useState<"transactions" | "investments">("transactions")
  const [connecting, setConnecting] = useState(false)

  const [ownership, setOwnership] = useState<OwnershipState | null>(null)
  const [applyingOwnership, setApplyingOwnership] = useState(false)
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), 0)
    return () => window.clearTimeout(timer)
  }, [state?.revision, syncStatus.data])

  const connectedItems = useMemo(
    () => items.filter((item) => text(item.lifecycle, "connected") !== "unlinked"),
    [items]
  )
  const erroredItems = connectedItems.filter((item) => !!item.error)
  const staleItems =
    now === null
      ? []
      : connectedItems.filter((item) => {
          const stamp = Date.parse(text(item.lastSync, ""))
          return !Number.isFinite(stamp) || now - stamp > 86_400_000
        })
  const freshness =
    connectedItems.length === 0
      ? accounts.some((account) => account.manual === true)
        ? "manual-only"
        : "no-connected-accounts"
      : erroredItems.length > 0
        ? "needs-attention"
        : staleItems.length > 0
          ? "stale"
          : "current"

  const bankDisabled =
    preview || healthData.configurationReady !== true || setup.localOnly === true
  const writesDisabled = preview || busyAction || connecting || savingManual || applyingOwnership

  const itemFor = (account: LedgerRecord) =>
    items.find((item) => item.id === text(account.itemId))

  const accountStatus = (account: LedgerRecord) => {
    if (account.manual === true) return "Manual"
    const item = itemFor(account)
    if (!item || text(item.lifecycle, "connected") === "unlinked") return "Unlinked"
    if (item.error) return "Connected · Needs sync"
    if (item.lastSync) return "Connected · Current"
    return "Connected · Initial sync pending"
  }

  const statusVariant = (status: string) =>
    status === "Connected · Current" || status === "Manual"
      ? "secondary"
      : status === "Unlinked" || status === "Connected · Needs sync"
        ? "destructive"
        : "outline"

  const openManual = (account?: LedgerRecord & { id: string }) => {
    setManualError(null)
    setEditingAccountId(account?.id ?? null)
    if (!account) {
      setManualDraft(emptyManualDraft())
    } else {
      const type = ACCOUNT_TYPE_ITEMS.some((item) => item.value === account.type)
        ? (account.type as AccountType)
        : "other"
      setManualDraft({
        name: text(account.name, ""),
        type,
        institution: text(account.institution, ""),
        subtype: text(account.subtype, ""),
        balance:
          safeCents(account.balance) === null
            ? ""
            : formatDollarsInput(safeCents(account.balance)),
        asOf: text(account.balanceAsOf, ""),
        profileId:
          account.profileId === "peter" ||
          account.profileId === "maddie" ||
          account.profileId === "joint"
            ? account.profileId
            : "",
        includeInReporting: account.includeInReporting !== false,
        notes: text(account.notes, ""),
      })
    }
    setManualOpen(true)
  }

  const saveManual = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (writesDisabled) return
    const balance = parseDollarsToCents(manualDraft.balance)
    if (!manualDraft.name.trim()) {
      setManualError("Enter a name for this account.")
      return
    }
    if (manualDraft.balance.trim() && balance === null) {
      setManualError("Enter the balance in dollars, for example 1250.00 or -85.50.")
      return
    }
    if (balance !== null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(manualDraft.asOf)) {
        setManualError("A balance needs its balance date.")
        return
      }
      if (manualDraft.asOf > todayString()) {
        setManualError("The balance date cannot be in the future.")
        return
      }
    }
    setSavingManual(true)
    setManualError(null)
    try {
      const result = await write<{ ownershipBatchId?: string | null }>("manual-account", {
        ...(editingAccountId ? { id: editingAccountId } : {}),
        name: manualDraft.name.trim(),
        type: manualDraft.type,
        institution: manualDraft.institution,
        subtype: manualDraft.subtype,
        balance,
        asOf: manualDraft.asOf,
        currency: "USD",
        profileId: manualDraft.profileId,
        includeInReporting: manualDraft.includeInReporting,
        notes: manualDraft.notes,
        revision: state?.revision ?? 0,
      })
      toast.add({
        type: "success",
        title: editingAccountId ? "Account updated" : "Manual account added",
        description: result.ownershipBatchId
          ? "The ownership change can be undone from the ownership history below."
          : "The balance is an observation as of the date you entered.",
      })
      setManualOpen(false)
      setManualDraft(emptyManualDraft())
      setEditingAccountId(null)
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "The account could not be saved."
      setManualError(message)
      toast.add({ type: "error", title: "Account not saved", description: message })
    } finally {
      setSavingManual(false)
    }
  }

  const runAccountAction = async (
    account: LedgerRecord & { id: string },
    action: "archive" | "restore" | "include",
    value?: boolean
  ) => {
    const path = account.manual === true ? "manual-account" : "account-update"
    await write(path, {
      id: account.id,
      action,
      ...(action === "include" ? { value: value === true } : {}),
      revision: state?.revision ?? 0,
    })
    toast.add({
      type: "success",
      title:
        action === "include"
          ? value === true
            ? "Included in reports"
            : "Excluded from reports"
          : action === "archive"
            ? "Account archived"
            : "Account restored",
      description: text(account.name, "Account"),
    })
  }

  const confirmDestructive = async () => {
    const action = destructive
    if (!action || busyAction || writesDisabled) return
    setBusyAction(true)
    try {
      switch (action.kind) {
        case "archive":
        case "restore": {
          const account = accounts.find((row) => row.id === action.accountId)
          if (!account) throw new Error("Account not found. Refresh and try again.")
          await runAccountAction(account, action.kind)
          break
        }
        case "disconnect": {
          await write("disconnect", {
            itemId: action.itemId,
            revision: state?.revision ?? 0,
          })
          await syncStatus.refresh()
          toast.add({
            type: "success",
            title: "Provider access removed",
            description:
              "Provider access was removed. Imported account and transaction history remains saved.",
          })
          break
        }
        case "delete-history": {
          await write("delete-history", {
            itemId: action.itemId,
            revision: state?.revision ?? 0,
          })
          await syncStatus.refresh()
          toast.add({
            type: "success",
            title: "Provider history deleted",
            description: "Saved provider data was removed from this device.",
          })
          break
        }
        case "undo-ownership": {
          await write("account-ownership-undo", {
            batchId: action.batchId,
            revision: state?.revision ?? 0,
          })
          toast.add({
            type: "success",
            title: "Ownership restored",
            description: "The account and its linked records returned to the prior owner.",
          })
          break
        }
      }
      setDestructive(null)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The change could not be saved."
      toast.add({ type: "error", title: "Change not saved", description: message })
    } finally {
      setBusyAction(false)
    }
  }

  const startSync = async () => {
    const result = await write<{ job?: LedgerRecord }>("sync", {
      revision: state?.revision ?? 0,
    })
    await syncStatus.refresh()
    const status = text(asRecord(result.job).status, "running")
    toast.add({
      type: "success",
      title: "Bank update started",
      description:
        status === "running"
          ? "The update is running. Its result will appear below."
          : `Update status: ${SYNC_LABELS[status] ?? status}.`,
    })
  }

  const runSync = async () => {
    if (bankDisabled || connecting) return
    setConnecting(true)
    try {
      await startSync()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The update could not start."
      toast.add({ type: "error", title: "Bank update failed", description: message })
    } finally {
      setConnecting(false)
    }
  }

  const connect = async (mode: "new" | "update", product: "transactions" | "investments", itemId?: string) => {
    if (bankDisabled || connecting) return
    setConnecting(true)
    try {
      const token = await write<{ link_token: string; environment?: string }>(
        "link-token",
        {
          ...(mode === "update" && itemId ? { itemId } : {}),
          product,
          revision: state?.revision ?? 0,
        }
      )
      const sdk = await loadPlaidSdk()
      await new Promise<void>((resolve) => {
        let handler: PlaidHandler | null = null
        handler = sdk.create({
          token: token.link_token,
          onSuccess: (publicToken, metadata) => {
            void (async () => {
              try {
                if (mode === "update") {
                  await startSync()
                } else {
                  await write("exchange-token", {
                    public_token: publicToken,
                    name: text(metadata.institution?.name, "Connected account"),
                    product,
                    environment: token.environment,
                    revision: state?.revision ?? 0,
                  })
                  await syncStatus.refresh()
                  toast.add({
                    type: "success",
                    title: "Bank connected",
                    description: "The first account update is now running.",
                  })
                }
              } catch (caught) {
                const message =
                  caught instanceof Error ? caught.message : "The connection could not be saved."
                toast.add({ type: "error", title: "Bank connection failed", description: message })
              } finally {
                handler?.destroy()
                resolve()
              }
            })()
          },
          onExit: (error) => {
            if (error) {
              toast.add({
                type: "error",
                title: "Bank sign-in not completed",
                description: "No connection was saved. You can try again.",
              })
            }
            handler?.destroy()
            resolve()
          },
        })
        handler.open()
      })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Bank sign-in could not start."
      toast.add({ type: "error", title: "Bank connection failed", description: message })
    } finally {
      setConnecting(false)
    }
  }

  const openOwnership = (account: LedgerRecord & { id: string }) => {
    setOwnership({
      accountId: account.id,
      target:
        account.profileId === "peter" ||
        account.profileId === "maddie" ||
        account.profileId === "joint"
          ? account.profileId
          : "",
      preview: null,
      loading: false,
      error: null,
      confirmed: false,
    })
  }

  const previewOwnership = async () => {
    if (!ownership || writesDisabled) return
    setOwnership({ ...ownership, loading: true, error: null, preview: null, confirmed: false })
    try {
      const params = new URLSearchParams({ id: ownership.accountId })
      if (ownership.target) params.set("target", ownership.target)
      const result = await api<LedgerRecord>(
        `account-ownership-preview?${params.toString()}`
      )
      setOwnership((current) =>
        current ? { ...current, loading: false, preview: result } : current
      )
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "The ownership preview could not load."
      setOwnership((current) =>
        current ? { ...current, loading: false, error: message } : current
      )
    }
  }

  const applyOwnership = async () => {
    if (!ownership?.preview || applyingOwnership || writesDisabled) return
    const blockers = asArray<LedgerRecord>(ownership.preview.blockers)
    const dependencies = asArray<LedgerRecord>(ownership.preview.dependencies)
    if (blockers.length > 0 || !ownership.confirmed) return
    const account = accounts.find((row) => row.id === ownership.accountId)
    if (!account) return
    setApplyingOwnership(true)
    try {
      if (account.manual === true) {
        const type = ACCOUNT_TYPE_ITEMS.some((item) => item.value === account.type)
          ? (account.type as AccountType)
          : "other"
        await write("manual-account", {
          id: account.id,
          name: text(account.name),
          type,
          institution: text(account.institution, ""),
          subtype: text(account.subtype, ""),
          balance: safeCents(account.balance),
          asOf: text(account.balanceAsOf, ""),
          currency: text(account.currency, "USD"),
          profileId: ownership.target,
          includeInReporting: account.includeInReporting !== false,
          notes: text(account.notes, ""),
          reassignDependencies: dependencies.length > 0,
          revision: state?.revision ?? 0,
        })
      } else {
        await write("account-update", {
          id: account.id,
          action: "ownership",
          profileId: ownership.target || null,
          reassignDependencies: dependencies.length > 0,
          revision: state?.revision ?? 0,
        })
      }
      toast.add({
        type: "success",
        title: "Account ownership updated",
        description: "The balance is still counted once in the combined view.",
      })
      setOwnership(null)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Ownership could not be changed."
      setOwnership((current) => (current ? { ...current, error: message } : current))
      toast.add({ type: "error", title: "Ownership not changed", description: message })
    } finally {
      setApplyingOwnership(false)
    }
  }

  const ownershipAccount = ownership
    ? accounts.find((row) => row.id === ownership.accountId)
    : undefined
  const ownershipBlockers = ownership?.preview
    ? asArray<LedgerRecord>(ownership.preview.blockers)
    : []
  const ownershipDependencies = ownership?.preview
    ? asArray<LedgerRecord>(ownership.preview.dependencies)
    : []
  const pendingUndoBatches = asArray<LedgerRecord>(state?.accountOwnershipBatches).filter(
    (row) => !row.undoneAt
  )
  const jobFailures = errorsFrom(syncJob.failures)

  return (
    <PageShell
      title="Accounts"
      description="Connect banks or record accounts you manage manually."
      actions={
        <Button
          type="button"
          onClick={() => openManual()}
          disabled={writesDisabled}
        >
          <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
          Add account
        </Button>
      }
    >
      {preview ? (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Preview mode</AlertTitle>
          <AlertDescription>
            Account actions are read-only here. Switch out of the synthetic preview
            to connect, edit, or archive accounts.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Three different kinds of money</CardTitle>
          <CardDescription>
            These roles must never be added together as if they were one spendable
            balance.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div className="flex flex-col gap-1 rounded-lg border px-3 py-2">
            <p className="text-sm font-medium">Cash</p>
            <p className="text-sm text-muted-foreground">
              Money you can spend now. A balance is an observation as of its date,
              not a live bank balance.
            </p>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border px-3 py-2">
            <p className="text-sm font-medium">Allowance / budget</p>
            <p className="text-sm text-muted-foreground">
              A planned spending envelope. It is a plan, not money sitting in an
              account.
            </p>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border px-3 py-2">
            <p className="text-sm font-medium">Goal money</p>
            <p className="text-sm text-muted-foreground">
              Cash reserved to goals in a plan, not a transfer. The cash stays in
              the same account.
            </p>
          </div>
          <Alert className="md:col-span-3">
            <HugeiconsIcon icon={Wallet01Icon} />
            <AlertTitle>Which cash can back a goal</AlertTitle>
            <AlertDescription>
              Goal backing uses only fresh, included USD cash accounts.
              Investments, retirement, HSA, credit, archived, and stale accounts
              are ineligible.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {health.error ? (
        <Alert variant="destructive" role="alert">
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Connection status could not load</AlertTitle>
          <AlertDescription>
            {health.error} Bank actions stay disabled until this status is known.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Your accounts</CardTitle>
          <CardDescription>
            Each account stays a separate record, including accounts from the same
            provider. No access tokens or secrets are shown here.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 px-0 pb-0">
          {accounts.length === 0 ? (
            <p className="px-(--card-spacing) pb-(--card-spacing) text-sm text-muted-foreground">
              No accounts recorded yet. Add a manual account or connect a provider
              below.
            </p>
          ) : (
            <Table>
              <TableHeader className="hidden lg:table-header-group">
                <TableRow>
                  <TableHead scope="col">Account</TableHead>
                  <TableHead scope="col">Type</TableHead>
                  <TableHead scope="col">Owner</TableHead>
                  <TableHead scope="col" className="text-right">
                    Balance
                  </TableHead>
                  <TableHead scope="col">Balance date</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => {
                  const status = accountStatus(account)
                  const reportable = account.includeInReporting !== false
                  return (
                    <TableRow
                      key={account.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 p-3 lg:table-row lg:p-0"
                    >
                      <TableCell className="order-1 min-w-0 p-0 font-medium lg:order-none lg:p-3">
                        <span className="block truncate">
                          {text(account.name, "Account")}
                          {text(account.mask, "") !== "—"
                            ? ` ····${text(account.mask)}`
                            : ""}
                        </span>
                        <span className="block text-xs font-normal text-muted-foreground">
                          {text(account.institution, typeLabel(account.type))}
                          {account.archivedAt ? " · Archived" : ""}
                        </span>
                      </TableCell>
                      <TableCell
                        data-numeric
                        className="order-2 p-0 text-right tabular-nums lg:order-none lg:p-3"
                      >
                        {formatCents(safeCents(account.balance))}
                      </TableCell>
                      <TableCell className="order-3 p-0 text-xs text-muted-foreground lg:order-none lg:p-3">
                        {typeLabel(account.type)}
                        {text(account.subtype, "") !== "—" ? ` · ${text(account.subtype)}` : ""}
                      </TableCell>
                      <TableCell className="order-4 p-0 text-xs text-muted-foreground lg:order-none lg:p-3">
                        {ownerLabel(account.profileId)}
                      </TableCell>
                      <TableCell className="order-5 p-0 text-xs text-muted-foreground lg:order-none lg:p-3">
                        {formatDate(text(account.balanceAsOf))}
                      </TableCell>
                      <TableCell className="order-6 p-0 lg:order-none lg:p-3">
                        <Badge variant={statusVariant(status)}>{status}</Badge>
                      </TableCell>
                      <TableCell className="order-7 col-span-2 p-0 lg:order-none lg:col-span-1 lg:p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {account.manual === true ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={writesDisabled}
                              onClick={() => openManual(account)}
                            >
                              <HugeiconsIcon icon={Wallet01Icon} data-icon="inline-start" />
                              Edit
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={writesDisabled}
                            onClick={() => openOwnership(account)}
                          >
                            <HugeiconsIcon icon={Undo02Icon} data-icon="inline-start" />
                            Change owner
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={writesDisabled}
                            onClick={() => {
                              const action = account.manual === true ? "manual-account" : "account-update"
                              void write(action, {
                                id: account.id,
                                action: "include",
                                value: !reportable,
                                revision: state?.revision ?? 0,
                              })
                                .then(() =>
                                  toast.add({
                                    type: "success",
                                    title: reportable
                                      ? "Excluded from reports"
                                      : "Included in reports",
                                    description: text(account.name, "Account"),
                                  })
                                )
                                .catch((caught: unknown) =>
                                  toast.add({
                                    type: "error",
                                    title: "Change not saved",
                                    description:
                                      caught instanceof Error
                                        ? caught.message
                                        : "The reporting setting could not be changed.",
                                  })
                                )
                            }}
                          >
                            {reportable ? "Exclude" : "Include"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={writesDisabled}
                            onClick={() =>
                              setDestructive({
                                kind: account.archivedAt ? "restore" : "archive",
                                accountId: account.id,
                                name: text(account.name, "Account"),
                                manual: account.manual === true,
                              })
                            }
                          >
                            <HugeiconsIcon icon={Archive01Icon} data-icon="inline-start" />
                            {account.archivedAt ? "Restore" : "Archive"}
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
          <CardTitle>Bank connections</CardTitle>
          <CardDescription>
            Data freshness: <strong>{FRESHNESS_LABELS[freshness] ?? freshness}</strong>. A
            schedule is never evidence that an update succeeded.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {bankDisabled ? (
            <Alert>
              <HugeiconsIcon icon={Alert02Icon} />
              <AlertTitle>Bank connections are disabled</AlertTitle>
              <AlertDescription>
                Bank connections are disabled. Import CSV files for local-only
                operation.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <Field className="min-w-52 flex-1">
                <FieldLabel>Connection type</FieldLabel>
                <Select
                  items={PRODUCT_ITEMS}
                  value={bankProduct}
                  onValueChange={(value) =>
                    setBankProduct(value as "transactions" | "investments")
                  }
                  disabled={connecting}
                >
                  <SelectTrigger className="w-full" aria-label="Connection type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {PRODUCT_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Button
                type="button"
                disabled={writesDisabled || bankDisabled}
                onClick={() => void connect("new", bankProduct)}
              >
                <HugeiconsIcon icon={Link01Icon} data-icon="inline-start" />
                {connecting ? "Working…" : "Connect bank"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={writesDisabled || bankDisabled}
                onClick={() => void runSync()}
              >
                <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" />
                Update accounts
              </Button>
            </div>
          )}

          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No connected providers yet. Manual accounts and CSV imports work
              without a provider.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map((item) => {
                const unlinked = text(item.lifecycle, "connected") === "unlinked"
                const status = unlinked
                  ? "Unlinked"
                  : item.error
                    ? "Connected · Needs sync"
                    : item.lastSync
                      ? "Connected · Current"
                      : "Connected · Initial sync pending"
                return (
                  <li
                    key={item.id}
                    className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg border px-3 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <HugeiconsIcon icon={BankIcon} />
                        <p className="font-medium">{text(item.name, "Connected provider")}</p>
                        <Badge variant={statusVariant(status)}>{status}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.product === "investments"
                          ? "Investment connection"
                          : "Bank and credit connection"}
                        {" · "}
                        {item.lastSync
                          ? `Last successful sync: ${formatDate(text(item.lastSync))}`
                          : "Waiting for the first successful sync."}
                      </p>
                      {item.error ? (
                        <Alert variant="destructive" role="alert" className="mt-2">
                          <HugeiconsIcon icon={Alert02Icon} />
                          <AlertTitle>Provider error</AlertTitle>
                          <AlertDescription>{text(item.error)}</AlertDescription>
                        </Alert>
                      ) : null}
                      {unlinked ? (
                        <p className="mt-2 text-sm text-muted-foreground">
                          Provider access was removed. Imported account and
                          transaction history remains saved.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {!unlinked ? (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={writesDisabled || bankDisabled}
                            onClick={() =>
                              void connect(
                                "update",
                                item.product === "investments" ? "investments" : "transactions",
                                item.id
                              )
                            }
                          >
                            <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" />
                            Update access
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={writesDisabled || bankDisabled}
                            onClick={() =>
                              setDestructive({
                                kind: "disconnect",
                                itemId: item.id,
                                name: text(item.name, "provider"),
                              })
                            }
                          >
                            <HugeiconsIcon icon={Unlink01Icon} data-icon="inline-start" />
                            Disconnect
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={writesDisabled}
                          onClick={() =>
                            setDestructive({
                              kind: "delete-history",
                              itemId: item.id,
                              name: text(item.name, "provider"),
                            })
                          }
                        >
                          <HugeiconsIcon icon={Unlink01Icon} data-icon="inline-start" />
                          Delete provider history
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="rounded-lg border px-3 py-2">
            <p className="text-sm font-medium">Latest bank update</p>
            <p className="text-sm text-muted-foreground">
              {syncStatus.loading
                ? "Loading update status…"
                : Object.keys(syncJob).length === 0
                  ? "No bank update has been recorded."
                  : `${SYNC_LABELS[text(syncJob.status)] ?? text(syncJob.status)} · ${count(syncJob.completed)} of ${count(syncJob.total)} completed · started ${formatDate(text(syncJob.startedAt))}`}
            </p>
            {jobFailures.length > 0 ? (
              <Alert variant="destructive" role="alert" className="mt-2">
                <HugeiconsIcon icon={Alert02Icon} />
                <AlertTitle>Update failures</AlertTitle>
                <AlertDescription>
                  <ul className="flex list-disc flex-col gap-1 pl-4">
                    {jobFailures.map((message, index) => (
                      <li key={`${message}-${index}`}>{message}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            {syncStatus.error ? (
              <Alert variant="destructive" role="alert" className="mt-2">
                <HugeiconsIcon icon={Alert02Icon} />
                <AlertTitle>Update status unavailable</AlertTitle>
                <AlertDescription>{syncStatus.error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {pendingUndoBatches.length > 0 ? (
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Recent ownership changes</CardTitle>
            <CardDescription>
              Undo is available only until this account or its linked records
              change.
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0">
            <ul className="flex flex-col gap-3">
              {pendingUndoBatches.map((batch, index) => {
                const account = accounts.find((row) => row.id === text(batch.accountId))
                return (
                  <li
                    key={`${text(batch.id)}-${index}`}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
                  >
                    <span className="text-sm">
                      <strong>{text(account?.name, "Account")}</strong>
                      {" · "}
                      {ownerLabel(batch.before)} → {ownerLabel(batch.after)}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={writesDisabled}
                      onClick={() =>
                        setDestructive({
                          kind: "undo-ownership",
                          batchId: text(batch.id),
                          name: text(account?.name, "Account"),
                        })
                      }
                    >
                      <HugeiconsIcon icon={Undo02Icon} data-icon="inline-start" />
                      Undo ownership change
                    </Button>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingAccountId ? "Edit manual account" : "Add a manual account"}</DialogTitle>
            <DialogDescription>
              Record a balance you observed yourself. A balance without a date is
              not treated as current.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={(event) => void saveManual(event)}>
            <Field>
              <FieldLabel htmlFor="manual-name">Name</FieldLabel>
              <Input
                id="manual-name"
                value={manualDraft.name}
                maxLength={100}
                onChange={(event) => setManualDraft({ ...manualDraft, name: event.target.value })}
                disabled={savingManual}
                required
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Type</FieldLabel>
                <Select
                  items={ACCOUNT_TYPE_ITEMS}
                  value={manualDraft.type}
                  onValueChange={(value) =>
                    setManualDraft({ ...manualDraft, type: value as AccountType })
                  }
                  disabled={savingManual}
                >
                  <SelectTrigger className="w-full" aria-label="Account type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {ACCOUNT_TYPE_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="manual-institution">Institution</FieldLabel>
                <Input
                  id="manual-institution"
                  value={manualDraft.institution}
                  maxLength={100}
                  onChange={(event) =>
                    setManualDraft({ ...manualDraft, institution: event.target.value })
                  }
                  disabled={savingManual}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="manual-subtype">Subtype</FieldLabel>
                <Input
                  id="manual-subtype"
                  value={manualDraft.subtype}
                  maxLength={60}
                  onChange={(event) =>
                    setManualDraft({ ...manualDraft, subtype: event.target.value })
                  }
                  disabled={savingManual}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="manual-balance">Balance (USD)</FieldLabel>
                <Input
                  id="manual-balance"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={manualDraft.balance}
                  onChange={(event) =>
                    setManualDraft({ ...manualDraft, balance: event.target.value })
                  }
                  disabled={savingManual}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="manual-as-of">Balance date</FieldLabel>
                <Input
                  id="manual-as-of"
                  type="date"
                  value={manualDraft.asOf}
                  onChange={(event) =>
                    setManualDraft({ ...manualDraft, asOf: event.target.value })
                  }
                  disabled={savingManual}
                />
                <FieldDescription>Required when a balance is entered.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Currency</FieldLabel>
                <Input value="USD" readOnly disabled aria-label="Currency USD" />
              </Field>
            </div>
            <Field>
              <FieldLabel>Owner profile</FieldLabel>
              <Select
                items={PROFILE_ITEMS}
                value={manualDraft.profileId}
                onValueChange={(value) =>
                  setManualDraft({ ...manualDraft, profileId: value as ProfileTarget })
                }
                disabled={savingManual}
              >
                <SelectTrigger className="w-full" aria-label="Owner profile">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {PROFILE_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="manual-reporting"
                aria-label="Include this account in reporting"
                checked={manualDraft.includeInReporting}
                onCheckedChange={(checked) =>
                  setManualDraft({ ...manualDraft, includeInReporting: checked === true })
                }
                disabled={savingManual}
              />
              <FieldLabel htmlFor="manual-reporting" className="leading-snug">
                Include this account in reporting
              </FieldLabel>
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-notes">Notes</FieldLabel>
              <Textarea
                id="manual-notes"
                value={manualDraft.notes}
                maxLength={500}
                onChange={(event) =>
                  setManualDraft({ ...manualDraft, notes: event.target.value })
                }
                disabled={savingManual}
              />
            </Field>
            {manualError ? (
              <p role="alert" className="text-sm text-destructive">
                {manualError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setManualOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={writesDisabled}>
                <HugeiconsIcon icon={CheckmarkCircle02Icon} data-icon="inline-start" />
                {savingManual ? "Saving…" : "Save account"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={ownership !== null} onOpenChange={(open) => (!open ? setOwnership(null) : undefined)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Change account owner</DialogTitle>
            <DialogDescription>
              {text(ownershipAccount?.name, "Account")} · the balance remains
              counted once in the combined view. Review linked records before you
              confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel>New owner</FieldLabel>
              <Select
                items={PROFILE_ITEMS}
                value={ownership?.target ?? ""}
                onValueChange={(value) =>
                  setOwnership((current) =>
                    current
                      ? {
                          ...current,
                          target: value as ProfileTarget,
                          preview: null,
                          confirmed: false,
                        }
                      : current
                  )
                }
                disabled={applyingOwnership}
              >
                <SelectTrigger className="w-full" aria-label="New owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {PROFILE_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Button
              type="button"
              variant="outline"
              disabled={writesDisabled || ownership?.loading}
              onClick={() => void previewOwnership()}
            >
              <HugeiconsIcon icon={Wallet01Icon} data-icon="inline-start" />
              {ownership?.loading ? "Checking…" : "Preview ownership changes"}
            </Button>
            {ownership?.error ? (
              <Alert variant="destructive" role="alert">
                <HugeiconsIcon icon={Alert02Icon} />
                <AlertTitle>Ownership preview failed</AlertTitle>
                <AlertDescription>{ownership.error}</AlertDescription>
              </Alert>
            ) : null}
            {ownership?.preview ? (
              <div className="flex flex-col gap-3 rounded-lg border px-3 py-2 text-sm">
                <p>
                  {count(ownership.preview.inheritedTransactions)} transaction(s)
                  and {count(ownership.preview.inheritedHoldings)} holding(s) will
                  follow this account.
                </p>
                <p className="text-muted-foreground">
                  {count(ownership.preview.overriddenTransactions)} transaction
                  override(s) and {count(ownership.preview.overriddenHoldings)}{" "}
                  holding override(s) stay unchanged.
                </p>
                {ownershipBlockers.length > 0 ? (
                  <Alert variant="destructive" role="alert">
                    <HugeiconsIcon icon={Alert02Icon} />
                    <AlertTitle>Resolve these blockers first</AlertTitle>
                    <AlertDescription>
                      <ul className="flex list-disc flex-col gap-1 pl-4">
                        {ownershipBlockers.map((blocker, index) => (
                          <li key={`${index}-${text(blocker)}`}>{text(blocker)}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {ownershipDependencies.length > 0 ? (
                  <div>
                    <p className="font-medium">Linked records that will move</p>
                    <ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
                      {ownershipDependencies.map((dependency, index) => (
                        <li key={`${index}-${text(dependency.name ?? dependency.id)}`}>
                          {text(dependency.name ?? dependency.id, "Linked record")}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    No linked records need reassignment.
                  </p>
                )}
                <Field orientation="horizontal">
                  <Checkbox
                    id="ownership-confirm"
                    aria-label="I confirm this ownership change and the listed dependency updates"
                    checked={ownership.confirmed}
                    onCheckedChange={(checked) =>
                      setOwnership((current) =>
                        current ? { ...current, confirmed: checked === true } : current
                      )
                    }
                    disabled={applyingOwnership || ownershipBlockers.length > 0}
                  />
                  <FieldLabel htmlFor="ownership-confirm" className="leading-snug">
                    I confirm this ownership change and the listed dependency updates
                  </FieldLabel>
                </Field>
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOwnership(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={
                  writesDisabled ||
                  !ownership?.preview ||
                  !ownership.confirmed ||
                  ownershipBlockers.length > 0
                }
                onClick={() => void applyOwnership()}
              >
                <HugeiconsIcon icon={CheckmarkCircle02Icon} data-icon="inline-start" />
                {applyingOwnership ? "Saving…" : "Apply ownership change"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={destructive !== null}
        onOpenChange={(open) => {
          if (!open && !busyAction) setDestructive(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {destructive?.kind === "disconnect"
                ? "Disconnect this provider?"
                : destructive?.kind === "delete-history"
                  ? "Delete provider history?"
                  : destructive?.kind === "undo-ownership"
                    ? "Undo this ownership change?"
                    : destructive?.kind === "archive"
                      ? "Archive this account?"
                      : "Restore this account?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {destructive?.kind === "disconnect"
                ? "Provider access was removed. Imported account and transaction history remains saved."
                : destructive?.kind === "delete-history"
                  ? `Permanently delete saved history for ${text(destructive.name, "this provider")}? This removes the connection, its accounts, transactions, and holdings from this device. This cannot be undone.`
                  : destructive?.kind === "undo-ownership"
                    ? `Undo the ownership change for ${text(destructive.name, "this account")}? It is only restored if the account and its linked records have not changed.`
                    : destructive?.kind === "archive"
                      ? `Archive ${text(destructive?.name, "this account")}? Its records remain saved.`
                      : `Restore ${text(destructive?.name, "this account")}? It will appear as active again.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction}>Keep as is</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={writesDisabled}
              onClick={() => void confirmDestructive()}
            >
              {busyAction ? "Working…" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  )
}
