import { useEffect, useMemo, useState, type FormEvent } from "react"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
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
import { type JsonObject } from "@/lib/api"
import {
  assertCents,
  asArray,
  formatDollarsInput,
  parseDollarsToCents,
  transactionCategory,
  type Category,
  type Transaction,
} from "@/lib/ledger"

const NONE = "none"

type Direction = "spent" | "received"

type Draft = {
  accountId: string
  date: string
  merchant: string
  amount: string
  direction: Direction
  categoryId: string
}

export type TransactionFormDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction?: Transaction | null
  defaultAccountId?: string
}

function localToday() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`
}

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "Ledger could not save this transaction."
}

export function TransactionFormDialog({
  open,
  onOpenChange,
  transaction,
  defaultAccountId,
}: TransactionFormDialogProps) {
  const { state, preview, write } = useLedger()
  const [draft, setDraft] = useState<Draft>({
    accountId: "",
    date: localToday(),
    merchant: "",
    amount: "",
    direction: "spent",
    categoryId: NONE,
  })
  const [errors, setErrors] = useState<string[]>([])
  const [pending, setPending] = useState(false)

  const categories = useMemo(
    () => asArray<Category>(state?.categoryCatalog).filter((category) => !category.archivedAt),
    [state?.categoryCatalog]
  )

  const manualAccounts = useMemo(() => {
    const accounts = asArray<NonNullable<typeof state>["accounts"][number]>(state?.accounts)
    return accounts.filter(
      (account) =>
        !account.archivedAt &&
        (account.manual === true || account.source === "manual" || account.source === "csv")
    )
  }, [state?.accounts])

  const accountItems = useMemo(
    () => [
      { value: NONE, label: "Choose an account" },
      ...manualAccounts.map((account) => ({ value: account.id, label: account.name })),
    ],
    [manualAccounts]
  )

  const categoryItems = useMemo(
    () => [
      { value: NONE, label: "Choose a category" },
      ...categories.map((category) => ({ value: category.id, label: category.name })),
    ],
    [categories]
  )

  const isEditing = !!transaction && transaction.source === "manual"
  const today = localToday()

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      const cents =
        transaction && Number.isSafeInteger(transaction.amount)
          ? Math.abs(Number(transaction.amount))
          : null
      const currentName = transaction ? transactionCategory(transaction) : ""
      const currentCategoryId =
        typeof transaction?.overrideCategoryId === "string" && transaction.overrideCategoryId
          ? transaction.overrideCategoryId
          : categories.find((category) => category.name === currentName)?.id ?? NONE

      setDraft({
        accountId: transaction?.accountId ?? defaultAccountId ?? NONE,
        date: transaction?.date?.slice(0, 10) || today,
        merchant: typeof transaction?.merchant === "string" ? transaction.merchant : "",
        amount: formatDollarsInput(cents),
        direction:
          transaction && Number.isSafeInteger(transaction.amount) && Number(transaction.amount) < 0
            ? "received"
            : "spent",
        categoryId: currentCategoryId,
      })
      setErrors(
        transaction && transaction.source !== "manual"
          ? ["Only transactions added by hand can be edited."]
          : []
      )
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open, transaction, defaultAccountId, categories, today])

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (preview || pending) return

    const nextErrors: string[] = []
    if (!draft.accountId || draft.accountId === NONE) nextErrors.push("Choose an account.")
    if (!draft.merchant.trim()) nextErrors.push("Enter what the transaction was for.")
    if (!draft.date || draft.date > today) nextErrors.push("Choose a date that is not in the future.")
    if (!draft.categoryId || draft.categoryId === NONE) nextErrors.push("Choose a category.")
    if (transaction && transaction.source !== "manual") {
      nextErrors.push("Only transactions added by hand can be edited.")
    }

    const cents = parseDollarsToCents(draft.amount)
    if (cents === null || cents <= 0) {
      nextErrors.push("Enter an amount greater than zero.")
    } else {
      try {
        assertCents(cents)
      } catch {
        nextErrors.push("Enter an amount in whole cents.")
      }
    }

    if (nextErrors.length) {
      setErrors(nextErrors)
      return
    }
    if (cents === null) return

    const selectedCategory = categories.find((category) => category.id === draft.categoryId)
    const input: JsonObject = {
      accountId: draft.accountId,
      date: draft.date,
      merchant: draft.merchant.trim(),
      amount: cents,
      direction: draft.direction,
      categoryId: draft.categoryId,
      category: selectedCategory?.name,
      ...(isEditing && transaction ? { id: transaction.id } : {}),
    }

    setPending(true)
    setErrors([])
    try {
      await write(isEditing ? "transaction-edit" : "transaction-add", input)
      toast.add({
        title: isEditing ? "Transaction updated" : "Transaction recorded",
        description: `${draft.merchant.trim()} · ${draft.date}`,
        type: "success",
      })
      onOpenChange(false)
    } catch (caught) {
      const message = errorMessage(caught)
      setErrors([message])
      toast.add({ title: "Could not save transaction", description: message, type: "error" })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit transaction" : "Add transaction"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the details of this manually recorded transaction."
              : "Record a transaction by hand."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
          {errors.length ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Check the transaction details</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="transaction-account">Account</FieldLabel>
              <Select
                items={accountItems}
                value={draft.accountId}
                onValueChange={(value) => update("accountId", String(value ?? NONE))}
                disabled={preview || pending}
              >
                <SelectTrigger id="transaction-account" aria-label="Account" className="w-full">
                  <SelectValue placeholder="Choose an account" />
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
              <FieldDescription>Only accounts you track by hand accept manual entries.</FieldDescription>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="transaction-date">Date</FieldLabel>
                <Input
                  id="transaction-date"
                  type="date"
                  max={today}
                  value={draft.date}
                  onChange={(event) => update("date", event.target.value)}
                  disabled={preview || pending}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="transaction-amount">Amount</FieldLabel>
                <Input
                  id="transaction-amount"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={draft.amount}
                  onChange={(event) => update("amount", event.target.value)}
                  disabled={preview || pending}
                />
                <FieldDescription>Enter a positive amount and choose the direction below.</FieldDescription>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="transaction-merchant">Merchant</FieldLabel>
              <Input
                id="transaction-merchant"
                type="text"
                maxLength={100}
                placeholder="What was this for?"
                value={draft.merchant}
                onChange={(event) => update("merchant", event.target.value)}
                disabled={preview || pending}
              />
            </Field>

            <Field>
              <FieldLabel>Direction</FieldLabel>
              <RadioGroup
                value={draft.direction}
                onValueChange={(value) => update("direction", value === "received" ? "received" : "spent")}
                disabled={preview || pending}
              >
                <Field orientation="horizontal">
                  <RadioGroupItem value="spent" id="transaction-direction-spent" />
                  <FieldLabel htmlFor="transaction-direction-spent" className="font-normal">
                    Money spent
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <RadioGroupItem value="received" id="transaction-direction-received" />
                  <FieldLabel htmlFor="transaction-direction-received" className="font-normal">
                    Money received
                  </FieldLabel>
                </Field>
              </RadioGroup>
            </Field>

            <Field>
              <FieldLabel htmlFor="transaction-category">Category</FieldLabel>
              <Select
                items={categoryItems}
                value={draft.categoryId}
                onValueChange={(value) => update("categoryId", String(value ?? NONE))}
                disabled={preview || pending}
              >
                <SelectTrigger id="transaction-category" aria-label="Category" className="w-full">
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
              <FieldDescription>
                This records the transaction. It does not change the saved account balance.
              </FieldDescription>
            </Field>
          </FieldGroup>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button
              type="submit"
              disabled={preview || pending}
              title={
                preview
                  ? "Changes cannot be saved in the synthetic preview."
                  : pending
                    ? "Saving…"
                    : undefined
              }
            >
              {pending ? "Saving…" : isEditing ? "Save changes" : "Record transaction"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
