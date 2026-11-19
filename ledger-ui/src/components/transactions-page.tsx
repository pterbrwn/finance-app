import { useRef, useState, type ChangeEvent } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileExportIcon,
  FileImportIcon,
  ListChecksIcon,
  ListSettingIcon,
  MoreHorizontalIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons"
import {
  createColumnHelper,
  type ColumnDef,
  type RowSelectionState,
} from "@tanstack/react-table"

import { DataTable, SortableHeader } from "@/components/data-table"
import type { DataTableFeatures } from "@/components/data-table-features"
import { PageShell } from "@/components/page-shell"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toast } from "@/components/ui/toast"
import { useLedger } from "@/context/ledger-context"
import { useTransactionsSearch } from "@/hooks/use-ledger-resource"
import { api, type JsonObject } from "@/lib/api"
import {
  accountName,
  asArray,
  asRecord,
  formatDate,
  formatDollarsInput,
  formatSignedCents,
  isReviewable,
  reviewReason,
  transactionCategory,
  type Account,
  type Category,
  type Transaction,
} from "@/lib/ledger"
import { CategoryRulesDialog } from "./category-rules-dialog"
import { TransactionFormDialog } from "./transaction-form-dialog"

const NONE = "none"
const ALL = "all"
const REVIEW_PAGE_SIZE = 5

const columnHelper = createColumnHelper<DataTableFeatures, Transaction>()

function messageOf(caught: unknown) {
  return caught instanceof Error ? caught.message : "Ledger could not complete this request."
}

