import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  ArchiveIcon,
  Calendar03Icon,
  Copy01Icon,
  Edit02Icon,
  Home01Icon,
  Link01Icon,
  PlusSignIcon,
  RefreshIcon,
  Unarchive03Icon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons"
import { cn } from "cn"

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
import { Checkbox } from "@/components/ui/checkbox"
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
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
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
type MetricKind = "cents" | "text" | "number" | "percent"

const OWNER_ITEMS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "none", label: "Choose an owner" },
  { value: "peter", label: "Peter" },
  { value: "maddie", label: "Maddie" },
  { value: "joint", label: "Joint" },
]

const VALUATION_ITEMS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "owner_estimate", label: "Owner estimate" },
  { value: "appraisal", label: "Appraisal" },
  { value: "statement", label: "Statement" },
  { value: "other", label: "Other" },
]

const LOAN_ITEMS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "fixed", label: "Fixed rate" },
  { value: "adjustable", label: "Adjustable rate" },
  { value: "interest_only", label: "Interest only" },
  { value: "balloon", label: "Balloon" },
  { value: "heloc", label: "HELOC" },
  { value: "other", label: "Other" },
]

const COMPONENT_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "principalInterest", label: "Required principal and interest (USD/month)" },
  { key: "propertyTax", label: "Property tax (USD/month)" },
  { key: "homeownersInsurance", label: "Homeowners insurance (USD/month)" },
  { key: "mortgageInsurance", label: "Mortgage insurance (USD/month)" },
  { key: "hoa", label: "HOA (USD/month)" },
  { key: "otherRequired", label: "Other required payment (USD/month)" },
  { key: "extraPrincipal", label: "Extra principal (USD/month)" },
]

const SCENARIO_MONEY_FIELDS: ReadonlyArray<{
  key: string
  label: string
  required: boolean
}> = [
  { key: "purchasePrice", label: "Purchase price", required: true },
  { key: "downPayment", label: "Down payment", required: true },
  { key: "financedFees", label: "Fees financed into loan", required: true },
  { key: "propertyTaxMonthly", label: "Monthly property tax", required: true },
  { key: "homeownersInsuranceMonthly", label: "Monthly homeowners insurance", required: true },
  { key: "supplementaryInsuranceMonthly", label: "Other required insurance monthly", required: true },
  { key: "pmiMonthly", label: "Monthly PMI estimate", required: false },
  { key: "hoaMonthly", label: "Monthly HOA", required: true },
  { key: "maintenanceReserveMonthly", label: "Monthly maintenance reserve", required: true },
  { key: "subordinateDebtMonthly", label: "Monthly subordinate housing debt", required: true },
  { key: "closingCosts", label: "Cash closing costs", required: true },
  { key: "prepaids", label: "Prepaids and initial escrow", required: true },
  { key: "credits", label: "Lender and seller credits", required: true },
  { key: "earnestPaid", label: "Earnest money already paid", required: true },
  { key: "movingCosts", label: "Moving costs", required: true },
  { key: "initialRepairs", label: "Initial repairs", required: true },
  { key: "retainedReserve", label: "Retained emergency reserve", required: true },
  { key: "otherDebtPayments", label: "Other monthly debt payments", required: false },
  { key: "currentNonHousingCommitments", label: "Current non-housing monthly commitments", required: false },
  { key: "currentHousingCost", label: "Current monthly housing cost", required: false },
  { key: "plannedSavings", label: "Planned monthly savings", required: false },
  { key: "safetyMargin", label: "Monthly safety margin", required: false },
  { key: "pointsCents", label: "Points and rate costs", required: true },
]

