import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  ArrowRight01Icon,
  BankIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Database01Icon,
  Delete02Icon,
  InformationCircleIcon,
  ReceiptTextIcon,
  RefreshIcon,
  Shield01Icon,
  Unlink01Icon,
} from "@hugeicons/core-free-icons"
import { cn } from "cn"
import { useEffect, useMemo, useState } from "react"

import { PageShell } from "@/components/page-shell"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
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
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { toast } from "@/components/ui/toast"
import { useLedger } from "@/context/ledger-context"
import { useHealth, useSyncStatus } from "@/hooks/use-ledger-resource"
import { clearAllPendingOperations, pendingOperationCount } from "@/lib/api"
import {
  asArray,
  asRecord,
  type LedgerRecord,
  type LedgerState,
} from "@/lib/ledger"

type BackupKey =
  | "current"
  | "stale"
  | "failed"
  | "incomplete"
  | "unverified"
  | "never-run"
  | "not-configured"
  | "unknown"

type SyncKey = "manual" | "error" | "never-synced" | "stale" | "current"

type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

type BusyAction = "refresh" | "sync" | "disconnect" | "delete" | null

type DialogKind = "disconnect" | "delete" | null

const BACKUP_LABELS: Record<BackupKey, string> = {
  current: "Current",
  stale: "Stale",
  failed: "Failed",
  incomplete: "Incomplete",
  unverified: "Unverified",
  "never-run": "Never run",
  "not-configured": "Not configured",
  unknown: "Unknown",
}

const SYNC_LABELS: Record<SyncKey, string> = {
  manual: "Manual / CSV",
  error: "Needs attention",
  "never-synced": "No successful update",
  stale: "Stale",
  current: "Current",
}

function toDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function displayTime(value: unknown, missing = "Not recorded") {
  const date = toDate(value)
  if (!date) return typeof value === "string" && value ? value : missing
  return date.toLocaleString()
}

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "Ledger could not complete this action."
}