function safeCents(amount: unknown) {
  return Number.isSafeInteger(amount) ? Number(amount) : 0
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`
}

export function TransactionsPage() {
  const { state, profile, preview, write } = useLedger()
  const [search, setSearch] = useState("")
  const [categoryFilter, setCategoryFilter] = useState(ALL)
  const [accountFilter, setAccountFilter] = useState(ALL)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [reviewOnly, setReviewOnly] = useState(false)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [bulkCategoryId, setBulkCategoryId] = useState(NONE)
  const [bulkBatches, setBulkBatches] = useState<string[]>([])
  const [reviewPage, setReviewPage] = useState(0)
  const [statusMessage, setStatusMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const reviewSectionRef = useRef<HTMLDivElement | null>(null)

  const categories = asArray<Category>(state?.categoryCatalog).filter((category) => !category.archivedAt)
  const accounts = asArray<Account>(state?.accounts)

  const categoryItems = [
    { value: NONE, label: "Uncategorized" },
    ...categories.map((category) => ({ value: category.id, label: category.name })),
  ]
  const categoryFilterItems = [
    { value: ALL, label: "All categories" },
    ...categories.map((category) => ({ value: category.id, label: category.name })),
  ]
  const accountFilterItems = [
    { value: ALL, label: "All accounts" },
    ...accounts.map((account) => ({ value: account.id, label: account.name })),
  ]
  const bulkCategoryItems = [
    { value: NONE, label: "Choose a category" },
    ...categories.map((category) => ({ value: category.id, label: category.name })),
  ]

  const transactionsQuery = useTransactionsSearch({
    page: 1,
    limit: 100,
    search: search.trim() || undefined,
    category: categoryFilter === ALL ? undefined : categoryFilter,
    account: accountFilter === ALL ? undefined : accountFilter,
    from: from || undefined,
    to: to || undefined,
    review: reviewOnly || undefined,
    profile,
  })
  const reviewQuery = useTransactionsSearch({ page: 1, limit: 100, review: true, profile })

  const rows = asArray<Transaction>(asRecord(transactionsQuery.data).transactions)
  const total = Number(asRecord(transactionsQuery.data).total ?? rows.length) || rows.length
  const reviewRows = asArray<Transaction>(asRecord(reviewQuery.data).transactions)
  const serverReviewCount = Number(asRecord(reviewQuery.data).total)
  const reviewCount = Number.isSafeInteger(serverReviewCount)
    ? serverReviewCount
    : Number.isSafeInteger(state?.reviewCount)
      ? Number(state?.reviewCount)
      : reviewRows.length

  const lastReviewIds = asArray<string>(asRecord(state?.lastReview).ids)
  const reviewPageCount = Math.max(1, Math.ceil(reviewRows.length / REVIEW_PAGE_SIZE))
  const safeReviewPage = Math.min(reviewPage, reviewPageCount - 1)
  const visibleReviewRows = reviewRows.slice(
    safeReviewPage * REVIEW_PAGE_SIZE,
    (safeReviewPage + 1) * REVIEW_PAGE_SIZE
  )

  const selectedIds = Object.keys(rowSelection).filter((id) => Boolean(rowSelection[id]))
  const previewTitle = "Changes cannot be saved in the synthetic preview."

  const activeFilterLabels = [
    search.trim() ? `Search: ${search.trim()}` : null,
    categoryFilter === ALL
      ? null
      : `Category: ${categories.find((category) => category.id === categoryFilter)?.name ?? categoryFilter}`,
    accountFilter === ALL
      ? null
      : `Account: ${accounts.find((account) => account.id === accountFilter)?.name ?? accountFilter}`,
    from ? `From: ${from}` : null,
    to ? `To: ${to}` : null,
    reviewOnly ? "Needs review only" : null,
  ].filter((label): label is string => !!label)
  const hasFilters = activeFilterLabels.length > 0

  function refreshAll() {
    return Promise.all([transactionsQuery.refresh(), reviewQuery.refresh()])
  }

  function clearFilters() {
    setSearch("")
    setCategoryFilter(ALL)
    setAccountFilter(ALL)
    setFrom("")
    setTo("")
    setReviewOnly(false)
  }

  function categoryIdFor(transaction: Transaction) {
    const override = transaction.overrideCategoryId
    if (typeof override === "string" && override) return override
    const name = transactionCategory(transaction)
    return categories.find((category) => category.name === name)?.id ?? NONE
  }

  function openAdd() {
    setEditingTransaction(null)
    setFormOpen(true)
  }

  function openEdit(transaction: Transaction) {
    if (preview || transaction.source !== "manual") return
    setEditingTransaction(transaction)
    setFormOpen(true)
  }

  function openNeedsReview() {
    setReviewOnly(true)
    reviewSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  async function changeCategory(transaction: Transaction, categoryId: string) {
    if (preview || busy || !categoryId || categoryId === NONE) return
    const category = categories.find((item) => item.id === categoryId)
    if (!category) return
    setBusy(true)
    try {
      await write("category", {
        id: transaction.id,
        categoryId,
        category: category.name,
        revision: state?.revision ?? 0,
      })
      setStatusMessage(`${transactionCategory(transaction)} was changed to ${category.name}.`)
      toast.add({
        title: "Category updated",
        description: `${transaction.merchant || "Transaction"} → ${category.name}`,
        type: "success",
      })
      await refreshAll()
    } catch (caught) {
      toast.add({ title: "Could not update category", description: messageOf(caught), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  async function markReviewed(ids: string[], reviewed: boolean) {
    if (preview || busy || ids.length === 0) return
    setBusy(true)
    try {
      const result = await write<JsonObject>("transactions-review", {
        ids,
        reviewed,
        revision: state?.revision ?? 0,
      })
      const remaining = Number(asRecord(result).remaining)
      const suffix = Number.isSafeInteger(remaining)
        ? ` ${remaining} transaction${remaining === 1 ? "" : "s"} still need review.`
        : ""
      setStatusMessage(
        `${reviewed ? "Marked" : "Returned"} ${ids.length} transaction${ids.length === 1 ? "" : "s"}${
          reviewed ? " reviewed" : " to review"
        }.${suffix}`
      )
      toast.add({
        title: reviewed ? "Transactions reviewed" : "Review restored",
        description: `${ids.length} transaction${ids.length === 1 ? "" : "s"} updated.`,
        type: "success",
      })
      await refreshAll()
    } catch (caught) {
      toast.add({ title: "Could not update review status", description: messageOf(caught), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  async function applyBulkCategory() {
    if (preview || busy || bulkCategoryId === NONE || selectedIds.length === 0) return
    if (selectedIds.length > 100) return
    const category = categories.find((item) => item.id === bulkCategoryId)
    if (!category) return
    setBusy(true)
    try {
      const result = await write<JsonObject>("category-bulk", {
        ids: selectedIds,
        categoryId: bulkCategoryId,
        category: category.name,
        revision: state?.revision ?? 0,
      })
      const batchId = asRecord(result).batchId
      if (typeof batchId === "string" && batchId) {
        setBulkBatches((current) => [batchId, ...current].slice(0, 5))
      }
      setRowSelection({})
      setStatusMessage(
        `${selectedIds.length} transaction${selectedIds.length === 1 ? "" : "s"} assigned to ${category.name}.`
      )
      toast.add({
        title: "Category applied",
        description: `${selectedIds.length} transaction${selectedIds.length === 1 ? "" : "s"} updated to ${category.name}.`,
        type: "success",
      })
      await refreshAll()
    } catch (caught) {
      toast.add({ title: "Could not apply category", description: messageOf(caught), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  async function undoBulkCategory(batchId: string) {
    if (preview || busy) return
    setBusy(true)
    try {
      const result = await write<JsonObject>("category-bulk-undo", {
        batchId,
        revision: state?.revision ?? 0,
      })
      const undone = Number(asRecord(result).undone)
      setBulkBatches((current) => current.filter((id) => id !== batchId))
      setStatusMessage(`Bulk category change undone for ${Number.isSafeInteger(undone) ? undone : ""} transaction${undone === 1 ? "" : "s"}.`)
      toast.add({ title: "Bulk change undone", description: "Earlier manual choices were restored.", type: "success" })
      await refreshAll()
    } catch (caught) {
      toast.add({ title: "Could not undo bulk change", description: messageOf(caught), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  function exportCsv() {
    if (preview) return
    const header = ["Date", "Merchant", "Category", "Amount", "Currency", "Status", "Account"]
    const lines = rows.map((transaction) =>
      [
        transaction.date,
        transaction.merchant,
        transactionCategory(transaction),
        formatDollarsInput(safeCents(transaction.amount)),
        transaction.currency ?? "USD",
        isReviewable(transaction) ? "Needs review" : transaction.pending ? "Pending" : "Reviewed",
        accountName(state, transaction.accountId),
      ]
        .map(csvCell)
        .join(",")
    )
    const csv = [header.map(csvCell).join(","), ...lines].join("\r\n")
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "ledger-transactions.csv"
    link.click()
    URL.revokeObjectURL(url)
    toast.add({
      title: "Export ready",
      description: `${rows.length} transaction${rows.length === 1 ? "" : "s"} exported.`,
      type: "success",
    })
  }

  async function importCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file || preview || busy) return
    if (file.size > 1_000_000) {
      toast.add({ title: "File too large", description: "Choose a CSV under 1 MB.", type: "error" })
      return
    }
    const scope = profile === "combined" ? undefined : profile
    setBusy(true)
    try {
      const csv = await file.text()
      const importInput: JsonObject = {
        csv,
        account: "Imported transactions",
        ...(scope ? { profileId: scope } : {}),
      }
      const previewResult = await api<JsonObject>("import-preview", importInput)
      if (asArray<unknown>(asRecord(previewResult).unknownCategories).length) {
        toast.add({
          title: "Unknown categories in this file",
          description: "Create or map those categories before importing.",
          type: "error",
        })
        return
      }
      if (asArray<unknown>(asRecord(previewResult).overlaps).length) {
        toast.add({
          title: "Possible duplicate rows",
          description: "Check the existing transactions before importing this file again.",
          type: "error",
        })
        return
      }
      const result = await write<JsonObject>("import", {
        ...importInput,
        confirmOverlaps: true,
        revision: state?.revision ?? 0,
      })
      const imported = Number(asRecord(result).imported)
      toast.add({
        title: "CSV imported",
        description: `${Number.isSafeInteger(imported) ? imported : 0} transaction${
          imported === 1 ? "" : "s"
        } imported.`,
        type: "success",
      })
      await refreshAll()
    } catch (caught) {
      toast.add({ title: "Could not import CSV", description: messageOf(caught), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  const columns = [
    columnHelper.display({
      id: "select",
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all transactions on this page"
          checked={table.getIsAllPageRowsSelected()}
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(Boolean(value))}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={`Select ${transactionCategory(row.original)} transaction`}
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(Boolean(value))}
        />
      ),
      enableHiding: false,
    }),
    columnHelper.accessor("date", {
      id: "date",
      header: ({ column }) => <SortableHeader label="Date" column={column} />,
      cell: (info) => <span className="text-sm tabular-nums">{formatDate(info.getValue())}</span>,
      meta: { label: "Date" },
    }),
    columnHelper.accessor("merchant", {
      id: "merchant",
      header: ({ column }) => <SortableHeader label="Merchant" column={column} />,
      cell: (info) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium">{info.getValue() || "Transaction"}</span>
          <span className="truncate text-xs text-muted-foreground">
            {accountName(state, info.row.original.accountId)}
          </span>
        </div>
      ),
      filterFn: "includesString",
      meta: { label: "Merchant" },
    }),
    columnHelper.accessor((row) => transactionCategory(row), {
      id: "category",
      header: "Category",
      cell: (info) => {
        const transaction = info.row.original
        return (
          <Select
            items={categoryItems}
            value={categoryIdFor(transaction)}
            onValueChange={(value) => void changeCategory(transaction, String(value ?? NONE))}
            disabled={preview || busy}
          >
            <SelectTrigger
              size="sm"
              aria-label={`Category for ${transaction.merchant || "transaction"}`}
              className="w-40 max-w-full"
            >
              <SelectValue />
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
        )
      },
      meta: { label: "Category" },
    }),
    columnHelper.accessor((row) => accountName(state, row.accountId), {
      id: "account",
      header: "Account",
      cell: (info) => <span className="text-sm">{info.getValue()}</span>,
      meta: { label: "Account" },
    }),
    columnHelper.accessor("amount", {
      id: "amount",
      header: ({ column }) => <SortableHeader label="Amount" column={column} align="right" />,
      cell: (info) => (
        <span data-numeric className="block whitespace-nowrap text-right tabular-nums">
          {formatSignedCents(safeCents(info.getValue()))}
        </span>
      ),
      meta: { label: "Amount" },
    }),
    columnHelper.accessor((row) =>
      isReviewable(row) ? "Needs review" : row.pending ? "Pending" : "Reviewed"
    , {
      id: "status",
      header: "Status",
      cell: (info) => (
        <Badge variant={info.getValue() === "Needs review" ? "outline" : "secondary"}>
          {info.getValue()}
        </Badge>
      ),
      meta: { label: "Status" },
    }),
    columnHelper.display({
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const transaction = row.original
        const needsReview = isReviewable(transaction)
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More actions for ${transaction.merchant || "transaction"}`}
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={preview || transaction.source !== "manual"}
                onClick={() => openEdit(transaction)}
              >
                Edit transaction
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={preview || busy || !needsReview}
                onClick={() => void markReviewed([transaction.id], true)}
              >
                Accept category
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={preview || busy || needsReview}
                onClick={() => void markReviewed([transaction.id], false)}
              >
                Return to review
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      },
      enableHiding: false,
    }),
  ] as unknown as ColumnDef<DataTableFeatures, Transaction>[]

  return (
    <PageShell
      title="Transactions"
      description="The details behind your day to day."
      actions={
        <>
          <Button
            type="button"
            onClick={openAdd}
            disabled={preview}
            title={preview ? previewTitle : "Record a transaction by hand."}
          >
            <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" />
            Add transaction
          </Button>
          <Button type="button" variant="outline" onClick={openNeedsReview}>
            <HugeiconsIcon icon={ListChecksIcon} data-icon="inline-start" />
            Needs review
            {reviewCount > 0 ? <Badge variant="secondary">{reviewCount}</Badge> : null}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setRulesOpen(true)}
            disabled={preview}
            title={preview ? previewTitle : "Edit category rules."}
          >
            <HugeiconsIcon icon={ListSettingIcon} data-icon="inline-start" />
            Manage rules
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={preview || busy}
            title={preview ? previewTitle : "Import transactions from a CSV file."}
          >
            <HugeiconsIcon icon={FileImportIcon} data-icon="inline-start" />
            Import CSV
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={exportCsv}
            disabled={preview}
            title={preview ? "Export is unavailable in the synthetic preview." : "Export visible rows."}
          >
            <HugeiconsIcon icon={FileExportIcon} data-icon="inline-start" />
            Export CSV
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose a CSV file to import"
            onChange={(event) => void importCsv(event)}
          />
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-5">
        <Accordion defaultValue={["filters"]}>
          <AccordionItem value="filters">
            <AccordionTrigger>Filters and search</AccordionTrigger>
            <AccordionContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="transactions-search">Search merchants</Label>
                  <Input
                    id="transactions-search"
                    type="search"
                    value={search}
                    placeholder="Merchant name"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="transactions-category">Category</Label>
                  <Select
                    items={categoryFilterItems}
                    value={categoryFilter}
                    onValueChange={(value) => setCategoryFilter(String(value ?? ALL))}
                  >
                    <SelectTrigger id="transactions-category" aria-label="Category" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {categoryFilterItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="transactions-account">Account</Label>
                  <Select
                    items={accountFilterItems}
                    value={accountFilter}
                    onValueChange={(value) => setAccountFilter(String(value ?? ALL))}
                  >
                    <SelectTrigger id="transactions-account" aria-label="Account" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {accountFilterItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="transactions-from">From date</Label>
                  <Input
                    id="transactions-from"
                    type="date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="transactions-to">To date</Label>
                  <Input
                    id="transactions-to"
                    type="date"
                    value={to}
                    min={from || undefined}
                    onChange={(event) => setTo(event.target.value)}
                  />
                </div>
                <div className="flex min-w-0 items-center gap-2 self-end pb-2">
                  <Checkbox
                    id="transactions-review-only"
                    checked={reviewOnly}
                    onCheckedChange={(value) => setReviewOnly(Boolean(value))}
                  />
                  <Label htmlFor="transactions-review-only">Needs review only</Label>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {rows.length} of {total} transaction{total === 1 ? "" : "s"} ·{" "}
            {hasFilters ? activeFilterLabels.join(" · ") : "No filters applied"}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={clearFilters}
            disabled={!hasFilters}
          >
            Clear filters
          </Button>
        </div>

        <div ref={reviewSectionRef} className="min-w-0 scroll-mt-4">
          <Card>
            <CardHeader>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <CardTitle>Review inbox</CardTitle>
                <Badge variant="secondary">
                  {reviewCount} to review
                </Badge>
              </div>
              <CardDescription>
                Accepting keeps the category shown; choose a different category in the row if it is
                wrong. Correct transfers can be accepted without changing their category.
              </CardDescription>
              <p className="text-sm font-medium">
                {reviewCount} transaction{reviewCount === 1 ? "" : "s"}{" "}
                {reviewCount === 1 ? "needs" : "need"} a decision.
              </p>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-3">
              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                {statusMessage ||
                  "Mark reviewed applies to the visible page only. Undo reverses the latest batch."}
              </p>
              <div className="flex min-w-0 flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={preview || busy || visibleReviewRows.length === 0}
                  title={preview ? previewTitle : "Marks only the visible review rows."}
                  onClick={() => void markReviewed(visibleReviewRows.map((row) => row.id), true)}
                >
                  Mark {visibleReviewRows.length} reviewed
                </Button>
                {lastReviewIds.length ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={preview || busy}
                    title={preview ? previewTitle : "Reverses the latest review batch."}
                    onClick={() => void markReviewed(lastReviewIds, false)}
                  >
                    <HugeiconsIcon icon={Undo02Icon} data-icon="inline-start" />
                    Undo last review
                  </Button>
                ) : null}
              </div>

              <div className="w-full overflow-x-auto rounded-lg border">
                <Table className="min-w-[640px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Date</TableHead>
                      <TableHead scope="col">Merchant</TableHead>
                      <TableHead scope="col">Category</TableHead>
                      <TableHead scope="col" className="text-right">
                        Amount
                      </TableHead>
                      <TableHead scope="col">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleReviewRows.length ? (
                      visibleReviewRows.map((transaction) => (
                        <TableRow key={transaction.id}>
                          <TableCell className="whitespace-nowrap text-xs tabular-nums">
                            {formatDate(transaction.date)}
                          </TableCell>
                          <TableCell>
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span className="font-medium">{transaction.merchant || "Transaction"}</span>
                              <span className="text-xs text-muted-foreground">
                                {reviewReason(transaction)}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Select
                              items={categoryItems}
                              value={categoryIdFor(transaction)}
                              onValueChange={(value) =>
                                void changeCategory(transaction, String(value ?? NONE))
                              }
                              disabled={preview || busy}
                            >
                              <SelectTrigger
                                size="sm"
                                aria-label={`Category for ${transaction.merchant || "transaction"}`}
                                className="w-40 max-w-full"
                              >
                                <SelectValue />
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
                          </TableCell>
                          <TableCell data-numeric className="text-right tabular-nums">
                            {formatSignedCents(safeCents(transaction.amount))}
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={preview || busy}
                              title={preview ? previewTitle : "Accepts this row with its shown category."}
                              onClick={() => void markReviewed([transaction.id], true)}
                            >
                              Accept category
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                          No transactions need a decision right now.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Visible page {safeReviewPage + 1} / {reviewPageCount} · batch actions use this page only
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="Previous review page"
                    disabled={safeReviewPage === 0}
                    onClick={() => setReviewPage((page) => Math.max(0, page - 1))}
                  >
                    <HugeiconsIcon icon={ChevronLeftIcon} />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="Next review page"
                    disabled={safeReviewPage >= reviewPageCount - 1}
                    onClick={() => setReviewPage((page) => page + 1)}
                  >
                    <HugeiconsIcon icon={ChevronRightIcon} />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>All transactions</CardTitle>
            <CardDescription>
              Search, sort, and recategorize recorded activity. Selection is limited to 100 rows for
              bulk changes.
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0">
            <DataTable
              columns={columns}
              data={rows}
              pageSize={10}
              getRowId={(row) => row.id}
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
              searchColumnId="merchant"
              searchPlaceholder="Filter loaded merchants"
              emptyMessage={transactionsQuery.loading ? "Loading transactions…" : "No transactions match these filters."}
              toolbar={
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {selectedIds.length ? (
                    <span className="text-xs text-muted-foreground">
                      {selectedIds.length} selected
                    </span>
                  ) : null}
                  <Select
                    items={bulkCategoryItems}
                    value={bulkCategoryId}
                    onValueChange={(value) => setBulkCategoryId(String(value ?? NONE))}
                    disabled={preview || busy || selectedIds.length === 0}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="Bulk category"
                      title={preview ? previewTitle : "Choose a category for the selected rows."}
                      className="w-44 max-w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {bulkCategoryItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      preview || busy || bulkCategoryId === NONE || selectedIds.length === 0 || selectedIds.length > 100
                    }
                    title={preview ? previewTitle : "Apply to the selected rows only."}
                    onClick={() => void applyBulkCategory()}
                  >
                    Apply category
                  </Button>
                  {bulkBatches.map((batchId) => (
                    <Button
                      key={batchId}
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={preview || busy}
                      title={preview ? previewTitle : "Undo this bulk category change."}
                      onClick={() => void undoBulkCategory(batchId)}
                    >
                      <HugeiconsIcon icon={Undo02Icon} data-icon="inline-start" />
                      Undo bulk change
                    </Button>
                  ))}
                  {selectedIds.length > 100 ? (
                    <span className="text-xs text-destructive">Select at most 100 rows.</span>
                  ) : null}
                </div>
              }
            />
          </CardContent>
        </Card>
      </div>

      <TransactionFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        transaction={editingTransaction}
      />
      <CategoryRulesDialog open={rulesOpen} onOpenChange={setRulesOpen} />
    </PageShell>
  )
}
