"use client"
import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ArrowUpRight, FileCheck2, RefreshCw, Search, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { requestJson } from "@/lib/mca/client"
import { SubmissionsInsightsPanel } from "@/components/mca/submissions/insights-panel"
import { IntakeLinkCard } from "@/components/mca/submissions/intake-link-card"
import {
  dealSubmissionHref,
  submissionLabel,
  type DashboardResult,
  type SubmissionBusinessStatus,
  type SubmissionDealRow,
  type SubmissionDetail,
  type SubmissionRow,
} from "@/lib/mca/submissions/dashboard-view"
import { isInsightWindow, type InsightWindow, type SubmissionInsights } from "@/lib/mca/submissions/insights"

const dateLabel = (date: string | null) =>
  date
    ? new Date(date).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: date.length === 10 ? undefined : "short",
        timeZone: date.length === 10 ? "UTC" : undefined,
      })
    : "Not recorded"
const failureMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Could not load submissions. Please try again."
function Status({ value }: { value: string }) {
  return (
    <Badge
      variant={
        [
          "failed",
          "preflight_failed",
          "blocked_duplicate",
          "declined",
          "rejected",
          "withdrawn",
        ].includes(value)
          ? "destructive"
          : value === "sent" || value === "approved" || value === "funded" || value === "offer_received"
            ? "default"
            : "secondary"
      }
      className="whitespace-nowrap"
    >
      {submissionLabel(value)}
    </Badge>
  )
}

function BusinessStatus({ value }: { value: SubmissionBusinessStatus }) {
  return <Status value={value} />
}

