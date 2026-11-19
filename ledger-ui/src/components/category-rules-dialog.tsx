import { useEffect, useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, PencilIcon, TrashIcon } from "@hugeicons/core-free-icons"

import {
  Alert,
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
  FieldGroup,
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
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/toast"
import { useLedger } from "@/context/ledger-context"
import { useCategoryRules } from "@/hooks/use-ledger-resource"
import { api, type JsonObject } from "@/lib/api"
import {
  asArray,
  asRecord,
  assertCents,
  formatDate,
  formatDollarsInput,
  formatSignedCents,
  parseDollarsToCents,
  type Account,
  type Category,
  type LedgerRecord,
} from "@/lib/ledger"

const NONE = "none"
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

const scopeItems = [
  { value: "household", label: "Household" },
  { value: "peter", label: "Peter" },
  { value: "maddie", label: "Maddie" },
  { value: "joint", label: "Joint" },
]

type RuleDraft = {
  id?: string
  merchant: string
  counterparty: string
  accountId: string
  amount: string
  monthFrom: string
  monthTo: string
  sources: string
  categoryId: string
  profileId: string
  enabled: boolean
}

function emptyDraft(): RuleDraft {
  return {
    merchant: "",
    counterparty: "",
    accountId: NONE,
    amount: "",
    monthFrom: "",
    monthTo: "",
    sources: "",
    categoryId: NONE,
    profileId: "household",
    enabled: true,
  }
}

function ruleToDraft(rule: LedgerRecord): RuleDraft {
  return {
    id: typeof rule.id === "string" ? rule.id : undefined,
    merchant: typeof rule.merchant === "string" ? rule.merchant : "",
    counterparty: typeof rule.counterparty === "string" ? rule.counterparty : "",
    accountId: typeof rule.accountId === "string" && rule.accountId ? rule.accountId : NONE,
    amount: Number.isSafeInteger(rule.amount) ? formatDollarsInput(Number(rule.amount)) : "",
    monthFrom: typeof rule.monthFrom === "string" ? rule.monthFrom : "",
    monthTo: typeof rule.monthTo === "string" ? rule.monthTo : "",
    sources: Array.isArray(rule.sources)
      ? rule.sources.filter((source): source is string => typeof source === "string").join(", ")
      : "",
    categoryId: typeof rule.categoryId === "string" && rule.categoryId ? rule.categoryId : NONE,
    profileId: typeof rule.profileId === "string" && rule.profileId ? rule.profileId : "household",
    enabled: rule.enabled !== false,
  }
}

function ruleSummary(rule: LedgerRecord) {
  const merchant = typeof rule.merchant === "string" ? rule.merchant.trim() : ""
  const counterparty = typeof rule.counterparty === "string" ? rule.counterparty.trim() : ""
  const category = typeof rule.category === "string" ? rule.category : "Uncategorized"
  return `${merchant || counterparty || "Any merchant"} → ${category}`
}

function messageOf(caught: unknown) {
  return caught instanceof Error ? caught.message : "Ledger could not save this rule."
}

export type CategoryRulesDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CategoryRulesDialog({ open, onOpenChange }: CategoryRulesDialogProps) {
  const { state, profile, preview, write } = useLedger()
  const rulesQuery = useCategoryRules(profile)
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft)
  const [formError, setFormError] = useState<string | null>(null)
  const [previewData, setPreviewData] = useState<LedgerRecord | null>(null)
  const [confirm, setConfirm] = useState<"save" | "delete" | "apply" | null>(null)
  const [busy, setBusy] = useState(false)

  const rules = useMemo(
    () => asArray<LedgerRecord>(asRecord(rulesQuery.data).rules),
    [rulesQuery.data]
  )

  const categories = useMemo(
    () => asArray<Category>(state?.categoryCatalog).filter((category) => !category.archivedAt),
    [state?.categoryCatalog]
  )

  const accounts = useMemo(
    () => asArray<Account>(state?.accounts).filter((account) => !account.archivedAt),
    [state?.accounts]
  )

  const categoryItems = useMemo(
    () => [
      { value: NONE, label: "Choose a category" },
      ...categories.map((category) => ({ value: category.id, label: category.name })),
    ],
    [categories]
  )

  const accountItems = useMemo(
    () => [
      { value: NONE, label: "Any account" },
      ...accounts.map((account) => ({ value: account.id, label: account.name })),
    ],
    [accounts]
  )

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => setFormError(null), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  const previewChanges = asArray<LedgerRecord>(asRecord(previewData).changes)
  const previewCount = Number(asRecord(previewData).count ?? previewChanges.length) || 0

  function update<K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  function sourcesList() {
    return [
      ...new Set(
        draft.sources
          .split(",")
          .map((source) => source.trim())
          .filter(Boolean)
      ),
    ]
  }

  function buildRule() {
    const errors: string[] = []
    if (!draft.merchant.trim() && !draft.counterparty.trim()) {
      errors.push("Add merchant or counterparty text for this rule to match.")
    }
    if (draft.merchant.length > 200 || draft.counterparty.length > 200) {
      errors.push("Rule text must be 200 characters or fewer.")
    }
    if (!draft.categoryId || draft.categoryId === NONE) {
      errors.push("Choose a category for this rule.")
    }

    let amount: number | null = null
    if (draft.amount.trim()) {
      const cents = parseDollarsToCents(draft.amount)
      if (cents === null || cents === 0) {
        errors.push("Enter a valid non-zero dollar amount, or leave the amount blank.")
      } else {
        try {
          assertCents(cents)
          amount = cents
        } catch {
          errors.push("Enter a valid non-zero dollar amount, or leave the amount blank.")
        }
      }
    }

    for (const [label, value] of [
      ["Start month", draft.monthFrom],
      ["End month", draft.monthTo],
    ] as const) {
      if (value && !MONTH_PATTERN.test(value)) errors.push(`${label} must be YYYY-MM.`)
    }
    if (draft.monthFrom && draft.monthTo && draft.monthFrom > draft.monthTo) {
      errors.push("Start month must be on or before end month.")
    }

    const sources = sourcesList()
    if (sources.length > 10) errors.push("A rule can filter on at most 10 sources.")

    const selectedCategory = categories.find((category) => category.id === draft.categoryId)
    const rule: JsonObject = {
      ...(draft.id ? { id: draft.id } : {}),
      merchant: draft.merchant.trim(),
      counterparty: draft.counterparty.trim(),
      accountId: draft.accountId === NONE ? null : draft.accountId,
      amount,
      monthFrom: draft.monthFrom || null,
      monthTo: draft.monthTo || null,
      sources: sources.length ? sources : null,
      categoryId: draft.categoryId,
      category: selectedCategory?.name,
      profileId: draft.profileId === "household" ? null : draft.profileId,
      enabled: draft.enabled,
    }
    return { rule, errors }
  }

  async function runWrite(path: string, input: JsonObject, title: string, description: string) {
    setBusy(true)
    try {
      const result = await write<JsonObject>(path, input)
      await rulesQuery.refresh()
      toast.add({ title, description, type: "success" })
      return result
    } catch (caught) {
      const message = messageOf(caught)
      toast.add({ title: "Could not save rule changes", description: message, type: "error" })
      return null
    } finally {
      setBusy(false)
    }
  }

  async function handlePreview() {
    const { rule, errors } = buildRule()
    if (errors.length) {
      setFormError(errors.join(" "))
      return
    }
    setFormError(null)
    try {
      const result = await api<LedgerRecord>("category-rules-preview", { rule })
      setPreviewData(asRecord(result))
    } catch (caught) {
      setFormError(messageOf(caught))
    }
  }

  async function performSave() {
    const { rule, errors } = buildRule()
    if (errors.length) {
      setFormError(errors.join(" "))
      setConfirm(null)
      return
    }
    const result = await runWrite(
      "category-rules",
      { ...rule, action: "save" },
      draft.id ? "Rule updated" : "Rule saved",
      "Category rules now apply to eligible transactions."
    )
    setConfirm(null)
    if (result) {
      setDraft(emptyDraft())
      setPreviewData(null)
      setFormError(null)
    }
  }

  async function performDelete() {
    if (!draft.id) {
      setConfirm(null)
      return
    }
    const result = await runWrite(
      "category-rules",
      { action: "delete", id: draft.id },
      "Rule deleted",
      "Manual category choices stay protected."
    )
    setConfirm(null)
    if (result) {
      setDraft(emptyDraft())
      setPreviewData(null)
      setFormError(null)
    }
  }

  async function performApply() {
    const result = await runWrite(
      "category-rules-apply",
      {},
      "Rules applied",
      "Manual category choices stay protected."
    )
    setConfirm(null)
    if (result) {
      setPreviewData(null)
      setFormError(null)
    }
  }

  async function toggleRule(rule: LedgerRecord) {
    if (preview || busy || typeof rule.id !== "string") return
    await runWrite(
      "category-rules",
      { ...asRecord(rule), action: "save", enabled: rule.enabled === false },
      rule.enabled === false ? "Rule enabled" : "Rule paused",
      "Manual category choices stay protected."
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Category rules</DialogTitle>
          <DialogDescription>
            Rules teach Ledger how to categorize repeated transactions. They only apply where
            you have not manually chosen a category.
          </DialogDescription>
        </DialogHeader>

        <section aria-label="Saved rules" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Saved rules</h3>
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rules saved yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rules.map((rule) => {
                const enabled = rule.enabled !== false
                const scope =
                  scopeItems.find((item) => item.value === (rule.profileId || "household"))?.label ??
                  "Household"
                return (
                  <li
                    key={String(rule.id)}
                    className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate text-sm font-medium">{ruleSummary(rule)}</span>
                      <span className="text-xs text-muted-foreground">{scope} scope</span>
                    </div>
                    <Badge variant={enabled ? "secondary" : "outline"}>
                      {enabled ? "Enabled" : "Paused"}
                    </Badge>
                    <Switch
                      checked={enabled}
                      onCheckedChange={() => void toggleRule(rule)}
                      disabled={preview || busy}
                      aria-label={`${enabled ? "Pause" : "Enable"} rule ${ruleSummary(rule)}`}
                      title={preview ? "Changes cannot be saved in the synthetic preview." : undefined}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDraft(ruleToDraft(rule))
                        setPreviewData(null)
                        setFormError(null)
                      }}
                    >
                      <HugeiconsIcon icon={PencilIcon} data-icon="inline-start" />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={preview || busy}
                      title={preview ? "Changes cannot be saved in the synthetic preview." : undefined}
                      onClick={() => {
                        setDraft(ruleToDraft(rule))
                        setConfirm("delete")
                      }}
                    >
                      <HugeiconsIcon icon={TrashIcon} data-icon="inline-start" />
                      Delete
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section aria-label="Rule editor" className="flex flex-col gap-4 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{draft.id ? "Edit rule" : "New rule"}</h3>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft(emptyDraft())
                setPreviewData(null)
                setFormError(null)
              }}
            >
              Clear form
            </Button>
          </div>

          {formError ? (
            <Alert variant="destructive" role="alert">
              <HugeiconsIcon icon={Alert02Icon} aria-hidden="true" />
              <AlertTitle>Check the rule</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="rule-merchant">Merchant</FieldLabel>
                <Input
                  id="rule-merchant"
                  value={draft.merchant}
                  maxLength={200}
                  placeholder="e.g. Corner Market"
                  onChange={(event) => update("merchant", event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="rule-counterparty">Counterparty</FieldLabel>
                <Input
                  id="rule-counterparty"
                  value={draft.counterparty}
                  maxLength={200}
                  placeholder="e.g. payroll sender"
                  onChange={(event) => update("counterparty", event.target.value)}
                />
                <FieldDescription>Merchant or counterparty text is required.</FieldDescription>
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="rule-account">Account</FieldLabel>
                <Select
                  items={accountItems}
                  value={draft.accountId}
                  onValueChange={(value) => update("accountId", String(value ?? NONE))}
                >
                  <SelectTrigger id="rule-account" aria-label="Account" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {accountItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="rule-amount">Amount</FieldLabel>
                <Input
                  id="rule-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder="Optional, e.g. 24.50 or -24.50"
                  value={draft.amount}
                  onChange={(event) => update("amount", event.target.value)}
                />
                <FieldDescription>
                  Leave blank to match any amount. Negative values match money received.
                </FieldDescription>
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="rule-month-from">From month</FieldLabel>
                <Input
                  id="rule-month-from"
                  type="month"
                  value={draft.monthFrom}
                  onChange={(event) => update("monthFrom", event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="rule-month-to">To month</FieldLabel>
                <Input
                  id="rule-month-to"
                  type="month"
                  value={draft.monthTo}
                  onChange={(event) => update("monthTo", event.target.value)}
                />
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="rule-sources">Sources</FieldLabel>
              <Input
                id="rule-sources"
                value={draft.sources}
                placeholder="Optional, comma separated (up to 10)"
                onChange={(event) => update("sources", event.target.value)}
              />
              <FieldDescription>Sources are import or connection labels separated by commas.</FieldDescription>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="rule-category">Category</FieldLabel>
                <Select
                  items={categoryItems}
                  value={draft.categoryId}
                  onValueChange={(value) => update("categoryId", String(value ?? NONE))}
                >
                  <SelectTrigger id="rule-category" aria-label="Category" className="w-full">
                    <SelectValue placeholder="Choose a category" />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {categoryItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="rule-scope">Profile scope</FieldLabel>
                <Select
                  items={scopeItems}
                  value={draft.profileId}
                  onValueChange={(value) => update("profileId", String(value ?? "household"))}
                >
                  <SelectTrigger id="rule-scope" aria-label="Profile scope" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {scopeItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field orientation="horizontal">
              <Switch
                id="rule-enabled"
                checked={draft.enabled}
                onCheckedChange={(checked) => update("enabled", checked)}
                aria-label="Rule enabled"
              />
              <FieldLabel htmlFor="rule-enabled" className="font-normal">
                Enabled
              </FieldLabel>
            </Field>
          </FieldGroup>

          {previewData ? (
            <div aria-live="polite" className="flex flex-col gap-2 rounded-lg border p-3">
              <p className="text-sm font-medium">
                {previewCount} transaction{previewCount === 1 ? "" : "s"} would change.
              </p>
              {previewChanges.slice(0, 5).map((change, index) => {
                const amount = Number(change.amount)
                return (
                  <p key={`${String(change.id)}-${index}`} className="text-xs text-muted-foreground">
                    {formatDate(typeof change.date === "string" ? change.date : undefined)} ·{" "}
                    {typeof change.merchant === "string" ? change.merchant : "Transaction"} ·{" "}
                    {String(change.from ?? "Uncategorized")} → {String(change.to ?? "Uncategorized")}
                    {Number.isSafeInteger(amount) ? ` · ${formatSignedCents(amount)}` : ""}
                  </p>
                )
              })}
              {previewCount > previewChanges.length ? (
                <p className="text-xs text-muted-foreground">
                  Showing the first {previewChanges.length} changes.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        <DialogFooter className="flex-wrap">
          <Button
            type="button"
            variant="outline"
            onClick={() => void handlePreview()}
            disabled={busy}
          >
            Preview changes
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirm("apply")}
            disabled={preview || busy}
            title={preview ? "Changes cannot be saved in the synthetic preview." : undefined}
          >
            Apply all rules
          </Button>
          <Button
            type="button"
            onClick={() => {
              const { errors } = buildRule()
              if (errors.length) {
                setFormError(errors.join(" "))
                return
              }
              if (previewCount > 0) setConfirm("save")
              else void performSave()
            }}
            disabled={preview || busy}
            title={preview ? "Changes cannot be saved in the synthetic preview." : undefined}
          >
            Save rule
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>

      <AlertDialog open={confirm === "save"} onOpenChange={(value) => { if (!value) setConfirm(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save rule and recategorize transactions?</AlertDialogTitle>
            <AlertDialogDescription>
              This rule would change {previewCount} transaction{previewCount === 1 ? "" : "s"}.
              Manual category choices stay protected and will not be changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void performSave()}>Save rule</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "delete"} onOpenChange={(value) => { if (!value) setConfirm(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this rule?</AlertDialogTitle>
            <AlertDialogDescription>
              Deleting a rule may return transactions to review, but manual category choices stay
              protected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void performDelete()}>Delete rule</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "apply"} onOpenChange={(value) => { if (!value) setConfirm(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply all enabled rules?</AlertDialogTitle>
            <AlertDialogDescription>
              Enabled rules will recategorize eligible transactions. Manual category choices stay
              protected and will not be changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void performApply()}>Apply rules</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
