import { HugeiconsIcon } from "@hugeicons/react"
import {
  BankIcon,
  Calendar03Icon,
  ChartLineData01Icon,
  FlaskConicalIcon,
  Home01Icon,
  ReceiptTextIcon,
  Settings01Icon,
  Target01Icon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons"

import { useLedger } from "@/context/ledger-context"
import { Badge } from "@/components/ui/badge"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { PAGE_TITLES, profileLabel, type PageId } from "@/lib/ledger"

const primaryNavigation: ReadonlyArray<{
  page: PageId
  icon: typeof Home01Icon
}> = [
  { page: "overview", icon: Home01Icon },
  { page: "transactions", icon: ReceiptTextIcon },
  { page: "budgets", icon: Wallet01Icon },
  { page: "commitments", icon: Calendar03Icon },
  { page: "goals", icon: Target01Icon },
]

const setupNavigation: ReadonlyArray<{
  page: PageId
  icon: typeof Home01Icon
}> = [
  { page: "accounts", icon: BankIcon },
  { page: "investments", icon: ChartLineData01Icon },
  { page: "home", icon: Home01Icon },
  { page: "settings", icon: Settings01Icon },
]

export function AppSidebar() {
  const { page, preview, profile, setPage, state } = useLedger()
  const reviewCount = state?.reviewCount ?? 0

  const renderItem = ({
    page: itemPage,
    icon,
  }: {
    page: PageId
    icon: typeof Home01Icon
  }) => {
    const active = page === itemPage
    const badge =
      itemPage === "transactions" && reviewCount > 0 && !preview
        ? String(reviewCount)
        : undefined

    return (
      <SidebarMenuItem key={itemPage}>
        <SidebarMenuButton
          type="button"
          isActive={active}
          aria-current={active ? "page" : undefined}
          onClick={() => setPage(itemPage)}
          tooltip={PAGE_TITLES[itemPage]}
          className="min-h-11"
        >
          <HugeiconsIcon icon={icon} strokeWidth={1.8} />
          <span>{PAGE_TITLES[itemPage]}</span>
        </SidebarMenuButton>
        {badge ? (
          <SidebarMenuBadge>
            <span className="sr-only">{badge} transactions need review</span>
            <span aria-hidden="true">{badge}</span>
          </SidebarMenuBadge>
        ) : null}
      </SidebarMenuItem>
    )
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-3 px-2 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <HugeiconsIcon icon={Wallet01Icon} strokeWidth={1.8} />
          </div>
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-sm font-semibold tracking-tight">Ledger</p>
            <p className="truncate text-xs text-muted-foreground">
              Personal finance
            </p>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-3 group-data-[collapsible=icon]:hidden">
          <p className="text-xs font-medium text-foreground">Current view</p>
          <p className="mt-1 truncate text-xs leading-relaxed text-muted-foreground">
            {profileLabel(profile)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Views are not a privacy boundary.
          </p>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{primaryNavigation.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Setup and context</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{setupNavigation.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />

      <SidebarFooter>
        <div className="rounded-lg border bg-card p-3 group-data-[collapsible=icon]:hidden">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium">
              {preview ? "Preview mode" : "Saved data"}
            </p>
            <Badge variant="outline">
              {preview ? "No writes" : "Local"}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {preview
              ? "Synthetic figures only. Saved balances and records are not read."
              : `Revision ${state?.revision ?? "—"}. Records stay on this device.`}
          </p>
          {preview ? (
            <HugeiconsIcon icon={FlaskConicalIcon} className="mt-2 text-muted-foreground" />
          ) : null}
        </div>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