function canUseSessionStorage() {
  if (typeof window === "undefined") return false
  try {
    const probe = "__ledger_session_probe__"
    window.sessionStorage.setItem(probe, "1")
    window.sessionStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

function backupBadgeVariant(key: BackupKey): BadgeVariant {
  if (key === "current") return "secondary"
  if (key === "failed" || key === "stale") return "destructive"
  return "outline"
}

function syncBadgeVariant(key: SyncKey): BadgeVariant {
  if (key === "current") return "secondary"
  if (key === "error" || key === "stale") return "destructive"
  return "outline"
}

function providerLabel(item: LedgerRecord | undefined) {
  if (!item || typeof item.name !== "string" || !item.name) return "this provider"
  return item.name
}

function providerId(item: LedgerRecord | undefined) {
  return typeof item?.id === "string" ? item.id : ""
}

function deriveReadiness(state: LedgerState | null, health: LedgerRecord) {
  const setup = asRecord(state?.setup)
  const backup = asRecord(setup.backup)
  const timer = asRecord(setup.syncTimer)
  const verification = asRecord(backup.verification)
  const backupTimer = asRecord(backup.timer)

  const hasBackupRecency = toDate(backup.lastSuccess) !== null
  const rehearsal = verification.restoreRehearsal === "passed"
  const complete = backup.state === "success" && backup.recoveryState === "complete"
  const verified =
    complete &&
    verification.bundleChecksums === "verified" &&
    verification.databaseIntegrity === "passed" &&
    (verification.tokens === "decrypted" || verification.tokens === "no_tokens")

  const backupKey: BackupKey =
    backup.state === "not_configured"
      ? "not-configured"
      : backup.state === "not_run"
        ? "never-run"
        : backup.state === "failed"
          ? "failed"
          : backup.state === "unavailable" || !backup.state
            ? "unknown"
            : !complete
              ? "incomplete"
              : !verified || !hasBackupRecency
                ? "unverified"
                : backup.recoveryStale === true
                  ? "stale"
                  : "current"

  const lastVerified = hasBackupRecency
    ? ` · last verified ${displayTime(backup.lastSuccess)}`
    : " · recency unavailable"
  const backupSummary =
    backupKey === "current"
      ? `Verified recovery backup current${lastVerified}${rehearsal ? "" : " · restore rehearsal not performed"}`
      : backupKey === "stale"
        ? `Verified recovery backup is stale${hasBackupRecency ? ` · last verified ${displayTime(backup.lastSuccess)}` : ""}`
        : backupKey === "failed"
          ? `Latest backup attempt failed${backup.lastAttempt ? ` · ${displayTime(backup.lastAttempt)}` : ""}`
          : backupKey === "incomplete"
            ? "Database backup only; recovery pair incomplete"
            : backupKey === "unverified"
              ? `Recovery bundle has not passed verification${hasBackupRecency ? "" : " · recency unavailable"}`
              : backupKey === "never-run"
                ? "No backup has run yet"
                : backupKey === "not-configured"
                  ? "Local recovery backups are not configured"
                  : "Local backup status is unavailable"

  const backupWarning =
    backupKey === "failed"
      ? "The latest local backup attempt failed. Review its time and next action below."
      : backupKey === "stale"
        ? "The last verified local recovery bundle is stale. Review backup status below."
        : backupKey === "incomplete"
          ? "The local backup is missing a complete recovery pair. Review what is missing below."
          : backupKey === "unverified"
            ? "The latest local recovery bundle has not passed verification. Review it below."
            : backupKey === "never-run"
              ? "No local backup has run yet. Set up recovery before relying on it."
              : backupKey === "not-configured"
                ? "Local recovery backups are not configured. Review recovery setup below."
                : backupKey === "unknown"
                  ? "Local backup status is unavailable. Review recovery setup below."
                  : "The verified recovery pair is current."

  const providerItems = asArray<LedgerRecord>(state?.items)
  const bankItems = providerItems.filter((item) => item.lifecycle !== "unlinked")
  const failures = bankItems.filter((item) => item.error)
  const syncEvidence = bankItems.map((item) => {
    const value = item.lastSuccess || item.lastSync
    return { value, date: toDate(value) }
  })
  const missingSync = syncEvidence.filter((row) => !row.value || !row.date)
  const staleSync = syncEvidence.filter(
    (row) => row.date !== null && Date.now() - row.date.getTime() > 24 * 60 * 60 * 1000
  )
  const successTimes = syncEvidence
    .map((row) => row.date)
    .filter((date): date is Date => date !== null)
    .sort((left, right) => left.getTime() - right.getTime())
  const lastSuccessDate = successTimes[successTimes.length - 1] ?? null
  const lastSuccessLabel = lastSuccessDate ? displayTime(lastSuccessDate.toISOString()) : "never recorded"

  const localOnly = health.localOnly === true || bankItems.length === 0
  const schedule = localOnly
    ? "No automatic updates"
    : timer.state === "available"
      ? timer.enabled
        ? "Scheduled"
        : "Not scheduled"
      : "Schedule unavailable"

  let syncKey: SyncKey = "manual"
  let syncSummary = "Manual / CSV · no automatic bank updates"
  let syncWarning = ""
  let syncDetail =
    "Records are entered by hand or imported from CSV. No automatic bank update is scheduled."

  if (!localOnly && failures.length) {
    syncKey = "error"
    syncSummary = `${failures.length} connection${failures.length === 1 ? "" : "s"} need attention · ${schedule}`
    syncWarning = "A bank connection needs attention. Open Accounts to reconnect."
    syncDetail = `The last successful bank update was ${lastSuccessLabel}. Reconnect the affected bank in Accounts.`
  } else if (!localOnly && missingSync.length) {
    syncKey = "never-synced"
    syncSummary = `No successful update for ${missingSync.length} connection${missingSync.length === 1 ? "" : "s"} · ${schedule}`
    syncWarning = "At least one bank connection has no successful update recorded yet. Open Accounts to sync or review the connection."
    syncDetail = "Every active bank connection needs its own successful update timestamp. A schedule is not evidence that an update succeeded."
  } else if (!localOnly && staleSync.length) {
    syncKey = "stale"
    syncSummary = `Stale · ${staleSync.length} connection${staleSync.length === 1 ? "" : "s"} need an update · ${schedule}`
    syncWarning = "At least one bank connection has not updated successfully in more than a day. Values may be stale."
    syncDetail = `The most recent successful update was ${lastSuccessLabel}. At least one connection is stale; open Accounts to sync or review the schedule.`
  } else if (!localOnly && !lastSuccessDate) {
    syncKey = "never-synced"
    syncSummary = `No successful bank update yet · ${schedule}`
    syncWarning = "No successful bank update has been recorded yet. Open Accounts to sync or review the connection."
    syncDetail = "A bank connection exists, but no successful update has completed. A schedule is not evidence that an update succeeded."
  } else if (!localOnly) {
    syncKey = "current"
    syncSummary = `Current · last successful ${lastSuccessLabel} · ${schedule}`
    syncDetail = `The last successful bank update was ${lastSuccessLabel} and the schedule is ${schedule.toLowerCase()}.`
  }

  const healthy = backupKey === "current" && (syncKey === "current" || syncKey === "manual")

  const timerLabel =
    syncKey === "manual"
      ? "Not applicable · manual / CSV"
      : timer.state !== "available"
        ? "Schedule status unavailable"
        : `${timer.enabled ? "Scheduled" : "Not scheduled"}${timer.active ? " · running now" : ""}`

  const backupTimerLabel =
    backupTimer.state !== "available"
      ? "Schedule status unavailable"
      : `${backupTimer.enabled ? "Scheduled" : "Not scheduled"}${backupTimer.active ? " · running now" : ""}`

  return {
    backup,
    backupKey,
    backupLabel: BACKUP_LABELS[backupKey],
    backupSummary,
    backupWarning,
    backupTimer,
    backupTimerLabel,
    verification,
    rehearsal,
    timer,
    timerLabel,
    bankItems,
    failures,
    lastSuccessDate,
    lastSuccessLabel,
    localOnly,
    providerItems,
    schedule,
    summaryNote: healthy
      ? "Your records and backups stay on this device. Details for the person who set this up are below."
      : "Review the technical details below. Ledger will not call a status healthy until the evidence supports it.",
    syncKey,
    syncLabel: SYNC_LABELS[syncKey],
    syncSummary,
    syncWarning,
    syncDetail,
    healthy,
  }
}

type Readiness = ReturnType<typeof deriveReadiness>

type DetailRow = { label: string; value: string }

function DetailTable({ rows, caption }: { rows: DetailRow[]; caption: string }) {
  return (
    <Table className="min-w-[30rem]">
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader className="sr-only">
        <TableRow>
          <TableHead scope="col">Detail</TableHead>
          <TableHead scope="col">Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.label}>
            <TableHead
              scope="row"
              className="w-2/5 font-normal whitespace-normal text-muted-foreground"
            >
              {row.label}
            </TableHead>
            <TableCell className="whitespace-normal text-right font-medium">
              {row.value}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading details">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-8 w-full rounded-lg" />
      ))}
    </div>
  )
}

