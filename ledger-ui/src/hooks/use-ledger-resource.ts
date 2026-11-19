import { useCallback, useEffect, useState } from "react"

import { useLedger } from "@/context/ledger-context"
import { api } from "@/lib/api"
import { type LedgerRecord, type ProfileId } from "@/lib/ledger"

type ResourceState<T> = {
  data: T | null
  loading: boolean
  error: string | null
  stale: boolean
  refresh: () => Promise<void>
}

function useResource<T>(path: string | null): ResourceState<T> {
  const { state } = useLedger()
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(path !== null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!path) return
    setLoading(true)
    try {
      const result = await api<T>(path)
      setData(result)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load this section.")
    } finally {
      setLoading(false)
    }
  }, [path])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load, path])

  const revision =
    data && typeof data === "object" && "revision" in data
      ? (data as { revision?: unknown }).revision
      : undefined

  return {
    data,
    loading,
    error,
    stale:
      revision !== undefined &&
      Number.isSafeInteger(revision) &&
      Number(revision) !== state?.revision,
    refresh: load,
  }
}

function query(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value))
  }
  return search.toString()
}

export function useMonthSummary(month: string, profile: ProfileId) {
  return useResource<LedgerRecord & { revision: number }>(
    `month-summary?${query({ month, profile })}`
  )
}

export function useBudgetSummary(month: string, profile: ProfileId) {
  return useResource<LedgerRecord & { revision: number }>(
    `budget-summary?${query({ month, profile })}`
  )
}

export function useHouseholdSummary(month: string, profile: ProfileId) {
  return useResource<LedgerRecord & { revision: number }>(
    `household-summary?${query({ month, profile, series: true })}`
  )
}

export function useCommitments(from: string, to: string, profile: ProfileId) {
  return useResource<LedgerRecord & { revision: number }>(
    `commitments?${query({ from, to, profile })}`
  )
}

export function useCategoryRules(profile: ProfileId) {
  return useResource<LedgerRecord & { revision: number }>(
    `category-rules?${query({ profile })}`
  )
}

export function useTransactionsSearch(
  params: Record<string, string | number | boolean | undefined>
) {
  return useResource<LedgerRecord & { revision: number }>(
    `transactions?${query({ profile: "combined", ...params })}`
  )
}

export function useSyncStatus() {
  return useResource<LedgerRecord>("sync-status")
}

export function useHealth() {
  return useResource<LedgerRecord>("health")
}