function amountLabel(deal: SubmissionDealRow): string {
  if (deal.amountHidden) return "Restricted"
  if (deal.amountRequested == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(deal.amountRequested)
}
export function SubmissionsDashboard() {
  const router = useRouter(),
    path = usePathname(),
    params = useSearchParams()
  const [data, setData] = React.useState<DashboardResult>()
  const [insights, setInsights] = React.useState<SubmissionInsights>()
  const [insightWindow, setInsightWindow] = React.useState<InsightWindow>("today")
  const [insightsLoading, setInsightsLoading] = React.useState(true)
  const [loading, setLoading] = React.useState(true),
    [error, setError] = React.useState("")
  const [refresh, setRefresh] = React.useState(0),
    [picker, setPicker] = React.useState(false)
  const [detail, setDetail] = React.useState<SubmissionDetail>(),
    [detailError, setDetailError] = React.useState("")
  const [detailRefresh, setDetailRefresh] = React.useState(0)
  const focusTarget = React.useRef<HTMLElement | null>(null)
  const heading = React.useRef<HTMLHeadingElement>(null)
  const record = params.get("record")
  const query = new URLSearchParams(params)
  query.delete("record")
  const queryString = query.toString()
  React.useEffect(() => {
    let active = true
    setLoading(true)
    setError("")
    requestJson<DashboardResult>(`/api/mca/submissions?${queryString}`)
      .then((result) => {
        if (active) setData(result)
      })
      .catch((error) => {
        if (active) setError(failureMessage(error))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [queryString, refresh])
  React.useEffect(() => {
    let active = true
    setInsightsLoading(true)
    requestJson<SubmissionInsights>(`/api/mca/submissions/insights?window=${insightWindow}`)
      .then((result) => {
        if (active) setInsights(result)
      })
      .catch(() => {
        if (active) setInsights(undefined)
      })
      .finally(() => {
        if (active) setInsightsLoading(false)
      })
    return () => {
      active = false
    }
  }, [insightWindow, refresh])
  React.useEffect(() => {
    let active = true
    setDetail(undefined)
    setDetailError("")
    if (record)
      requestJson<SubmissionDetail>(
        `/api/mca/submissions/records/${encodeURIComponent(record)}`
      )
        .then((result) => {
          if (active) setDetail(result)
        })
        .catch((error) => {
          if (active) setDetailError(failureMessage(error))
        })
    return () => {
      active = false
    }
  }, [record, detailRefresh])
  function change(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key !== "page" && key !== "record") next.delete("page")
    router.replace(`${path}?${next}`, { scroll: false })
  }
  const filtered = [
    "q",
    "delivery",
    "response",
    "funder",
    "rep",
    "from",
    "to",
  ].some((key) => params.has(key))
  function open(row: SubmissionRow | SubmissionDealRow, target: HTMLElement, recordId = "id" in row ? row.id : row.recordId) {
    focusTarget.current = target
    change("record", recordId)
  }
  const choices = data?.choices
  const deals = data?.deals ?? []
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight"
          >
            Submissions
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live submissions, lender volume, and what happened after each send.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button onClick={() => setPicker(true)}>
            <Send className="size-4" />
            Submit a deal
          </Button>
        </div>
      </header>
      <SubmissionsInsightsPanel
        insights={insights}
        window={insightWindow}
        onWindowChange={(value) => {
          if (isInsightWindow(value)) setInsightWindow(value)
        }}
        loading={insightsLoading}
      />
      <IntakeLinkCard />
      <section
        aria-label="Submission filters"
        className="space-y-3 rounded-xl border bg-card p-4"
      >
        <form
          className="flex gap-2"
          key={params.get("q") ?? ""}
          onSubmit={(event) => {
            event.preventDefault()
            change(
              "q",
              String(new FormData(event.currentTarget).get("q") ?? "").trim()
            )
          }}
        >
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
            <Input
              aria-label="Search submissions"
              name="q"
              defaultValue={params.get("q") ?? ""}
              placeholder="Search business, deal ID, or funder"
              className="pl-9"
              maxLength={250}
            />
          </div>
          <Button variant="outline" type="submit">
            Search
          </Button>
        </form>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          {(
            [
              [
                "delivery",
                "Delivery status",
                choices?.delivery.map((value) => ({
                  id: value,
                  name: submissionLabel(value),
                })),
              ],
              [
                "response",
                "Funder response",
                choices?.response.map((value) => ({
                  id: value,
                  name: submissionLabel(value),
                })),
              ],
              ["funder", "Funder", choices?.funders],
              ["rep", "Assigned rep", choices?.reps],
            ] as const
          ).map(([key, label, options]) => (
            <label className="space-y-1 text-xs font-medium" key={key}>
              <span>{label}</span>
              <select
                aria-label={label}
                className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
                value={params.get(key) ?? ""}
                onChange={(event) => change(key, event.target.value)}
              >
                <option value="">All</option>
                {params.get(key) &&
                  !options?.some((option) => option.id === params.get(key)) && (
                    <option value={params.get(key)!}>
                      Unavailable selection
                    </option>
                  )}
                {options?.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {(
            [
              ["from", "Submitted from"],
              ["to", "Submitted through"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="space-y-1 text-xs font-medium">
              <span>{label}</span>
              <Input
                type="date"
                value={params.get(key) ?? ""}
                onChange={(event) => change(key, event.target.value)}
              />
            </label>
          ))}
        </div>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.replace(path)}
          >
            Reset filters
          </Button>
        )}
      </section>
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive"
        >
          {error}{" "}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Try again
          </Button>
        </div>
      )}
      <section
        aria-label="Submission results"
        aria-busy={loading}
        className="overflow-hidden rounded-xl border bg-card"
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium">
            {data
              ? `${data.total} ${data.total === 1 ? "business" : "businesses"}`
              : "Submissions"}
          </p>
          <span role="status" className="text-xs text-muted-foreground">
            {loading ? "Refreshing…" : "Newest first"}
          </span>
        </div>
        {!data && loading && (
          <p className="p-8 text-sm text-muted-foreground">
            Loading submissions…
          </p>
        )}
        {data && deals.length === 0 && (
          <div className="space-y-3 p-12 text-center">
            <FileCheck2 className="mx-auto size-8 text-muted-foreground" />
            <h2 className="font-medium">
              {filtered ? "No matches" : "No submissions yet"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {filtered
                ? "Try different filters to find a submission."
                : "Choose a deal to start submitting to funders."}
            </p>
            {filtered ? (
              <Button variant="outline" onClick={() => router.replace(path)}>
                Reset filters
              </Button>
            ) : (
              <Button onClick={() => setPicker(true)}>Choose a deal</Button>
            )}
          </div>
        )}
        {!!deals.length && (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    {[
                      "Business Name",
                      "Amount requested",
                      "Lender(s) submitted to",
                      "Status",
                      "Date submitted",
                      "Outcome",
                    ].map((title) => (
                      <th className="px-4 py-3 font-medium" key={title}>
                        {title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {deals.map((deal) => (
                    <tr key={deal.dealId} className="border-t hover:bg-muted/30">
                      <td className="px-4 py-4">
                        <button
                          className="text-left font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2"
                          onClick={(event) => open(deal, event.currentTarget)}
                        >
                          {deal.business}
                          <span className="mt-1 block text-xs font-normal text-muted-foreground">
                            {deal.displayId}
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-4 tabular-nums">{amountLabel(deal)}</td>
                      <td className="px-4 py-4">
                        <div className="flex flex-wrap gap-1">
                          {deal.lenders.map((lender) => (
                            <button
                              key={lender.recordId}
                              className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted"
                              onClick={(event) => open(deal, event.currentTarget, lender.recordId)}
                            >
                              {lender.name}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <BusinessStatus value={deal.status} />
                      </td>
                      <td className="px-4 py-4 text-xs text-muted-foreground">
                        {dateLabel(deal.submittedAt)}
                      </td>
                      <td className="px-4 py-4 text-sm">{deal.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="divide-y md:hidden">
              {deals.map((deal) => (
                <button
                  key={deal.dealId}
                  className="block w-full space-y-3 p-4 text-left hover:bg-muted/30"
                  onClick={(event) => open(deal, event.currentTarget)}
                >
                  <div className="flex justify-between gap-3">
                    <span className="font-medium">
                      {deal.business}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {deal.displayId}
                      </span>
                    </span>
                    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                  </div>
                  <p className="text-sm">{amountLabel(deal)}</p>
                  <p className="text-sm text-muted-foreground">
                    {deal.lenders.map((lender) => lender.name).join(", ")}
                  </p>
                  <div className="flex flex-wrap gap-3 text-xs">
                    <BusinessStatus value={deal.status} />
                    <span className="text-muted-foreground">{dateLabel(deal.submittedAt)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{deal.outcome}</p>
                </button>
              ))}
            </div>
          </>
        )}
        {data && data.total > 0 && (
          <div className="flex items-center justify-between border-t p-4">
            <p className="text-xs text-muted-foreground">
              Page {data.page} of{" "}
              {Math.max(1, Math.ceil(data.total / data.pageSize))}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={loading || data.page <= 1}
                onClick={() => change("page", String(data.page - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={loading || data.page * data.pageSize >= data.total}
                onClick={() => change("page", String(data.page + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </section>
      <Sheet
        open={!!record}
        onOpenChange={(open) => {
          if (!open) change("record", "")
        }}
      >
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            ;(focusTarget.current?.isConnected
              ? focusTarget.current
              : heading.current
            )?.focus()
          }}
        >
          <SheetHeader>
            <SheetTitle>Submission details</SheetTitle>
            <SheetDescription>
              Delivery progress and recorded funder response.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-6 p-4">
            {detailError ? (
              <div role="alert" className="space-y-3">
                <p>{detailError}</p>
                <Button
                  variant="outline"
                  onClick={() => setDetailRefresh((value) => value + 1)}
                >
                  Try again
                </Button>
              </div>
            ) : !detail ? (
              <p role="status">Loading submission…</p>
            ) : (
              <>
                <div>
                  <h2 className="text-xl font-semibold">{detail.business}</h2>
                  <Link
                    className="text-sm text-primary underline"
                    href={dealSubmissionHref(detail.dealId)}
                  >
                    {detail.displayId}
                  </Link>
                  <p className="mt-2 text-sm">
                    {detail.funderId ? (
                      <Link href="/funders" className="text-primary underline">
                        {detail.funder}
                      </Link>
                    ) : (
                      detail.funder
                    )}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4 rounded-lg border p-4">
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">
                      Delivery
                    </p>
                    <Status value={detail.delivery} />
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">
                      Funder response
                    </p>
                    <Status value={detail.response} />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Submitted</p>
                    <p className="text-sm">{dateLabel(detail.submittedAt)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Updated</p>
                    <p className="text-sm">{dateLabel(detail.updatedAt)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Source / route
                    </p>
                    <p className="text-sm">
                      {submissionLabel(detail.source)} ·{" "}
                      {detail.route
                        ? submissionLabel(detail.route)
                        : "Not recorded"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Assigned rep
                    </p>
                    <p className="text-sm">
                      {detail.reps.map((rep) => rep.name).join(", ") ||
                        "Unassigned"}
                    </p>
                  </div>
                </div>
                {detail.guidance && (
                  <p className="rounded-lg border bg-muted/30 p-4 text-sm">
                    {detail.guidance}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button asChild>
                    <Link href={dealSubmissionHref(detail.dealId)}>
                      Open submissions
                      <ArrowUpRight className="size-4" />
                    </Link>
                  </Button>
                  <Button variant="outline" asChild>
                    <Link href={dealSubmissionHref(detail.dealId, "offers")}>
                      Open offers
                    </Link>
                  </Button>
                </div>
                <section className="space-y-3">
                  <h3 className="font-medium">Delivery history</h3>
                  {!detail.attempts.length && (
                    <p className="text-sm text-muted-foreground">
                      No delivery attempts recorded.
                    </p>
                  )}
                  <ol className="space-y-3">
                    {detail.attempts.map((attempt) => (
                      <li
                        className="space-y-2 rounded-lg border p-3"
                        key={attempt.id}
                      >
                        <div className="flex justify-between gap-2">
                          <Status value={attempt.state} />
                          <span className="text-xs text-muted-foreground">
                            {dateLabel(attempt.createdAt)}
                          </span>
                        </div>
                        <p className="text-sm">
                          {submissionLabel(attempt.transport)}
                        </p>
                        {attempt.guidance && (
                          <p className="text-sm text-muted-foreground">
                            {attempt.guidance}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <DealPicker open={picker} onOpenChange={setPicker} />
    </div>
  )
}
function DealPicker({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (value: boolean) => void
}) {
  const [query, setQuery] = React.useState(""),
    [error, setError] = React.useState("")
  const [deals, setDeals] = React.useState<
    Array<{ id: string; displayId: string; legalName: string }>
  >([])
  const [loading, setLoading] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setError("")
    const timer = setTimeout(() => {
      requestJson<{
        deals: Array<{ id: string; displayId: string; legalName: string }>
      }>(`/api/mca/deals?q=${encodeURIComponent(query)}`)
        .then((result) => {
          if (active) setDeals(result.deals)
        })
        .catch((error) => {
          if (active) setError(failureMessage(error))
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, query])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit a deal</DialogTitle>
          <DialogDescription>
            Choose a deal to review documents and select funders.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search deals"
          placeholder="Search business or deal ID"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {error && <p role="alert">{error} Close and reopen to retry.</p>}
        {loading && (
          <p role="status" className="text-sm">
            Searching deals…
          </p>
        )}
        <div className="max-h-80 overflow-y-auto">
          {!loading && !error && !deals.length && (
            <p className="p-4 text-sm text-muted-foreground">
              No accessible deals match your search.
            </p>
          )}
          {deals.map((deal) => (
            <Link
              key={deal.id}
              href={dealSubmissionHref(deal.id)}
              className="block rounded-lg border-b p-3 hover:bg-muted focus-visible:outline-2"
            >
              {deal.legalName}
              <span className="block text-xs text-muted-foreground">
                {deal.displayId}
              </span>
            </Link>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
