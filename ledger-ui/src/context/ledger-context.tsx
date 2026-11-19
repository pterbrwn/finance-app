import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { api, type JsonObject } from "@/lib/api"
import {
  currentMonth,
  type LedgerState,
  type PageId,
  type ProfileId,
} from "@/lib/ledger"

type LedgerContextValue = {
  state: LedgerState | null
  loading: boolean
  refreshing: boolean
  error: string | null
  stale: boolean
  profile: ProfileId
  month: string
  page: PageId
  preview: boolean
  setProfile: (profile: ProfileId) => void
  setMonth: (month: string) => void
  setPage: (page: PageId) => void
  refresh: () => Promise<void>
  write: <T>(path: string, input: JsonObject) => Promise<T>
}

const LedgerContext = createContext<LedgerContextValue | null>(null)

function readSearchParams() {
  if (typeof window === "undefined") {
    return { page: "overview" as PageId, profile: "combined" as ProfileId, month: currentMonth(), preview: false }
  }
  const params = new URLSearchParams(window.location.search)
  const page = params.get("page")
  const profile = params.get("profile")
  const month = params.get("month")
  const validPages: PageId[] = [
    "overview",
    "transactions",
    "budgets",
    "commitments",
    "accounts",
    "investments",
    "goals",
    "home",
    "settings",
  ]
  const validProfiles: ProfileId[] = ["combined", "peter", "maddie", "joint"]
  return {
    page: validPages.includes(page as PageId) ? (page as PageId) : ("overview" as PageId),
    profile: validProfiles.includes(profile as ProfileId)
      ? (profile as ProfileId)
      : ("combined" as ProfileId),
    month: month && /^\d{4}-\d{2}$/.test(month) ? month : currentMonth(),
    preview: params.get("preview") === "true",
  }
}

export function LedgerProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(() => readSearchParams(), [])
  const [state, setState] = useState<LedgerState | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [page, setPageState] = useState<PageId>(initial.page)
  const [profile, setProfileState] = useState<ProfileId>(initial.profile)
  const [month, setMonthState] = useState(initial.month)
  const [preview, setPreview] = useState(initial.preview)

  useEffect(() => {
    const onPopState = () => {
      const next = readSearchParams()
      setPageState(next.page)
      setProfileState(next.profile)
      setMonthState(next.month)
      setPreview(next.preview)
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  const syncUrl = useCallback(
    (next: { page?: PageId; profile?: ProfileId; month?: string; preview?: boolean }) => {
      const params = new URLSearchParams(window.location.search)
      params.set("page", next.page ?? page)
      params.set("profile", next.profile ?? profile)
      params.set("month", next.month ?? month)
      if (next.preview ?? preview) params.set("preview", "true")
      else params.delete("preview")
      const url = `${window.location.pathname}?${params.toString()}`
      window.history.pushState({}, "", url)
    },
    [month, page, preview, profile]
  )

  const setPage = useCallback(
    (next: PageId) => {
      setPageState(next)
      syncUrl({ page: next })
      window.scrollTo({ top: 0, behavior: "auto" })
    },
    [syncUrl]
  )

  const setProfile = useCallback(
    (next: ProfileId) => {
      setProfileState(next)
      syncUrl({ profile: next })
    },
    [syncUrl]
  )

  const setMonth = useCallback(
    (next: string) => {
      setMonthState(next)
      syncUrl({ month: next })
    },
    [syncUrl]
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const params = new URLSearchParams({ profile })
      const next = await api<LedgerState>(`state?${params.toString()}`)
      setState(next)
      setError(null)
      setStale(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Ledger could not load.")
      setStale(true)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [profile])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [profile, refresh])

  const write = useCallback(
    async <T,>(path: string, input: JsonObject) => {
      if (preview) throw new Error("The synthetic preview cannot save changes.")
      const body = Number.isSafeInteger(state?.revision)
        ? { ...input, revision: state?.revision }
        : input
      const result = await api<T>(path, body)
      await refresh()
      return result
    },
    [preview, refresh, state?.revision]
  )

  const value = useMemo<LedgerContextValue>(
    () => ({
      state,
      loading,
      refreshing,
      error,
      stale: stale && state !== null,
      profile,
      month,
      page,
      preview,
      setProfile,
      setMonth,
      setPage,
      refresh,
      write,
    }),
    [
      error,
      loading,
      month,
      page,
      preview,
      profile,
      refresh,
      refreshing,
      setMonth,
      setPage,
      setProfile,
      stale,
      state,
      write,
    ]
  )

  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>
}

export function useLedger() {
  const context = useContext(LedgerContext)
  if (!context) throw new Error("useLedger must be used inside LedgerProvider")
  return context
}