const SCENARIO_OUTPUT_FIELDS: ReadonlyArray<{
  key: string
  label: string
  kind: MetricKind
}> = [
  { key: "loanPrincipal", label: "Loan principal", kind: "cents" },
  { key: "principalAndInterest", label: "Principal and interest", kind: "cents" },
  { key: "ownershipOutflow", label: "Total ownership outflow", kind: "cents" },
  { key: "remainingCashToClose", label: "Remaining cash to close", kind: "cents" },
  { key: "allInAcquisitionFunding", label: "All-in acquisition target", kind: "cents" },
  { key: "alreadyPaid", label: "Earnest money already paid", kind: "cents" },
  { key: "eligibleCash", label: "Eligible unallocated cash", kind: "cents" },
  { key: "allocatedGoalFunds", label: "Goal cash allocated", kind: "cents" },
  { key: "availableFunds", label: "Eligible cash plus linked goal", kind: "cents" },
  { key: "fundingShortfall", label: "Funding shortfall", kind: "cents" },
  { key: "cashAfterClosing", label: "Cash after closing and moving", kind: "cents" },
  { key: "cashFlowSurplus", label: "Cash-flow fit", kind: "cents" },
  { key: "dtiPercent", label: "Informational DTI", kind: "percent" },
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

function notFuture(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= new Date().toISOString().slice(0, 10)
}

function profileOf(value: unknown) {
  return isOwner(String(value ?? "")) ? profileLabel(value as ProfileId) : "Needs ownership review"
}

function metric(value: unknown, kind: MetricKind) {
  if (value === null || value === undefined) return "Not recorded"
  if (kind === "cents") return formatCents(asCents(value))
  if (kind === "percent") return typeof value === "number" ? `${value.toFixed(1)}%` : String(value)
  if (kind === "number") return Number.isSafeInteger(value) ? String(value) : "Not recorded"
  return typeof value === "string" || typeof value === "number" ? String(value) : "Not recorded"
}

function showError(message: string) {
  toast.add({ title: "Could not save", description: message, type: "error" })
}

function showSaved(message: string) {
  toast.add({ title: "Saved", description: message, type: "success" })
}

function PropertyFormDialog({
  property,
  onClose,
}: {
  property: LedgerRecord | null
  onClose: () => void
}) {
  const { profile, state, write } = useLedger()
  const [name, setName] = useState(asText(property?.name, ""))
  const [address, setAddress] = useState(asText(property?.address, ""))
  const [ownership, setOwnership] = useState(() => {
    const bps = asCents(property?.ownershipBps)
    return bps === null ? "100.00" : (bps / 100).toFixed(2)
  })
  const [valuation, setValuation] = useState(() =>
    formatDollarsInput(asCents(property?.valuation) ?? null)
  )
  const [valuationAsOf, setValuationAsOf] = useState(asText(property?.valuationAsOf, ""))
  const [valuationSource, setValuationSource] = useState(
    asText(property?.valuationSource, "owner_estimate")
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const revision = state?.revision

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (!Number.isSafeInteger(revision) || !isOwner(profile)) {
      setError("Switch to Peter, Maddie, or Joint before saving a property.")
      return
    }
    const ownershipBps = /^\d{1,3}(?:\.\d{1,2})?$/.test(ownership.trim())
      ? Math.round(Number(ownership) * 100)
      : -1
    const valuationCents = valuation.trim() ? parseDollarsToCents(valuation) : null
    if (!name.trim() || name.trim().length > 100) {
      setError("Enter a property nickname up to 100 characters.")
      return
    }
    if (ownershipBps < 1 || ownershipBps > 10000) {
      setError("Enter an ownership share from 0.01 to 100 percent.")
      return
    }
    if (!VALIDATION_SOURCES.has(valuationSource)) {
      setError("Choose where the valuation was observed.")
      return
    }
    if (valuationCents !== null) {
      if (valuationCents < 0) {
        setError("Enter a non-negative valuation.")
        return
      }
      if (!notFuture(valuationAsOf)) {
        setError("Choose a valuation date that is not in the future.")
        return
      }
    }
    const input: Record<string, unknown> = {
      name: name.trim(),
      address: address.trim(),
      profileId: profile,
      ownershipBps,
      valuation: valuationCents,
      valuationAsOf: valuationCents === null ? null : valuationAsOf,
      valuationSource: valuationCents === null ? null : valuationSource,
      revision,
    }
    if (property && typeof property.id === "string") input.id = property.id
    setSaving(true)
    try {
      await write("property", input)
      showSaved(property ? "Property updated." : "Property recorded.")
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this property.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{property ? "Edit property" : "Add property"}</DialogTitle>
        <DialogDescription>
          Record an owned property and its observed valuation. Hypothetical purchases
          belong in scenarios and never become owned property.
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="property-name">Nickname</FieldLabel>
            <Input id="property-name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="property-owner">Owner</FieldLabel>
            <Select items={OWNER_ITEMS} value={profile} disabled>
              <SelectTrigger id="property-owner" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {OWNER_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>Set by the selected household profile.</FieldDescription>
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="property-address">Address (stored locally)</FieldLabel>
            <Input id="property-address" value={address} maxLength={300} onChange={(event) => setAddress(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="property-ownership">Ownership share (%)</FieldLabel>
            <Input id="property-ownership" inputMode="decimal" value={ownership} onChange={(event) => setOwnership(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="property-valuation">Observed valuation (USD)</FieldLabel>
            <Input id="property-valuation" inputMode="decimal" value={valuation} onChange={(event) => setValuation(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="property-valuation-date">Valuation date</FieldLabel>
            <Input id="property-valuation-date" type="date" value={valuationAsOf} onChange={(event) => setValuationAsOf(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="property-source">Valuation source</FieldLabel>
            <Select
              items={VALUATION_ITEMS}
              value={valuationSource}
              onValueChange={(value) => setValuationSource(typeof value === "string" ? value : "")}
            >
              <SelectTrigger id="property-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {VALUATION_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save property"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

const VALIDATION_SOURCES = new Set(VALUATION_ITEMS.map((item) => item.value))

function MortgageFormDialog({
  property,
  mortgage,
  onClose,
}: {
  property: LedgerRecord
  mortgage: LedgerRecord | null
  onClose: () => void
}) {
  const { state, write } = useLedger()
  const accounts = asArray<LedgerRecord>(state?.accounts).filter((account) =>
    ["credit", "loan", "liability", "mortgage"].includes(
      String(account.type ?? "").toLowerCase()
    )
  )
  const components = asRecord(mortgage?.components)
  const propertyId = typeof property.id === "string" ? property.id : ""
  const ownershipBps = asCents(property.ownershipBps)
  const partialOwnership = ownershipBps !== null && ownershipBps < 10000

  const [lender, setLender] = useState(asText(mortgage?.lender, ""))
  const [loanType, setLoanType] = useState(asText(mortgage?.loanType, "fixed"))
  const [linkedAccountId, setLinkedAccountId] = useState(
    asText(mortgage?.linkedAccountId, "none")
  )
  const [statementBalance, setStatementBalance] = useState(() =>
    formatDollarsInput(asCents(mortgage?.statementBalance) ?? null)
  )
  const [balanceAsOf, setBalanceAsOf] = useState(asText(mortgage?.balanceAsOf, ""))
  const [originalPrincipal, setOriginalPrincipal] = useState(() =>
    formatDollarsInput(asCents(mortgage?.originalPrincipal) ?? null)
  )
  const [originationDate, setOriginationDate] = useState(asText(mortgage?.originationDate, ""))
  const [rate, setRate] = useState(asText(mortgage?.annualRatePercent, ""))
  const [termMonths, setTermMonths] = useState(
    asCents(mortgage?.termMonths) === null ? "" : String(mortgage?.termMonths)
  )
  const [debtShare, setDebtShare] = useState(() => {
    const bps = asCents(mortgage?.ownerDebtShareBps)
    if (bps !== null) return (bps / 100).toFixed(2)
    return partialOwnership ? "" : "100.00"
  })
  const [componentsInput, setComponentsInput] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of COMPONENT_FIELDS) {
      initial[field.key] = formatDollarsInput(asCents(components[field.key]) ?? null)
    }
    return initial
  })
  const [escrowed, setEscrowed] = useState(mortgage?.taxInsuranceEscrowed === true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const revision = state?.revision

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (!Number.isSafeInteger(revision) || !propertyId) {
      setError("Refresh this dashboard before saving a mortgage.")
      return
    }
    const balanceCents = statementBalance.trim() ? parseDollarsToCents(statementBalance) : null
    const principalCents = originalPrincipal.trim() ? parseDollarsToCents(originalPrincipal) : null
    const term = termMonths.trim() ? Number(termMonths) : null
    const debtShareBps = /^\d{1,3}(?:\.\d{1,2})?$/.test(debtShare.trim())
      ? Math.round(Number(debtShare) * 100)
      : -1
    if (balanceCents !== null && (!Number.isSafeInteger(balanceCents) || balanceCents < 0)) {
      setError("Enter a non-negative statement balance.")
      return
    }
    if (balanceCents !== null && !notFuture(balanceAsOf)) {
      setError("Choose a statement date that is not in the future.")
      return
    }
    if (originationDate && !/^\d{4}-\d{2}-\d{2}$/.test(originationDate)) {
      setError("Enter a valid origination date.")
      return
    }
    if (principalCents !== null && principalCents <= 0) {
      setError("Original principal must be greater than zero.")
      return
    }
    if (rate && (!/^\d{1,3}(?:\.\d{1,8})?$/.test(rate) || Number(rate) > 100)) {
      setError("Enter an annual note rate from 0 to 100 percent.")
      return
    }
    if (term !== null && (!Number.isSafeInteger(term) || term < 1 || term > 1200)) {
      setError("Choose a loan term from 1 to 1,200 months.")
      return
    }
    if (debtShareBps < 0 || debtShareBps > 10000) {
      setError(partialOwnership ? "Enter your explicit share of this loan." : "Enter a valid debt share.")
      return
    }
    const componentValues: Record<string, number | null> = {}
    for (const field of COMPONENT_FIELDS) {
      const raw = componentsInput[field.key] ?? ""
      const centsValue = raw.trim() ? parseDollarsToCents(raw) : null
      if (centsValue === null && raw.trim()) {
        setError(`Enter a valid amount for ${field.label.toLowerCase()}.`)
        return
      }
      componentValues[field.key] = centsValue !== null && centsValue < 0 ? null : centsValue
    }

    const input: Record<string, unknown> = {
      propertyId,
      lender: lender.trim(),
      loanType,
      linkedAccountId: linkedAccountId === "none" ? null : linkedAccountId,
      statementBalance: balanceCents,
      balanceAsOf: balanceCents === null ? null : balanceAsOf,
      originalPrincipal: principalCents,
      originationDate: originationDate || null,
      annualRatePercent: rate || null,
      termMonths: term,
      ownerDebtShareBps: debtShareBps,
      components: componentValues,
      taxInsuranceEscrowed: escrowed,
      revision,
    }
    if (mortgage && typeof mortgage.id === "string") input.id = mortgage.id
    setSaving(true)
    try {
      await write("mortgage", input)
      showSaved(mortgage ? "Mortgage updated." : "Mortgage recorded.")
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this mortgage.")
    } finally {
      setSaving(false)
    }
  }

  const accountItems = [
    { value: "none", label: "No linked liability account" },
    ...accounts.map((account) => ({
      value: String(account.id),
      label: `${asText(account.name, "Liability account")} · ${asText(account.type, "liability")}`,
    })),
  ]

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{mortgage ? "Edit mortgage / lien" : "Add mortgage / lien"}</DialogTitle>
        <DialogDescription>
          Observed statement balances stay separate from modeled amortization. Projections
          never replace a lender statement.
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="mortgage-lender">Lender label</FieldLabel>
            <Input id="mortgage-lender" value={lender} maxLength={100} onChange={(event) => setLender(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="mortgage-type">Loan type</FieldLabel>
            <Select items={LOAN_ITEMS} value={loanType} onValueChange={(value) => setLoanType(typeof value === "string" ? value : "fixed")}>
              <SelectTrigger id="mortgage-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {LOAN_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="mortgage-account">Linked liability account</FieldLabel>
            <Select items={accountItems} value={linkedAccountId} onValueChange={(value) => setLinkedAccountId(typeof value === "string" ? value : "none")}>
              <SelectTrigger id="mortgage-account" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {accountItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="mortgage-balance">Statement balance (USD)</FieldLabel>
            <Input id="mortgage-balance" inputMode="decimal" value={statementBalance} onChange={(event) => setStatementBalance(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="mortgage-balance-date">Statement date</FieldLabel>
            <Input id="mortgage-balance-date" type="date" value={balanceAsOf} onChange={(event) => setBalanceAsOf(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="mortgage-original">Original principal (USD)</FieldLabel>
            <Input id="mortgage-original" inputMode="decimal" value={originalPrincipal} onChange={(event) => setOriginalPrincipal(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="mortgage-origination">Origination date</FieldLabel>
            <Input id="mortgage-origination" type="date" value={originationDate} onChange={(event) => setOriginationDate(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="mortgage-rate">Annual note rate (%)</FieldLabel>
            <Input id="mortgage-rate" inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="mortgage-term">Loan term (months)</FieldLabel>
            <Input id="mortgage-term" type="number" min={1} max={1200} step={1} value={termMonths} onChange={(event) => setTermMonths(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="mortgage-share">Your share of this loan (%)</FieldLabel>
            <Input
              id="mortgage-share"
              inputMode="decimal"
              value={debtShare}
              placeholder={partialOwnership ? "Required for partial ownership" : "100.00"}
              onChange={(event) => setDebtShare(event.target.value)}
            />
            {partialOwnership ? (
              <FieldDescription>Required because this property is partly owned.</FieldDescription>
            ) : null}
          </Field>
        </div>
        <fieldset className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium">Recorded monthly components</legend>
          {COMPONENT_FIELDS.map((field) => (
            <Field key={field.key}>
              <FieldLabel htmlFor={`component-${field.key}`}>{field.label}</FieldLabel>
              <Input
                id={`component-${field.key}`}
                inputMode="decimal"
                value={componentsInput[field.key] ?? ""}
                onChange={(event) =>
                  setComponentsInput((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
              />
            </Field>
          ))}
        </fieldset>
        <Field orientation="horizontal">
          <Checkbox id="mortgage-escrow" checked={escrowed} onCheckedChange={(checked) => setEscrowed(checked === true)} />
          <FieldLabel htmlFor="mortgage-escrow">Tax and insurance are escrowed</FieldLabel>
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save mortgage"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function MortgageProjectionDialog({ mortgage }: { mortgage: LedgerRecord }) {
  const { state, preview, profile, write } = useLedger()
  const [projection, setProjection] = useState<LedgerRecord>(asRecord(mortgage.projection))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const revision = state?.revision
  const canRefresh =
    !preview &&
    profile !== "combined" &&
    Number.isSafeInteger(revision) &&
    typeof mortgage.id === "string"

  async function refresh() {
    if (!canRefresh || typeof mortgage.id !== "string") return
    setLoading(true)
    setError(null)
    try {
      const result = asRecord(await write("mortgage-projection", { id: mortgage.id, revision }))
      setProjection(asRecord(result.projection))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not refresh this projection.")
    } finally {
      setLoading(false)
    }
  }

  const unavailable =
    "Projection unavailable for this loan type or incomplete original terms."
  const available = projection.available === true
  const base = asRecord(projection.base)
  const extra = asRecord(projection.extra)

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Mortgage projection</DialogTitle>
        <DialogDescription>
          Fixed-rate monthly amortization with cent rounding. Modelled payments are not
          lender statements or payoff quotes.
        </DialogDescription>
      </DialogHeader>
      {available ? (
        <Accordion>
          <AccordionItem value="base">
            <AccordionTrigger>Base projection</AccordionTrigger>
            <AccordionContent>
              <dl className="flex flex-col gap-2">
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Payment</dt><dd>{formatCents(asCents(base.payment))}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Total interest</dt><dd>{formatCents(asCents(base.totalInterest))}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Term used</dt><dd>{metric(base.termMonths, "number")} months</dd></div>
              </dl>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="extra">
            <AccordionTrigger>With recorded extra principal</AccordionTrigger>
            <AccordionContent>
              <dl className="flex flex-col gap-2">
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Interest saved</dt><dd>{formatCents(asCents(projection.interestSaved))}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Months saved</dt><dd>{metric(projection.monthsSaved, "number")}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Payment with extra principal</dt><dd>{formatCents(asCents(extra.payment))}</dd></div>
              </dl>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>{unavailable}</AlertTitle>
          <AlertDescription>{asText(projection.reason, unavailable)}</AlertDescription>
        </Alert>
      )}
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <DialogFooter showCloseButton>
        <Button type="button" variant="outline" onClick={() => void refresh()} disabled={!canRefresh || loading}>
          <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" />
          {loading ? "Refreshing…" : "Refresh projection"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

type ScenarioDialogState = { mode: "create" } | { mode: "edit"; scenario: LedgerRecord } | null

function ScenarioFormDialog({
  scenario,
  goals,
  onClose,
}: {
  scenario: LedgerRecord | null
  goals: ReadonlyArray<LedgerRecord>
  onClose: () => void
}) {
  const { profile, preview, state, write } = useLedger()
  const input = asRecord(scenario?.inputs)
  const [name, setName] = useState(
    asText(scenario?.name ?? input.name, "")
  )
  const [money, setMoney] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of SCENARIO_MONEY_FIELDS) {
      const value = asCents(input[field.key])
      initial[field.key] = value === null ? (field.required ? "0.00" : "") : formatDollarsInput(value)
    }
    return initial
  })
  const [termMonths, setTermMonths] = useState(
    asCents(input.termMonths) === null ? "360" : String(input.termMonths)
  )
  const [rate, setRate] = useState(asText(input.noteRatePercent, "6.5"))
  const [rateAsOf, setRateAsOf] = useState(asText(input.rateAsOf, new Date().toISOString().slice(0, 10)))
  const [rateSource, setRateSource] = useState(asText(input.rateSource, "Manual assumption"))
  const [quoteType, setQuoteType] = useState(asText(input.quoteType, "estimate"))
  const [targetDate, setTargetDate] = useState(asText(input.targetDate, ""))
  const [noPmi, setNoPmi] = useState(input.pmiExplicitNone === true)
  const [taxEscrowed, setTaxEscrowed] = useState(input.taxEscrowed === true)
  const [insuranceEscrowed, setInsuranceEscrowed] = useState(input.insuranceEscrowed === true)
  const [replaceHousing, setReplaceHousing] = useState(input.replaceCurrentHousing === true)
  const [netIncome, setNetIncome] = useState(() => formatDollarsInput(asCents(input.netMonthlyIncome) ?? null))
  const [grossIncome, setGrossIncome] = useState(() => formatDollarsInput(asCents(input.grossMonthlyIncome) ?? null))
  const [linkedGoalId, setLinkedGoalId] = useState(
    asText(scenario?.linkedGoalId ?? input.linkedGoalId, "none")
  )
  const [previewResult, setPreviewResult] = useState<LedgerRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const revision = state?.revision
  const canWrite = !preview && Number.isSafeInteger(revision) && isOwner(profile)

  function buildInput() {
    const payload: Record<string, unknown> = {
      name: name.trim(),
      termMonths: Number(termMonths),
      noteRatePercent: rate.trim(),
      pmiExplicitNone: noPmi,
      taxEscrowed,
      insuranceEscrowed,
      replaceCurrentHousing: replaceHousing,
      targetDate: targetDate || null,
      rateSource: rateSource.trim(),
      rateAsOf,
      quoteType,
      linkedGoalId: linkedGoalId === "none" ? null : linkedGoalId,
      netMonthlyIncome: netIncome.trim() ? parseDollarsToCents(netIncome) : null,
      grossMonthlyIncome: grossIncome.trim() ? parseDollarsToCents(grossIncome) : null,
    }
    for (const field of SCENARIO_MONEY_FIELDS) {
      const value = money[field.key]?.trim() ? parseDollarsToCents(money[field.key] ?? "") : null
      payload[field.key] = value
    }
    return payload
  }

  function validate(payload: Record<string, unknown>) {
    if (!name.trim() || name.trim().length > 100) return "Enter a scenario name up to 100 characters."
    const purchase = asCents(payload.purchasePrice)
    const down = asCents(payload.downPayment)
    if (purchase === null || purchase <= 0 || down === null || down < 0 || down > purchase) {
      return "Down payment must be between zero and the purchase price."
    }
    for (const field of SCENARIO_MONEY_FIELDS) {
      if (field.required && asCents(payload[field.key]) === null) {
        return `Enter ${field.label.toLowerCase()} in dollars; use 0 when none applies.`
      }
    }
    if (!noPmi && asCents(payload.pmiMonthly) === null) {
      return "Enter a monthly PMI estimate or select no PMI."
    }
    const term = payload.termMonths
    if (!Number.isSafeInteger(term) || (term as number) < 1 || (term as number) > 1200) {
      return "Choose a loan term from 1 to 1,200 months."
    }
    const rateText = String(payload.noteRatePercent ?? "")
    if (!/^\d{1,3}(?:\.\d{1,8})?$/.test(rateText) || Number(rateText) > 100) {
      return "Enter a note rate from 0 to 100 percent."
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rateAsOf)) return "Enter the date of this rate assumption."
    if (!rateSource.trim() || rateSource.trim().length > 120) return "Enter a rate source up to 120 characters."
    if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return "Enter a valid target date."
    return null
  }

  async function calculatePreview() {
    setError(null)
    const payload = buildInput()
    const problem = validate(payload)
    if (problem) {
      setError(problem)
      return
    }
    if (!canWrite) {
      setError("Switch to Peter, Maddie, or Joint to calculate a scenario.")
      return
    }
    setSaving(true)
    try {
      const result = asRecord(await write("scenario-calculate", { input: payload }))
      setPreviewResult(asRecord(result.result))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not calculate this scenario.")
    } finally {
      setSaving(false)
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const payload = buildInput()
    const problem = validate(payload)
    if (problem) {
      setError(problem)
      return
    }
    if (!canWrite) {
      setError("Switch to Peter, Maddie, or Joint to save a scenario.")
      return
    }
    const inputPayload: Record<string, unknown> = {
      input: payload,
      profileId: profile,
      revision,
    }
    if (scenario && typeof scenario.id === "string") inputPayload.id = scenario.id
    setSaving(true)
    try {
      await write("scenario", inputPayload)
      showSaved(scenario ? "Scenario updated." : "Scenario saved.")
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this scenario.")
    } finally {
      setSaving(false)
    }
  }

  const goalItems = [
    { value: "none", label: "No linked goal" },
    ...goals.map((goal) => ({
      value: String(goal.id),
      label: asText(goal.name, "Savings goal"),
    })),
  ]

  return (
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{scenario ? "Edit scenario" : "New purchase scenario"}</DialogTitle>
        <DialogDescription>
          Hypothetical purchase details only. Preview the calculation before saving;
          nothing here changes owned property, actual net worth, or budgets.
        </DialogDescription>
      </DialogHeader>
      <form className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1" onSubmit={(event) => void save(event)}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="scenario-name">Scenario name</FieldLabel>
            <Input id="scenario-name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="scenario-goal">Link savings goal</FieldLabel>
            <Select items={goalItems} value={linkedGoalId} onValueChange={(value) => setLinkedGoalId(typeof value === "string" ? value : "none")}>
              <SelectTrigger id="scenario-goal" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {goalItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {SCENARIO_MONEY_FIELDS.map((field) => (
            <Field key={field.key}>
              <FieldLabel htmlFor={`scenario-${field.key}`}>{field.label} (USD)</FieldLabel>
              <Input
                id={`scenario-${field.key}`}
                inputMode="decimal"
                value={money[field.key] ?? ""}
                onChange={(event) =>
                  setMoney((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
            </Field>
          ))}
          <Field>
            <FieldLabel htmlFor="scenario-term">Loan term (months)</FieldLabel>
            <Input id="scenario-term" type="number" min={1} max={1200} step={1} value={termMonths} onChange={(event) => setTermMonths(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="scenario-rate">Note rate (%)</FieldLabel>
            <Input id="scenario-rate" inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="scenario-rate-date">Rate assumption date</FieldLabel>
            <Input id="scenario-rate-date" type="date" value={rateAsOf} onChange={(event) => setRateAsOf(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="scenario-rate-source">Rate source</FieldLabel>
            <Input id="scenario-rate-source" value={rateSource} maxLength={120} onChange={(event) => setRateSource(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="scenario-quote-type">Quote type</FieldLabel>
            <Select
              items={[{ value: "estimate", label: "Estimate" }, { value: "quote", label: "Lender quote" }]}
              value={quoteType}
              onValueChange={(value) => setQuoteType(typeof value === "string" ? value : "estimate")}
            >
              <SelectTrigger id="scenario-quote-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="estimate">Estimate</SelectItem>
                  <SelectItem value="quote">Lender quote</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="scenario-target-date">Target date</FieldLabel>
            <Input id="scenario-target-date" type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="scenario-net">Net monthly income (USD)</FieldLabel>
            <Input id="scenario-net" inputMode="decimal" value={netIncome} onChange={(event) => setNetIncome(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="scenario-gross">Gross monthly income (USD)</FieldLabel>
            <Input id="scenario-gross" inputMode="decimal" value={grossIncome} onChange={(event) => setGrossIncome(event.target.value)} />
          </Field>
        </div>
        <fieldset className="flex flex-wrap gap-4 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Assumptions</legend>
          <Field orientation="horizontal">
            <Checkbox id="scenario-no-pmi" checked={noPmi} onCheckedChange={(checked) => setNoPmi(checked === true)} />
            <FieldLabel htmlFor="scenario-no-pmi">No PMI</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="scenario-tax-escrow" checked={taxEscrowed} onCheckedChange={(checked) => setTaxEscrowed(checked === true)} />
            <FieldLabel htmlFor="scenario-tax-escrow">Taxes escrowed</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="scenario-insurance-escrow" checked={insuranceEscrowed} onCheckedChange={(checked) => setInsuranceEscrowed(checked === true)} />
            <FieldLabel htmlFor="scenario-insurance-escrow">Insurance escrowed</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="scenario-replace" checked={replaceHousing} onCheckedChange={(checked) => setReplaceHousing(checked === true)} />
            <FieldLabel htmlFor="scenario-replace">Replaces current housing</FieldLabel>
          </Field>
        </fieldset>
        {previewResult ? (
          <Alert>
            <HugeiconsIcon icon={Alert02Icon} />
            <AlertTitle>Preview result</AlertTitle>
            <AlertDescription className="grid gap-2 sm:grid-cols-2">
              {SCENARIO_OUTPUT_FIELDS.slice(0, 6).map((field) => (
                <span key={field.key}>
                  {field.label}: <strong data-numeric className="tabular-nums">{metric(previewResult[field.key], field.kind)}</strong>
                </span>
              ))}
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="outline" onClick={() => void calculatePreview()} disabled={saving || !canWrite}>
            Preview calculation
          </Button>
          <Button type="submit" disabled={saving || !canWrite}>{saving ? "Saving…" : "Save scenario"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function RenameScenarioDialog({
  scenario,
  onClose,
}: {
  scenario: LedgerRecord
  onClose: () => void
}) {
  const { state, preview, profile, write } = useLedger()
  const [name, setName] = useState(asText(scenario.name, ""))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const revision = state?.revision
  const canWrite =
    !preview && profile !== "combined" && Number.isSafeInteger(revision)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (!canWrite || typeof scenario.id !== "string") return
    setSaving(true)
    try {
      await write("scenario", { action: "rename", id: scenario.id, name: name.trim(), revision })
      showSaved("Scenario renamed.")
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rename this scenario.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Rename scenario</DialogTitle>
        <DialogDescription>Give this saved estimate a clearer name.</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <Field>
          <FieldLabel htmlFor="scenario-rename">Name</FieldLabel>
          <Input id="scenario-rename" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving || !canWrite}>Save name</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function LinkGoalDialog({
  scenario,
  goals,
  onClose,
}: {
  scenario: LedgerRecord
  goals: ReadonlyArray<LedgerRecord>
  onClose: () => void
}) {
  const { state, preview, profile, write } = useLedger()
  const [goalId, setGoalId] = useState(asText(scenario.linkedGoalId, "none"))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const revision = state?.revision
  const canWrite =
    !preview && profile !== "combined" && Number.isSafeInteger(revision)
  const goalItems = [
    { value: "none", label: "No linked goal" },
    ...goals.map((goal) => ({
      value: String(goal.id),
      label: asText(goal.name, "Savings goal"),
    })),
  ]

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (!canWrite || typeof scenario.id !== "string") return
    const input: Record<string, unknown> = {
      scenarioId: scenario.id,
      profileId: scenario.profileId,
      revision,
    }
    if (scenario.linkedGoalId) {
      input.action = "update"
    } else if (goalId !== "none") {
      input.linkedGoalId = goalId
    }
    setSaving(true)
    try {
      await write("scenario-goal", input)
      showSaved(scenario.linkedGoalId ? "Linked goal target updated." : "Down-payment goal created.")
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not link a goal.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Link a savings goal</DialogTitle>
        <DialogDescription>
          {scenario.linkedGoalId
            ? "Propose this scenario’s target as the new target for the linked goal."
            : "Create a down-payment goal from this saved scenario."}
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {scenario.linkedGoalId ? null : (
          <Field>
            <FieldLabel htmlFor="link-goal">Goal</FieldLabel>
            <Select items={goalItems} value={goalId} onValueChange={(value) => setGoalId(typeof value === "string" ? value : "none")}>
              <SelectTrigger id="link-goal" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {goalItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving || !canWrite}>
            {scenario.linkedGoalId ? "Update goal target" : "Create goal"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

export function HomePage() {
  const { state, profile, preview, write } = useLedger()
  const [propertyDialog, setPropertyDialog] = useState<
    { mode: "create" } | { mode: "edit"; property: LedgerRecord } | null
  >(null)
  const [mortgageDialog, setMortgageDialog] = useState<{
    property: LedgerRecord
    mortgage: LedgerRecord | null
  } | null>(null)
  const [projectionMortgage, setProjectionMortgage] = useState<LedgerRecord | null>(null)
  const [archiveProperty, setArchiveProperty] = useState<LedgerRecord | null>(null)
  const [archiveMortgage, setArchiveMortgage] = useState<LedgerRecord | null>(null)
  const [scenarioDialog, setScenarioDialog] = useState<ScenarioDialogState>(null)
  const [renameScenario, setRenameScenario] = useState<LedgerRecord | null>(null)
  const [linkScenario, setLinkScenario] = useState<LedgerRecord | null>(null)
  const [archiveScenario, setArchiveScenario] = useState<LedgerRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const revision = state?.revision
  const canWrite = !preview && profile !== "combined" && Number.isSafeInteger(revision)

  const propertySummary = asRecord(state?.propertySummary)
  const summaryProperties = asArray<LedgerRecord>(propertySummary.properties)
  const rawProperties = asArray<LedgerRecord>(state?.properties)
  const rawMortgages = asArray<LedgerRecord>(state?.mortgages)
  const properties = summaryProperties.length > 0 ? summaryProperties : rawProperties
  const scenarios = asArray<LedgerRecord>(state?.scenarios)
  const goals = asArray<LedgerRecord>(state?.goals).filter(
    (goal) => !goal.archivedAt && goal.profileId === profile
  )

  const balanceSheet = asRecord(state?.balanceSheet)
  const totals = asRecord(balanceSheet.totals)
  const incomplete = balanceSheet.incomplete === true
  const netWorthLabel =
    typeof balanceSheet.netWorthLabel === "string"
      ? balanceSheet.netWorthLabel
      : incomplete
        ? "Known net worth · partial coverage"
        : "Net worth (from the accounts you have entered)"
  const featured = asRecord(
    asRecord(balanceSheet.featured).label
      ? balanceSheet.featured
      : asRecord(state?.featured).label
        ? state?.featured
        : undefined
  )

  async function runAction(path: string, input: Record<string, unknown>, message: string) {
    if (!canWrite) return
    setBusy(true)
    setActionError(null)
    try {
      await write(path, { ...input, revision })
      showSaved(message)
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : "Could not complete this action."
      setActionError(text)
      showError(text)
    } finally {
      setBusy(false)
    }
  }

  async function snapshot() {
    if (!canWrite) return
    await runAction("balance-snapshot", { viewProfile: profile }, "Balance snapshot recorded.")
  }

  function propertyCard(property: LedgerRecord) {
    const propertyId = typeof property.id === "string" ? property.id : ""
    const mortgages = asArray<LedgerRecord>(property.mortgages)
    const ownership = asCents(property.ownershipBps)
    return (
      <Card key={propertyId} size="sm" className="min-w-0">
        <CardHeader>
          <div className="flex min-w-0 flex-col gap-2">
            <CardTitle>{asText(property.name, "Untitled property")}</CardTitle>
            <CardDescription>
              {asText(property.address, "No address recorded")} ·{" "}
              {profileOf(property.profileId)} ·{" "}
              {ownership === null ? "Ownership not recorded" : `${(ownership / 100).toFixed(2)}% ownership`}
            </CardDescription>
          </div>
          <CardAction className="flex flex-wrap items-center gap-2">
            <Badge variant={property.debtComplete === true ? "secondary" : "outline"}>
              {property.debtComplete === true ? "Debt observed" : "Incomplete debt"}
            </Badge>
            {property.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
          </CardAction>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Valuation</p>
              <p data-numeric className="font-medium tabular-nums">
                {formatCents(asCents(property.valuation))}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Valued</p>
              <p className="font-medium">{asDate(property.valuationAsOf)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Source</p>
              <p className="font-medium">{asText(property.valuationSource)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Owner equity</p>
              <p data-numeric className="font-medium tabular-nums">
                {formatCents(asCents(property.ownerEquity))}
              </p>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setPropertyDialog({ mode: "edit", property })} disabled={!canWrite}>
              <HugeiconsIcon icon={Edit02Icon} data-icon="inline-start" />
              Edit
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setMortgageDialog({ property, mortgage: null })} disabled={!canWrite}>
              <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
              Add mortgage
            </Button>
            {property.archivedAt ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void runAction("property", { action: "restore", id: propertyId }, "Property restored.")}
                disabled={!canWrite || busy}
              >
                <HugeiconsIcon icon={Unarchive03Icon} data-icon="inline-start" />
                Restore
              </Button>
            ) : (
              <Button type="button" size="sm" variant="destructive" onClick={() => setArchiveProperty(property)} disabled={!canWrite}>
                <HugeiconsIcon icon={ArchiveIcon} data-icon="inline-start" />
                Archive
              </Button>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm font-medium">Mortgages and liens</p>
            {mortgages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active lien records. Add each loan so equity includes all property debt.</p>
            ) : (
              mortgages.map((mortgage) => {
                const mortgageId = typeof mortgage.id === "string" ? mortgage.id : ""
                const projection = asRecord(mortgage.projection)
                return (
                  <div key={mortgageId} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium">{asText(mortgage.lender, "Mortgage / lien")}</p>
                        <p className="text-xs text-muted-foreground">
                          {asText(mortgage.loanType).replaceAll("_", " ")} · Statement {asDate(mortgage.balanceAsOf)} ·{" "}
                          {asText(asRecord(mortgage.linkedAccount).name, "No linked account")}
                        </p>
                      </div>
                      <p data-numeric className="font-medium tabular-nums">
                        {formatCents(asCents(mortgage.statementBalance))}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Projected payment:{" "}
                      {projection.available === true
                        ? formatCents(asCents(asRecord(projection.base).payment))
                        : "Projection unavailable for this loan type or incomplete original terms."}
                    </p>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => setProjectionMortgage(mortgage)}>
                        Projection
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setMortgageDialog({ property, mortgage })}
                        disabled={!canWrite}
                      >
                        <HugeiconsIcon icon={Edit02Icon} data-icon="inline-start" />
                        Edit loan
                      </Button>
                      <Button type="button" size="sm" variant="destructive" onClick={() => setArchiveMortgage(mortgage)} disabled={!canWrite}>
                        Archive loan
                      </Button>
                    </div>
                  </div>
                )
              })
            )}
            {rawMortgages
              .filter((mortgage) => mortgage.propertyId === propertyId && mortgage.archivedAt)
              .map((mortgage) => (
                <div key={String(mortgage.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3">
                  <span className="text-sm">{asText(mortgage.lender, "Archived mortgage")} · Archived</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void runAction("mortgage", { action: "restore", id: String(mortgage.id) }, "Mortgage restored.")}
                    disabled={!canWrite || busy}
                  >
                    Restore loan
                  </Button>
                </div>
              ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  function scenarioCard(scenario: LedgerRecord) {
    const scenarioId = typeof scenario.id === "string" ? scenario.id : ""
    const result = asRecord(scenario.result)
    const savedInputs = asRecord(scenario.inputs)
    const ownedScenario = scenario.profileId === profile
    return (
      <Card key={scenarioId} size="sm" className="min-w-0">
        <CardHeader>
          <div className="flex min-w-0 flex-col gap-2">
            <CardTitle>{asText(scenario.name, "Untitled scenario")}</CardTitle>
            <CardDescription>
              Saved {asDate(scenario.updatedAt)} · calculation {asText(scenario.calculationVersion, "unknown")} ·{" "}
              {profileOf(scenario.profileId)}
              {scenario.linkedGoalId ? " · Linked savings goal" : ""}
            </CardDescription>
          </div>
          <CardAction className="flex flex-wrap items-center gap-2">
            {scenario.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
            <Badge variant="secondary">Hypothetical</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {SCENARIO_OUTPUT_FIELDS.map((field) => (
              <div key={field.key}>
                <p className="text-xs text-muted-foreground">{field.label}</p>
                <p data-numeric className="font-medium tabular-nums">
                  {metric(result[field.key], field.kind)}
                </p>
              </div>
            ))}
          </div>
          <Accordion>
            <AccordionItem value={`scenario-${scenarioId}`}>
              <AccordionTrigger>Scenario inputs and technical result</AccordionTrigger>
              <AccordionContent>
                <dl className="flex flex-col gap-2">
                  {[
                    ["purchasePrice", "Purchase price", "cents"],
                    ["downPayment", "Down payment", "cents"],
                    ["noteRatePercent", "Note rate", "text"],
                    ["termMonths", "Term (months)", "number"],
                    ["targetDate", "Target date", "text"],
                    ["rateAsOf", "Rate as of", "text"],
                    ["rateSource", "Rate source", "text"],
                  ].map(([key, label, kind]) => (
                    <div key={key} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd>{metric(savedInputs[key], kind as MetricKind)}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">
                  Calculation version {asText(result.calculationVersion, "unknown")}. Rate sensitivities
                  and monthly component detail remain in the saved result and are not used as
                  recorded property or budget values.
                </p>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setScenarioDialog({ mode: "edit", scenario })} disabled={!canWrite}>
              <HugeiconsIcon icon={Edit02Icon} data-icon="inline-start" />
              Edit
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void runAction("scenario", { action: "duplicate", id: scenarioId }, "Scenario duplicated.")}
              disabled={!canWrite || busy}
            >
              <HugeiconsIcon icon={Copy01Icon} data-icon="inline-start" />
              Duplicate
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setRenameScenario(scenario)} disabled={!canWrite}>
              Rename
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setLinkScenario(scenario)} disabled={!canWrite || !!scenario.archivedAt}>
              <HugeiconsIcon icon={Link01Icon} data-icon="inline-start" />
              {scenario.linkedGoalId ? "Update goal target" : "Link goal"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void runAction("scenario-budget", { scenarioId, profileId: profile }, "Housing budget set from this scenario.")}
              disabled={!canWrite || !ownedScenario || busy || !!scenario.archivedAt}
              title={ownedScenario ? undefined : "Switch to the scenario’s profile to apply it."}
            >
              Apply to budget
            </Button>
            {scenario.archivedAt ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void runAction("scenario", { action: "restore", id: scenarioId }, "Scenario restored.")}
                disabled={!canWrite || busy}
              >
                Restore
              </Button>
            ) : (
              <Button type="button" size="sm" variant="destructive" onClick={() => setArchiveScenario(scenario)} disabled={!canWrite}>
                Archive
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <PageShell
      title="Home planner"
      description="Record a property or compare a hypothetical purchase."
      actions={
        <Button type="button" onClick={() => setPropertyDialog({ mode: "create" })} disabled={!canWrite}>
          <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
          Add property
        </Button>
      }
    >
      {profile === "combined" ? (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Switch profile to make changes</AlertTitle>
          <AlertDescription>
            Property, mortgage, scenario, and snapshot writes are disabled in the combined
            view. Choose Peter, Maddie, or Joint to record changes.
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

      <Card className={cn("min-w-0", incomplete && "ring-1")}>
        <CardHeader>
          <div className="flex min-w-0 flex-col gap-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{netWorthLabel}</CardTitle>
            <p data-numeric className="text-3xl font-semibold tracking-tight tabular-nums">
              {formatCents(asCents(totals.netWorth))}
            </p>
          </div>
          <CardAction className="flex flex-wrap items-start gap-2">
            <Badge variant={incomplete ? "outline" : "secondary"}>
              {incomplete ? "Partial coverage" : "Featured metric"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Cash {formatCents(asCents(totals.cash))} · Investments {formatCents(asCents(totals.investments))} ·
            Property {formatCents(asCents(totals.property))} · Debts {formatCents(asCents(totals.liabilities))}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => void snapshot()} disabled={!canWrite || busy}>
            <HugeiconsIcon icon={Wallet01Icon} data-icon="inline-start" />
            Balance snapshot
          </Button>
        </CardContent>
      </Card>

      {Object.keys(featured).length > 0 ? (
        <Card size="sm" className="min-w-0">
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Featured metric</CardTitle>
            <CardAction><Badge>Featured</Badge></CardAction>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-wrap items-baseline justify-between gap-3">
            <span className="font-medium">{asText(featured.label, "Featured")}</span>
            <span data-numeric className="text-xl font-semibold tabular-nums">
              {metric(featured.value, (asText(featured.kind, "cents") as MetricKind))}
            </span>
            {featured.note ? <span className="text-xs text-muted-foreground">{asText(featured.note)}</span> : null}
          </CardContent>
        </Card>
      ) : null}

      <section aria-label="Owned property" className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <HugeiconsIcon icon={Home01Icon} className="size-4" />
              Owned property and debt
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Observed valuations and statement balances are kept separate from modeled loan schedules.
              Mortgage projections use monthly fixed-rate amortization and may differ from lender servicing.
            </p>
          </div>
          <Badge variant="outline">
            {properties.length} {properties.length === 1 ? "property" : "properties"} ·{" "}
            {rawMortgages.filter((mortgage) => !mortgage.archivedAt).length} active liens
          </Badge>
        </div>
        {properties.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No properties recorded</EmptyTitle>
              <EmptyDescription>
                Add an owned property to track its valuation, ownership share, and observed equity.
                Hypothetical purchases belong in scenarios.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" onClick={() => setPropertyDialog({ mode: "create" })} disabled={!canWrite}>
                <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
                Add property
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          properties.map(propertyCard)
        )}
      </section>

      <section aria-label="Purchase scenarios" className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <HugeiconsIcon icon={Calendar03Icon} className="size-4" />
              Hypothetical purchase scenarios
            </h2>
            <Alert className="max-w-2xl">
              <HugeiconsIcon icon={Alert02Icon} />
              <AlertTitle>Hypothetical only</AlertTitle>
              <AlertDescription>
                Scenarios do not change owned property, actual net worth, or budgets unless
                you explicitly apply one.
              </AlertDescription>
            </Alert>
          </div>
          <Button type="button" size="sm" onClick={() => setScenarioDialog({ mode: "create" })} disabled={!canWrite}>
            <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" />
            New scenario
          </Button>
        </div>
        {scenarios.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No scenarios saved yet</EmptyTitle>
              <EmptyDescription>
                Compare hypothetical purchase costs without adding a property to your real balance sheet.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          scenarios.map(scenarioCard)
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Household, Peter, Maddie, and Joint are organisational views, not a privacy boundary.
      </p>

      <Dialog open={propertyDialog !== null} onOpenChange={(open) => { if (!open) setPropertyDialog(null) }}>
        {propertyDialog ? (
          <PropertyFormDialog
            property={propertyDialog.mode === "edit" ? propertyDialog.property : null}
            onClose={() => setPropertyDialog(null)}
          />
        ) : null}
      </Dialog>

      <Dialog open={mortgageDialog !== null} onOpenChange={(open) => { if (!open) setMortgageDialog(null) }}>
        {mortgageDialog ? (
          <MortgageFormDialog
            property={mortgageDialog.property}
            mortgage={mortgageDialog.mortgage}
            onClose={() => setMortgageDialog(null)}
          />
        ) : null}
      </Dialog>

      <Dialog open={projectionMortgage !== null} onOpenChange={(open) => { if (!open) setProjectionMortgage(null) }}>
        {projectionMortgage ? (
          <MortgageProjectionDialog mortgage={projectionMortgage} />
        ) : null}
      </Dialog>

      <Dialog open={scenarioDialog !== null} onOpenChange={(open) => { if (!open) setScenarioDialog(null) }}>
        {scenarioDialog ? (
          <ScenarioFormDialog
            scenario={scenarioDialog.mode === "edit" ? scenarioDialog.scenario : null}
            goals={goals}
            onClose={() => setScenarioDialog(null)}
          />
        ) : null}
      </Dialog>

      <Dialog open={renameScenario !== null} onOpenChange={(open) => { if (!open) setRenameScenario(null) }}>
        {renameScenario ? (
          <RenameScenarioDialog scenario={renameScenario} onClose={() => setRenameScenario(null)} />
        ) : null}
      </Dialog>

      <Dialog open={linkScenario !== null} onOpenChange={(open) => { if (!open) setLinkScenario(null) }}>
        {linkScenario ? (
          <LinkGoalDialog
            scenario={linkScenario}
            goals={goals}
            onClose={() => setLinkScenario(null)}
          />
        ) : null}
      </Dialog>

      <AlertDialog open={archiveProperty !== null} onOpenChange={(open) => { if (!open) setArchiveProperty(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this property?</AlertDialogTitle>
            <AlertDialogDescription>
              {asText(archiveProperty?.name, "This property")} will be removed from active
              property totals. Its mortgages stay saved but stop contributing until restored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep property</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy || !canWrite}
              onClick={() => {
                if (typeof archiveProperty?.id === "string") {
                  void runAction("property", { action: "archive", id: archiveProperty.id }, "Property archived.")
                }
                setArchiveProperty(null)
              }}
            >
              Archive property
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={archiveMortgage !== null} onOpenChange={(open) => { if (!open) setArchiveMortgage(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this mortgage?</AlertDialogTitle>
            <AlertDialogDescription>
              The loan and its payment components will stop contributing to observed property debt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep loan</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy || !canWrite}
              onClick={() => {
                if (typeof archiveMortgage?.id === "string") {
                  void runAction("mortgage", { action: "archive", id: archiveMortgage.id }, "Mortgage archived.")
                }
                setArchiveMortgage(null)
              }}
            >
              Archive loan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={archiveScenario !== null} onOpenChange={(open) => { if (!open) setArchiveScenario(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this scenario?</AlertDialogTitle>
            <AlertDialogDescription>
              {asText(archiveScenario?.name, "This scenario")} will be hidden from active
              scenarios. Any applied budget or linked goal stays as it was.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep scenario</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy || !canWrite}
              onClick={() => {
                if (typeof archiveScenario?.id === "string") {
                  void runAction("scenario", { action: "archive", id: archiveScenario.id }, "Scenario archived.")
                }
                setArchiveScenario(null)
              }}
            >
              Archive scenario
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </PageShell>
  )
}