function BackupStatusCard({ readiness }: { readiness: Readiness }) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader className="gap-2">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <CardTitle className="flex min-w-0 items-center gap-2">
            <HugeiconsIcon icon={Database01Icon} className="size-4 shrink-0 text-muted-foreground" />
            Recovery backups
          </CardTitle>
          <Badge variant={backupBadgeVariant(readiness.backupKey)}>
            {readiness.backupLabel}
          </Badge>
        </div>
        <CardDescription>{readiness.backupSummary}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {readiness.backupWarning}
        </p>
      </CardContent>
    </Card>
  )
}

function BankStatusCard({ readiness }: { readiness: Readiness }) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader className="gap-2">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <CardTitle className="flex min-w-0 items-center gap-2">
            <HugeiconsIcon icon={BankIcon} className="size-4 shrink-0 text-muted-foreground" />
            Bank updates
          </CardTitle>
          <Badge variant={syncBadgeVariant(readiness.syncKey)}>{readiness.syncLabel}</Badge>
        </div>
        <CardDescription>{readiness.syncSummary}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {readiness.syncWarning || readiness.syncDetail}
        </p>
      </CardContent>
    </Card>
  )
}

function LocalRecoveryCard({ readiness }: { readiness: Readiness }) {
  const tokens = readiness.verification.tokens
  const tokenLabel =
    tokens === "decrypted"
      ? "Decrypted"
      : tokens === "no_tokens"
        ? "No stored tokens"
        : "Unknown"

  const rows: DetailRow[] = [
    { label: "Status", value: readiness.backupLabel },
    { label: "Summary", value: readiness.backupSummary },
    {
      label: "Last attempt",
      value: displayTime(readiness.backup.lastAttempt, "No attempt recorded"),
    },
    {
      label: "Last verified success",
      value: displayTime(readiness.backup.lastSuccess, "None recorded"),
    },
    {
      label: "Recovery pair",
      value: readiness.backup.state === "success" && readiness.backup.recoveryState === "complete" ? "Complete" : "Incomplete",
    },
    {
      label: "Bundle checksums",
      value: readiness.verification.bundleChecksums === "verified" ? "Verified" : "Unknown",
    },
    {
      label: "Database integrity",
      value: readiness.verification.databaseIntegrity === "passed" ? "Checked" : "Unknown",
    },
    { label: "Stored tokens", value: tokenLabel },
    { label: "Restore rehearsal", value: readiness.rehearsal ? "Passed" : "Not performed" },
    {
      label: "Last complete recovery bundle",
      value: displayTime(readiness.backup.lastCompleteRecovery, "None recorded"),
    },
  ]
  if (typeof readiness.backup.failureCategory === "string" && readiness.backup.failureCategory) {
    rows.push({ label: "Failure category", value: readiness.backup.failureCategory })
  }
  rows.push({ label: "Backup timer", value: readiness.backupTimerLabel })
  rows.push({
    label: "Next backup run",
    value:
      typeof readiness.backupTimer.nextRun === "string" && readiness.backupTimer.nextRun
        ? readiness.backupTimer.nextRun
        : "No backup run is scheduled",
  })

  return (
    <Card className="min-w-0">
      <CardHeader className="gap-1">
        <CardTitle>Local recovery backups</CardTitle>
        <CardDescription>
          A complete recovery bundle pairs the verified database with the matching private
          configuration snapshot. Encrypt any offline copy.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <DetailTable rows={rows} caption="Local recovery backup evidence and schedule" />
      </CardContent>
    </Card>
  )
}

