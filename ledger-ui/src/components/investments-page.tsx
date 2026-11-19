import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons"

import { PageShell } from "@/components/page-shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/toast"
import { useLedger } from "@/context/ledger-context"
import { asArray, asRecord, formatCents } from "@/lib/ledger"
import type { LedgerRecord } from "@/lib/ledger"

type Holding = {
  id: string
  itemId: string
  accountId: string
  securityId: string
  name: string | null
  ticker: string | null
  quantity: number | null
  value: number | null
  costBasis: number | null
  currency: string | null
  asOf: string | null
  profileId: OwnerValue | null
}

type OwnerValue = "inherit" | "peter" | "maddie" | "joint"

const OWNER_ITEMS: ReadonlyArray<{ value: OwnerValue; label: string }> = [
  { value: "inherit", label: "Inherit from account" },
  { value: "peter", label: "Peter" },
  { value: "maddie", label: "Maddie" },
  { value: "joint", label: "Joint" },
]

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function asCents(value: unknown): number | null {
  return Number.isSafeInteger(value) ? (value as number) : null
}

function parseHolding(value: unknown, index: number): Holding | null {
  const raw = asRecord(value)
  const itemId = asNonEmptyString(raw.itemId)
  const accountId = asNonEmptyString(raw.accountId)
  const securityId = asNonEmptyString(raw.securityId)
  if (!itemId || !accountId || !securityId) return null

  const owner = asNonEmptyString(raw.profileId)
  const profileId =
    owner === "peter" || owner === "maddie" || owner === "joint" ? owner : null

  return {
    id: asNonEmptyString(raw.id) ?? `${itemId}:${accountId}:${securityId}:${index}`,
    itemId,
    accountId,
    securityId,
    name: asNonEmptyString(raw.name),
    ticker: asNonEmptyString(raw.ticker),
    quantity:
      typeof raw.quantity === "number" && Number.isFinite(raw.quantity) ? raw.quantity : null,
    value: asCents(raw.value),
    costBasis: asCents(raw.costBasis),
    currency: asNonEmptyString(raw.currency),
    asOf: asNonEmptyString(raw.asOf),
    profileId,
  }
}

function formatQuantity(value: number | null): string {
  if (value === null) return "Not recorded"
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value)
}

function formatMoney(value: number | null, currency: string | null): string {
  if (value === null) return "Not recorded"
  return `${formatCents(value)}${currency ? ` ${currency}` : ""}`
}

function ownerLabel(value: string | null): string {
  return OWNER_ITEMS.find((item) => item.value === value)?.label ?? "Inherit from account"
}

