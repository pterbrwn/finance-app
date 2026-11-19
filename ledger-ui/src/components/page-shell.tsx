import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  FlaskConicalIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons"
import type { ReactNode } from "react"

import { useLedger } from "@/context/ledger-context"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

type PageShellProps = {
  title: string
  description: string
  actions?: ReactNode
  children: ReactNode
}

export function PageShell({
  title,
  description,
  actions,
  children,
}: PageShellProps) {
  const { error, loading, preview, refresh, refreshing, stale, state } = useLedger()

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1620px] flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <header className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <Breadcrumb className="mb-2">
            <BreadcrumbList>
              <BreadcrumbItem>Personal finance</BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {title}
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        {actions ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </header>

      {preview ? (
        <Alert>
          <HugeiconsIcon icon={FlaskConicalIcon} />
          <AlertTitle>Synthetic preview</AlertTitle>
          <AlertDescription>
            These figures are generated locally for interface review. No saved
            Ledger records are read and changes cannot be saved.
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive" role="alert">
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Ledger could not load</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              {refreshing ? (
                <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" className="animate-spin" />
              ) : (
                <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" />
              )}
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {stale && state ? (
        <Alert>
          <HugeiconsIcon icon={Alert02Icon} />
          <AlertTitle>Saved data may be stale</AlertTitle>
          <AlertDescription>
            The latest refresh failed. The figures below are from the last
            successful load.
          </AlertDescription>
        </Alert>
      ) : null}

      {loading && !state ? <PageSkeleton /> : children}
    </div>
  )
}

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading Ledger">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-96 rounded-xl" />
    </div>
  )
}
