const REPLAY_SAFE_WRITE_PATHS = new Set([
  "account-update",
  "budget",
  "budget-history-revert",
  "budget-outlook",
  "budget-reset",
  "budget-stop-future",
  "category",
  "category-bulk",
  "category-bulk-undo",
  "category-create",
  "category-rules",
  "category-rules-apply",
  "category-rules-preview",
  "category-update",
  "commitment-match",
  "commitments",
  "goal",
  "goal-allocation-undo",
  "goal-allocations",
  "import",
  "import-undo",
  "income-plan",
  "income-plan-reset",
  "manual-account",
  "mortgage",
  "property",
  "scenario",
  "scenario-budget",
  "scenario-goal",
  "transaction-add",
  "transaction-edit",
  "transaction-reimbursement",
  "transaction-remove",
  "transaction-review",
  "transaction-split",
  "transactions-review",
])

const PENDING_OPERATIONS_KEY = "ledger.pending-operations.v1"

type PendingOperation = {
  operationId: string
  scope: string
  baseRevision: number
  startedAt: string
}

export type JsonObject = Record<string, unknown>

export class LedgerApiError extends Error {
  status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = "LedgerApiError"
    this.status = status
  }
}

function readPendingOperations(): PendingOperation[] {
  try {
    const raw = sessionStorage.getItem(PENDING_OPERATIONS_KEY) || "[]"
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter((row): row is PendingOperation => {
      if (!row || typeof row !== "object") return false
      const candidate = row as Partial<PendingOperation>
      return (
        typeof candidate.operationId === "string" &&
        typeof candidate.scope === "string" &&
        Number.isSafeInteger(candidate.baseRevision) &&
        typeof candidate.startedAt === "string"
      )
    })
  } catch {
    return []
  }
}

function writePendingOperations(rows: PendingOperation[]) {
  try {
    sessionStorage.setItem(PENDING_OPERATIONS_KEY, JSON.stringify(rows))
    return true
  } catch {
    return false
  }
}

function clearPendingOperation(operationId: string) {
  writePendingOperations(
    readPendingOperations().filter((row) => row.operationId !== operationId)
  )
}

export function pendingOperationCount() {
  return readPendingOperations().length
}

export function clearAllPendingOperations() {
  try {
    sessionStorage.removeItem(PENDING_OPERATIONS_KEY)
  } catch {
    // Recovery references cannot be cleared when session storage is unavailable.
  }
}

export async function api<T = JsonObject>(path: string): Promise<T>
export async function api<T = JsonObject>(path: string, input: JsonObject): Promise<T>
export async function api<T = JsonObject>(
  path: string,
  input?: JsonObject
): Promise<T> {
  const route = path.split("?")[0] ?? path
  const isWrite = input !== undefined
  const replaySafe = isWrite && REPLAY_SAFE_WRITE_PATHS.has(route)

  let requestBody = input
  let operationId: string | null = null
  if (replaySafe && input) {
    const scope = path
    const matches = readPendingOperations().filter((row) => row.scope === scope)
    if (matches.length > 1) {
      throw new LedgerApiError(
        `Resolve the earlier ${route} save status before starting another save in this section.`
      )
    }
    const existing = matches[0]
    operationId = existing?.operationId ?? crypto.randomUUID()
    const baseRevision =
      existing?.baseRevision ??
      (Number.isSafeInteger(input.revision) ? Number(input.revision) : 0)
    requestBody = {
      ...input,
      ...(Number.isSafeInteger(input.revision) ? { revision: baseRevision } : {}),
      clientOperationId: operationId,
    }
    writePendingOperations([
      {
        operationId,
        scope,
        baseRevision,
        startedAt: existing?.startedAt ?? new Date().toISOString(),
      },
      ...readPendingOperations().filter((row) => row.operationId !== operationId),
    ])
  }

  const attempts = replaySafe ? 2 : 1
  let lastNetworkError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response
    try {
      response = await fetch(`/api/${path}`, {
        method: isWrite ? "POST" : "GET",
        credentials: "same-origin",
        headers: isWrite ? { "Content-Type": "application/json" } : {},
        body: isWrite ? JSON.stringify(requestBody) : undefined,
      })
    } catch (error) {
      lastNetworkError = error
      if (replaySafe && attempt === 0) continue
      throw new LedgerApiError(
        "Could not reach Ledger. Check the connection and try again.",
        0
      )
    }

    if (replaySafe && response.status >= 500 && attempt === 0) continue

    let result: unknown = null
    try {
      result = await response.json()
    } catch {
      // handled below
    }

    if (!response.ok) {
      if (response.status === 409 && operationId) {
        try {
          const status = await api<{ status?: string }>(
            `operation-status?operationId=${encodeURIComponent(operationId)}`
          )
          if (status.status === "unknown" || status.status === "committed") {
            clearPendingOperation(operationId)
          }
        } catch {
          // Keep the recovery reference when the status check itself fails.
        }
      }
      const error =
        result && typeof result === "object" && "error" in result
          ? String((result as { error: unknown }).error)
          : "Ledger could not complete this request. Try again."
      throw new LedgerApiError(error, response.status)
    }

    if (!result || typeof result !== "object") {
      throw new LedgerApiError("Ledger returned an unreadable response. Try again.")
    }
    if (operationId) clearPendingOperation(operationId)
    return result as T
  }

  throw new LedgerApiError(
    lastNetworkError instanceof Error
      ? lastNetworkError.message
      : "Ledger could not confirm the save. Retry it to check the saved result."
  )
}