export function InvestmentsPage() {
  const { state, write, preview, profile, setPage } = useLedger()
  const [ownerHolding, setOwnerHolding] = useState<Holding | null>(null)
  const [ownerValue, setOwnerValue] = useState<OwnerValue>("inherit")
  const [saving, setSaving] = useState(false)

  const holdings = asArray<unknown>(state?.holdings)
    .map((row, index) => parseHolding(row, index))
    .filter((row): row is Holding => row !== null)

  const items = new Map<string, LedgerRecord>()
  for (const item of asArray<LedgerRecord>(state?.items)) {
    if (typeof item.id === "string") items.set(item.id, item)
  }

  const accounts = new Map<string, LedgerRecord>()
  for (const account of asArray<LedgerRecord>(state?.accounts)) {
    if (typeof account.id === "string") accounts.set(account.id, account)
  }

  const failedItems = holdings.filter((holding) => {
    const item = items.get(holding.itemId)
    return item && item.error != null && item.error !== false
  }).length
  const pendingItems = holdings.filter((holding) => {
    const item = items.get(holding.itemId)
    return item && item.error == null && !asNonEmptyString(item.lastSync)
  }).length

  const canWrite =
    !preview && profile !== "combined" && Number.isSafeInteger(state?.revision)

  function openOwner(holding: Holding) {
    setOwnerHolding(holding)
    setOwnerValue(holding.profileId ?? "inherit")
  }

  async function saveOwner() {
    if (!ownerHolding || !canWrite) return
    const profileId = ownerValue === "inherit" ? null : ownerValue
    setSaving(true)
    try {
      await write("holding-owner", {
        itemId: ownerHolding.itemId,
        accountId: ownerHolding.accountId,
        securityId: ownerHolding.securityId,
        profileId,
        revision: state?.revision,
      })
      toast.add({
        title: "Owner updated",
        description: `${ownerHolding.name ?? ownerHolding.ticker ?? "Not recorded"} now uses ${ownerLabel(
          profileId
        ).toLowerCase()}.`,
        type: "success",
      })
      setOwnerHolding(null)
    } catch (caught) {
      toast.add({
        title: "Could not update owner",
        description: caught instanceof Error ? caught.message : "Unknown error",
        type: "error",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <PageShell
      title="Investments"
      description="Holdings reported by your connected institutions. Values are shown as reported and are not recalculated here."
    >
      {failedItems > 0 || pendingItems > 0 ? (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Some holdings may be stale</AlertTitle>
          <AlertDescription>
            {failedItems > 0
              ? `${failedItems} holding${failedItems === 1 ? "" : "s"} belong to a connection whose latest update failed. Saved values are shown, not fresh quotes.`
              : `${pendingItems} holding${pendingItems === 1 ? "" : "s"} belong to a connection waiting for its first holdings update.`}
          </AlertDescription>
        </Alert>
      ) : null}

      {preview || profile === "combined" ? (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Read-only view</AlertTitle>
          <AlertDescription>
            {preview
              ? "Owner changes are disabled while previewing a revision. Exit preview to make changes."
              : "Owner changes are disabled in the combined profile. Switch to an individual profile to make changes."}
          </AlertDescription>
        </Alert>
      ) : null}

      {holdings.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No holdings to display</EmptyTitle>
            <EmptyDescription>No investment holdings have been reported yet.</EmptyDescription>
          </EmptyHeader>
          <Button type="button" variant="outline" onClick={() => setPage("accounts")}>
            Review accounts
            <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-end" />
          </Button>
        </Empty>
      ) : (
        <section aria-label="Reported investment holdings" className="min-w-0 rounded-lg border bg-card text-card-foreground">
          <div className="overflow-x-auto">
            <table className="w-full caption-bottom text-sm">
              <thead className="border-b">
                <tr>
                  <th scope="col" className="h-12 px-4 text-left font-medium">Holding</th>
                  <th scope="col" className="h-12 px-4 text-left font-medium">Account</th>
                  <th scope="col" className="h-12 px-4 text-left font-medium">Owner</th>
                  <th scope="col" className="h-12 px-4 text-left font-medium">Quantity</th>
                  <th scope="col" className="h-12 px-4 text-left font-medium">Value</th>
                  <th scope="col" className="h-12 px-4 text-left font-medium">Cost basis</th>
                  <th scope="col" className="h-12 px-4 text-left font-medium">As of</th>
                  <th scope="col" className="h-12 px-4 text-left font-medium">Connection</th>
                  <th scope="col" className="h-12 px-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((holding) => {
                  const item = items.get(holding.itemId)
                  const account = accounts.get(holding.accountId)
                  const accountName = asNonEmptyString(account?.name) ?? holding.accountId
                  const failed = Boolean(item && item.error != null && item.error !== false)
                  const status = failed
                    ? "Needs sync"
                    : asNonEmptyString(item?.lastSync)
                      ? "Current"
                      : "Initial sync pending"
                  return (
                    <tr key={holding.id} className="border-b last:border-b-0">
                      <th scope="row" className="px-4 py-3 text-left align-top font-normal">
                        <span className="flex min-w-0 flex-col gap-1">
                          <span className="font-medium">{holding.name ?? "Not recorded"}</span>
                          <span className="text-xs text-muted-foreground">
                            {holding.ticker ?? "Not recorded"}
                            {holding.currency ? ` · ${holding.currency}` : ""}
                          </span>
                        </span>
                      </th>
                      <td className="px-4 py-3 align-top">{accountName}</td>
                      <td className="px-4 py-3 align-top">{ownerLabel(holding.profileId)}</td>
                      <td className="px-4 py-3 align-top tabular-nums">{formatQuantity(holding.quantity)}</td>
                      <td className="px-4 py-3 align-top tabular-nums">
                        {formatMoney(holding.value, null)}
                      </td>
                      <td className="px-4 py-3 align-top tabular-nums">
                        {formatMoney(holding.costBasis, null)}
                      </td>
                      <td className="px-4 py-3 align-top">{holding.asOf ?? "Not recorded"}</td>
                      <td className="px-4 py-3 align-top">{status}</td>
                      <td className="px-4 py-3 text-right align-top">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => openOwner(holding)}
                          disabled={!canWrite}
                        >
                          Set owner
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Holdings are account breakdowns. They do not add to account balances or net worth,
        and reported values are not quotes or investment advice.
      </p>

      <Dialog open={ownerHolding !== null} onOpenChange={(open) => !open && setOwnerHolding(null)}>
        {ownerHolding ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Set holding owner</DialogTitle>
              <DialogDescription>
                Choose who owns this position in Ledger. Inherit follows the investment
                account owner.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="holding-owner">Owner</FieldLabel>
              <Select
                items={OWNER_ITEMS}
                value={ownerValue}
                onValueChange={(value) =>
                  setOwnerValue(
                    OWNER_ITEMS.find((item) => item.value === value)?.value ?? "inherit"
                  )
                }
              >
                <SelectTrigger id="holding-owner" className="w-full">
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
              <FieldDescription>
                {ownerHolding.name ?? ownerHolding.ticker ?? "This holding"} ·{" "}
                {ownerHolding.accountId}
              </FieldDescription>
            </Field>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
              <Button type="button" onClick={() => void saveOwner()} disabled={!canWrite || saving}>
                {saving ? "Saving…" : "Save owner"}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </PageShell>
  )
}