export function SettingsPage() {
  const { preview, refresh, setPage, state, write } = useLedger()
  const health = useHealth()
  const syncStatus = useSyncStatus()

  const [pendingCount, setPendingCount] = useState(() => pendingOperationCount())
  const [recoveryAvailable] = useState(canUseSessionStorage)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [dialogItem, setDialogItem] = useState({ id: "", name: "this provider" })
  const [actionError, setActionError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const healthData = useMemo(() => asRecord(health.data), [health.data])
  const readiness = useMemo(
    () => deriveReadiness(state, healthData),
    [state, healthData]
  )
  const configurationReady = healthData.configurationReady === true
  const localOnly = healthData.localOnly === true

  useEffect(() => {
    const update = () => setPendingCount(pendingOperationCount())
    window.addEventListener("focus", update)
    return () => window.removeEventListener("focus", update)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setPendingCount(pendingOperationCount()), 0)
    return () => window.clearTimeout(timer)
  }, [state?.revision, health.data, syncStatus.data])

  const connectedItem = readiness.providerItems.find(
    (item) => item.lifecycle !== "unlinked"
  )
  const unlinkedItem = readiness.providerItems.find(
    (item) => item.lifecycle === "unlinked"
  )
  const historyItem = unlinkedItem ?? connectedItem

  function dismissPending() {
    if (!recoveryAvailable) return
    clearAllPendingOperations()
    setPendingCount(0)
    toast.add({
      title: "Message dismissed. Check your saved records before entering the change again.",
      type: "info",
    })
  }

  async function handleRefresh() {
    setBusy("refresh")
    setActionError(null)
    try {
      await refresh()
    } finally {
      setBusy(null)
      setPendingCount(pendingOperationCount())
    }
  }

  async function handleSync() {
    if (preview || !configurationReady) return
    setBusy("sync")
    setActionError(null)
    try {
      await write("sync", {})
      const message = "Bank update requested. Check Accounts for the result."
      setSuccessMessage(message)
      toast.add({ title: message, type: "success" })
    } catch (caught) {
      const message = errorMessage(caught)
      setActionError(message)
      toast.add({ title: "Update accounts failed", description: message, type: "error" })
    } finally {
      setBusy(null)
      setPendingCount(pendingOperationCount())
    }
  }

  function openDialog(kind: Exclude<DialogKind, null>) {
    const item = kind === "delete" ? historyItem : connectedItem
    setDialogItem({ id: providerId(item), name: providerLabel(item) })
    setActionError(null)
    setDialog(kind)
  }

  async function confirmDialog() {
    if (!dialog || preview || !dialogItem.id) return
    const kind = dialog
    setBusy(kind)
    setActionError(null)
    try {
      const revision = state?.revision ?? 0
      if (kind === "disconnect") {
        await write("disconnect", { itemId: dialogItem.id, revision })
        const message =
          "Provider access was removed. Imported account and transaction history remains saved."
        setSuccessMessage(message)
        toast.add({ title: message, type: "success" })
      } else {
        await write("delete-history", { itemId: dialogItem.id, revision })
        const message = "Saved provider history was deleted."
        setSuccessMessage(message)
        toast.add({ title: message, type: "success" })
      }
      setDialog(null)
    } catch (caught) {
      const message = errorMessage(caught)
      setActionError(message)
      toast.add({ title: "Action could not be completed", description: message, type: "error" })
    } finally {
      setBusy(null)
      setPendingCount(pendingOperationCount())
    }
  }

  const job = asRecord(syncStatus.data?.job)
  const jobFailures = asArray<LedgerRecord>(job.failures).map(
    (failure) =>
      `${typeof failure.bank === "string" ? failure.bank : "Connection"}: ${
        typeof failure.message === "string" ? failure.message : "Unknown error"
      }`
  )
  const hasJob = Object.keys(job).length > 0
  const configurationRows: DetailRow[] = [
    {
      label: "Configuration",
      value: configurationReady ? "Ready for writes" : "Not ready for writes",
    },
    { label: "Connection mode", value: localOnly ? "Local only" : "Bank connections available" },
    { label: "Bank update schedule", value: readiness.timerLabel },
    { label: "Last recorded sync", value: displayTime(healthData.lastSync) },
    {
      label: "Build version",
      value: typeof healthData.codeVersion === "string" && healthData.codeVersion
        ? healthData.codeVersion
        : "Unavailable",
    },
    {
      label: "Schema version",
      value:
        typeof healthData.schemaVersion === "number" || typeof healthData.schemaVersion === "string"
          ? String(healthData.schemaVersion)
          : "Unavailable",
    },
  ]

  return (
    <PageShell
      title="Settings"
      description="Connection, data freshness, and local recovery status."
    >
      <div className="flex min-w-0 flex-col gap-6">
        {pendingCount > 0 ? (
          <Alert>
            <HugeiconsIcon icon={Alert02Icon} data-icon="inline-start" />
            <AlertTitle>Unconfirmed save</AlertTitle>
            <AlertDescription>
              {`We couldn’t confirm your save for ${pendingCount} action(s). It may still have saved. Check the saved records before making the change again.`}
            </AlertDescription>
            <AlertAction>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={dismissPending}
                disabled={!recoveryAvailable}
              >
                Dismiss
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {!recoveryAvailable ? (
          <Alert>
            <HugeiconsIcon icon={Alert02Icon} data-icon="inline-start" />
            <AlertTitle>Reload recovery is unavailable</AlertTitle>
            <AlertDescription>
              This browser cannot save reload-recovery references. If a save response is
              lost, check the saved records before trying again.
            </AlertDescription>
          </Alert>
        ) : null}

        <section
          aria-labelledby="system-readiness-heading"
          className="flex min-w-0 flex-col gap-4"
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <h2
              id="system-readiness-heading"
              className="flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight"
            >
              <HugeiconsIcon
                icon={Shield01Icon}
                className="size-5 shrink-0 text-muted-foreground"
              />
              System readiness
            </h2>
            <Badge variant={readiness.healthy ? "secondary" : "destructive"}>
              {readiness.healthy ? "Everything looks fine" : "Needs attention"}
            </Badge>
          </div>

          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <BackupStatusCard readiness={readiness} />
            <BankStatusCard readiness={readiness} />
          </div>

          <Alert variant={readiness.healthy ? "default" : "destructive"}>
            <HugeiconsIcon
              icon={readiness.healthy ? CheckmarkCircle02Icon : Alert02Icon}
              data-icon="inline-start"
            />
            <AlertTitle>
              {readiness.healthy ? "Ready to use" : "Review the details"}
            </AlertTitle>
            <AlertDescription>{readiness.summaryNote}</AlertDescription>
          </Alert>

          <Accordion
            defaultValue={readiness.healthy ? [] : ["technical"]}
            className="min-w-0 bg-card"
          >
            <AccordionItem value="technical">
              <AccordionTrigger className="min-h-11">
                <span className="flex min-w-0 items-center gap-2">
                  <HugeiconsIcon
                    icon={InformationCircleIcon}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  Technical details
                </span>
              </AccordionTrigger>
              <AccordionContent className="flex min-w-0 flex-col gap-4">
                <Card className="min-w-0">
                  <CardHeader className="gap-1">
                    <CardTitle>Configuration</CardTitle>
                    <CardDescription>
                      These values describe this Ledger installation, not a remote service.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0">
                    {health.loading ? (
                      <DetailSkeleton />
                    ) : (
                      <DetailTable
                        rows={configurationRows}
                        caption="Installation configuration and version details"
                      />
                    )}
                  </CardContent>
                </Card>

                <Card className="min-w-0">
                  <CardHeader className="gap-1">
                    <CardTitle>Bank updates</CardTitle>
                    <CardDescription>
                      {readiness.syncDetail} A schedule is not evidence that a bank update
                      succeeded; the last successful update is the reliable date.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0">
                    <DetailTable
                      rows={[
                        { label: "Status", value: readiness.syncLabel },
                        { label: "Schedule", value: readiness.timerLabel },
                        {
                          label: "Last successful update",
                          value: readiness.lastSuccessDate
                            ? readiness.lastSuccessLabel
                            : "None recorded",
                        },
                        {
                          label: "Next scheduled run",
                          value:
                            readiness.syncKey === "manual"
                              ? "No automatic update scheduled"
                              : typeof readiness.timer.nextRun === "string" && readiness.timer.nextRun
                                ? readiness.timer.nextRun
                                : "No next run scheduled",
                        },
                      ]}
                      caption="Bank update status and schedule details"
                    />
                  </CardContent>
                </Card>

                <Card className="min-w-0">
                  <CardHeader className="gap-1">
                    <CardTitle>Latest sync job</CardTitle>
                    <CardDescription>
                      The result of the most recent bank update attempt, if one ran.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0">
                    {syncStatus.loading ? (
                      <DetailSkeleton />
                    ) : !hasJob ? (
                      <p className="text-sm text-muted-foreground">No sync job has run yet.</p>
                    ) : (
                      <div className="flex min-w-0 flex-col gap-3">
                        <DetailTable
                          rows={[
                            {
                              label: "Status",
                              value:
                                typeof job.status === "string" ? job.status : "Unavailable",
                            },
                            {
                              label: "Started",
                              value: displayTime(job.startedAt),
                            },
                            {
                              label: "Connections checked",
                              value: `${String(job.completed ?? 0)} / ${String(job.total ?? 0)}`,
                            },
                          ]}
                          caption="Latest bank sync job result"
                        />
                        {jobFailures.length ? (
                          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                            {jobFailures.map((failure) => (
                              <li key={failure}>{failure}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            No connection errors were recorded for this job.
                          </p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>

                <LocalRecoveryCard readiness={readiness} />

                <Card className="min-w-0">
                  <CardHeader className="gap-1">
                    <CardTitle>Local recovery</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Your records and backups stay on this device. Keep the private
                      configuration and encryption key with recovery instructions; Ledger
                      does not upload backup data.
                    </p>
                  </CardContent>
                </Card>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </section>

        <section
          aria-labelledby="data-controls-heading"
          className="flex min-w-0 flex-col gap-4"
        >
          <h2 id="data-controls-heading" className="text-lg font-semibold tracking-tight">
            Data controls
          </h2>

          {actionError ? (
            <Alert variant="destructive">
              <HugeiconsIcon icon={Alert02Icon} data-icon="inline-start" />
              <AlertTitle>Action could not be completed</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}

          {successMessage ? (
            <Alert>
              <HugeiconsIcon icon={CheckmarkCircle02Icon} data-icon="inline-start" />
              <AlertTitle>Action complete</AlertTitle>
              <AlertDescription>{successMessage}</AlertDescription>
            </Alert>
          ) : null}

          <Card className="min-w-0">
            <CardHeader className="gap-1">
              <CardTitle>Actions</CardTitle>
              <CardDescription>
                Refresh saved records, request a bank update, or manage provider access and
                saved history.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-4">
              <div
                className={cn(
                  "flex min-w-0 flex-wrap items-center gap-2",
                  !configurationReady && "opacity-70"
                )}
              >
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleRefresh()}
                  disabled={busy !== null}
                >
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    data-icon="inline-start"
                    className={cn("size-4", busy === "refresh" && "animate-spin")}
                  />
                  Refresh now
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleSync()}
                  disabled={preview || !configurationReady || busy !== null}
                >
                  <HugeiconsIcon icon={Clock01Icon} data-icon="inline-start" />
                  Update accounts
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => openDialog("disconnect")}
                  disabled={preview || !connectedItem || busy !== null}
                >
                  <HugeiconsIcon icon={Unlink01Icon} data-icon="inline-start" />
                  Disconnect provider
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => openDialog("delete")}
                  disabled={preview || !historyItem || busy !== null}
                >
                  <HugeiconsIcon icon={Delete02Icon} data-icon="inline-start" />
                  Delete provider history
                </Button>
              </div>

              {preview ? (
                <p className="text-sm text-muted-foreground">
                  Changes are unavailable in the synthetic preview.
                </p>
              ) : null}
              {!configurationReady ? (
                <p className="text-sm text-muted-foreground">
                  Updates require a configured Ledger connection.
                </p>
              ) : null}

              {readiness.providerItems.length ? (
                <Table className="min-w-[32rem]">
                  <TableCaption className="sr-only">
                    Saved provider connections and their last successful update
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Provider</TableHead>
                      <TableHead scope="col">Status</TableHead>
                      <TableHead scope="col">Last successful update</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {readiness.providerItems.map((item, index) => (
                      <TableRow key={providerId(item) || `provider-${index}`}>
                        <TableCell className="font-medium">
                          {providerLabel(item)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {item.lifecycle === "unlinked"
                              ? "Disconnected"
                              : item.error
                                ? "Needs attention"
                                : "Connected"}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-normal text-muted-foreground">
                          {displayTime(item.lastSuccess || item.lastSync)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Empty className="border p-6">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <HugeiconsIcon icon={BankIcon} />
                    </EmptyMedia>
                    <EmptyTitle>No connected providers</EmptyTitle>
                    <EmptyDescription>
                      Accounts can be recorded manually or imported from CSV. There is no
                      provider access to remove or history to delete.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>
        </section>

        <AlertDialog
          open={dialog !== null}
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {dialog === "delete" ? "Delete provider history?" : "Disconnect provider?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {dialog === "delete"
                  ? `Delete the saved account and transaction history for ${dialogItem.name}? This cannot be undone.`
                  : `Remove provider access for ${dialogItem.name}? Imported account and transaction history remains saved.`}
              </AlertDialogDescription>
            </AlertDialogHeader>

            {actionError ? (
              <Alert variant="destructive">
                <HugeiconsIcon icon={Alert02Icon} data-icon="inline-start" />
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            ) : null}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={busy !== null || !dialogItem.id}
                onClick={() => void confirmDialog()}
              >
                <HugeiconsIcon
                  icon={dialog === "delete" ? Delete02Icon : Unlink01Icon}
                  data-icon="inline-start"
                />
                {busy !== null
                  ? "Working…"
                  : dialog === "delete"
                    ? "Delete history"
                    : "Disconnect"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <section
          aria-labelledby="help-heading"
          className="flex min-w-0 flex-col gap-4"
        >
          <h2 id="help-heading" className="text-lg font-semibold tracking-tight">
            Navigation and privacy
          </h2>
          <Card className="min-w-0">
            <CardHeader className="gap-1">
              <CardTitle className="flex min-w-0 items-center gap-2">
                <HugeiconsIcon
                  icon={InformationCircleIcon}
                  className="size-4 shrink-0 text-muted-foreground"
                />
                Where to go next
              </CardTitle>
              <CardDescription>
                Review saved records or reconnect a bank from Accounts.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-3">
              <div className="flex min-w-0 flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPage("accounts")}
                >
                  <HugeiconsIcon icon={BankIcon} data-icon="inline-start" />
                  Open accounts
                  <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-end" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPage("transactions")}
                >
                  <HugeiconsIcon icon={ReceiptTextIcon} data-icon="inline-start" />
                  Open transactions
                  <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-end" />
                </Button>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Ledger does not use analytics, remote fonts, or external assets. Responses
                are returned with no-store headers.
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </PageShell>
  )
}
