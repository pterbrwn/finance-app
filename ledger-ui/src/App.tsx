import type { CSSProperties } from "react"

import { AccountsPage } from "@/components/accounts-page"
import { AppSidebar } from "@/components/app-sidebar"
import { BudgetsPage } from "@/components/budgets-page"
import { CommitmentsPage } from "@/components/commitments-page"
import { GoalsPage } from "@/components/goals-page"
import { HomePage } from "@/components/home-page"
import { InvestmentsPage } from "@/components/investments-page"
import { OverviewPage } from "@/components/overview-page"
import { SettingsPage } from "@/components/settings-page"
import { TransactionsPage } from "@/components/transactions-page"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/toast"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LedgerProvider, useLedger } from "@/context/ledger-context"
import {
  PAGE_TITLES,
  PROFILE_OPTIONS,
  type PageId,
  type ProfileId,
} from "@/lib/ledger"

const sidebarStyle = {
  "--sidebar-width": "var(--ledger-sidebar-width)",
} as CSSProperties

const pageItems = Object.entries(PAGE_TITLES).map(([value, label]) => ({
  value,
  label,
}))

const profileItems = PROFILE_OPTIONS.map((option) => ({
  value: option.value,
  label: option.label,
}))

const quickPages: PageId[] = ["overview", "transactions", "budgets", "commitments"]

function CurrentPage() {
  const { page } = useLedger()
  switch (page) {
    case "transactions":
      return <TransactionsPage />
    case "budgets":
      return <BudgetsPage />
    case "commitments":
      return <CommitmentsPage />
    case "accounts":
      return <AccountsPage />
    case "investments":
      return <InvestmentsPage />
    case "goals":
      return <GoalsPage />
    case "home":
      return <HomePage />
    case "settings":
      return <SettingsPage />
    case "overview":
    default:
      return <OverviewPage />
  }
}

function MobileHeader() {
  const { page, profile, setPage, setProfile } = useLedger()

  return (
    <div className="sticky top-0 z-20 flex min-w-0 flex-col gap-2 border-b bg-background px-4 py-2 sm:hidden">
      <div className="flex h-10 min-w-0 items-center gap-2">
        <SidebarTrigger />
        <span className="truncate text-sm font-semibold tracking-tight">Ledger</span>
        <Select
          items={profileItems}
          value={profile}
          onValueChange={(value) => setProfile(value as ProfileId)}
        >
          <SelectTrigger aria-label="Household view" className="ml-auto min-h-11 w-auto max-w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {profileItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <nav aria-label="Quick navigation" className="grid grid-cols-2 gap-2 min-[380px]:grid-cols-4">
        {quickPages.map((item) => (
          <Button
            key={item}
            type="button"
            variant={page === item ? "default" : "outline"}
            size="sm"
            aria-current={page === item ? "page" : undefined}
            onClick={() => setPage(item)}
            className="min-h-11 w-full px-2 text-xs"
          >
            {PAGE_TITLES[item]}
          </Button>
        ))}
      </nav>
      <Select
        items={pageItems}
        value={page}
        onValueChange={(value) => setPage(value as PageId)}
      >
        <SelectTrigger aria-label="All pages" className="min-h-11 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {pageItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

function LedgerShell() {
  return (
    <TooltipProvider>
      <SidebarProvider style={sidebarStyle}>
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileHeader />
          <SidebarInset className="min-w-0 overflow-x-hidden">
            <CurrentPage />
          </SidebarInset>
        </div>
      </SidebarProvider>
      <Toaster />
    </TooltipProvider>
  )
}

export function App() {
  return (
    <LedgerProvider>
      <LedgerShell />
    </LedgerProvider>
  )
}

export default App
