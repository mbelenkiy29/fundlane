"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { AlertCircle, Building2, RefreshCw, Search, Upload } from "lucide-react"
import { AssistantButton } from "@/components/mca/assistant/assistant-panel"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { DEALS_PAGE_TITLE } from "@/lib/mca/app-paths"
import { requestJson } from "@/lib/mca/client"
import type { BookDetail, BookListResponse, BookRow, BookWindow, ServicingStatus } from "@/lib/mca/deals/book-contracts"
import type { SessionResponse } from "@/lib/mca/types"
import { BookDashboardCards } from "./book-dashboard"
import { BOOK_COLUMNS, BookColumnPicker, BookTable, type BookColumnId } from "./book-table"
import { HistoricalImportDialog } from "./historical-import-dialog"
import { MerchantSheet } from "./merchant-sheet"

const DEFAULT_COLUMNS = new Set<BookColumnId>(BOOK_COLUMNS.filter((column) => column.defaultVisible).map((column) => column.id))

export function DealsBook() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [result, setResult] = useState<BookListResponse | null>(null)
  const [detail, setDetail] = useState<BookDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState("")
  const [session, setSession] = useState<SessionResponse | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [focusSms, setFocusSms] = useState(false)
  const [visible, setVisible] = useState<Set<BookColumnId>>(DEFAULT_COLUMNS)
  const searchValue = searchParams.get("q") ?? ""

  const setParam = useCallback((key: string, value?: string) => {
    const params = new URLSearchParams(searchParams)
    if (value) params.set(key, value)
    else params.delete(key)
    router.replace(`${pathname}?${params}`)
  }, [pathname, router, searchParams])

  const listQuery = useMemo(() => {
    const params = new URLSearchParams(searchParams)
    params.delete("deal")
    params.delete("advance")
    params.delete("sms")
    params.delete("tab")
    return params.toString()
  }, [searchParams])

  const load = useCallback(async () => {
    setLoading(true); setFailure("")
    try {
      const [book, nextSession] = await Promise.all([
        requestJson<BookListResponse>(`/api/mca/deals/book?${listQuery}`),
        requestJson<SessionResponse>("/api/auth/session"),
      ])
      setResult(book)
      setSession(nextSession)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not load funded deals.")
    } finally { setLoading(false) }
  }, [listQuery])

  useEffect(() => { void load() }, [load])

  const openAdvance = useCallback(async (advanceId: string, sms = false) => {
    setSheetOpen(true); setFocusSms(sms); setDetail(null)
    try {
      setDetail(await requestJson<BookDetail>(`/api/mca/deals/book/${advanceId}`))
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not load that merchant.")
      setSheetOpen(false)
    }
  }, [])

  useEffect(() => {
    const advanceId = searchParams.get("advance")
    const dealId = searchParams.get("deal")
    const sms = searchParams.get("sms") === "1"
    const tab = searchParams.get("tab")
    if (dealId && tab) {
      router.replace(`/pipeline?deal=${encodeURIComponent(dealId)}&tab=${encodeURIComponent(tab)}`)
      return
    }
    if (advanceId) void openAdvance(advanceId, sms)
    else if (dealId && result) {
      const match = result.rows.find((row) => row.dealId === dealId)
      if (match) void openAdvance(match.id, sms)
      else router.replace(`/pipeline?deal=${encodeURIComponent(dealId)}`)
    }
  }, [searchParams, result, openAdvance, router])

  const canImport = ["admin", "super_admin", "manager"].includes(session?.membership?.role ?? "")
  const showCommission = Boolean(session?.permissions?.canViewCompanyFinancials)

  const funders = useMemo(() => [...new Set(result?.rows.map((row) => row.funderName) ?? [])].sort(), [result])

  function onCall(row: BookRow) {
    if (!row.contactPhone) return
    window.location.href = `tel:${row.contactPhone}`
  }

  return (
    <div className="space-y-5 px-4 lg:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{DEALS_PAGE_TITLE}</h1>
          <p className="text-sm text-muted-foreground">The library of where your money is. Search merchants, watch payments, and open a name for documents.</p>
        </div>
        {canImport && <Button variant="outline" onClick={() => setImportOpen(true)}><Upload className="size-4" />Upload CSV</Button>}
      </div>

      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search merchant, legal name, funder, or deal ID"
            defaultValue={searchValue}
            aria-label="Search funded deals"
            onKeyDown={(event) => { if (event.key === "Enter") setParam("q", event.currentTarget.value.trim() || undefined) }}
          />
        </div>
        <AssistantButton />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={searchParams.get("status") ?? "all"} onValueChange={(value) => setParam("status", value === "all" ? undefined : value)}>
          <SelectTrigger className="w-44" aria-label="Status"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {([["active", "Active"], ["paid_off", "Paid off"], ["defaulted", "Defaulted"], ["in_collections", "In collections"]] as Array<[ServicingStatus, string]>).map(([value, label]) => (
              <SelectItem value={value} key={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={searchParams.get("frequency") ?? "all"} onValueChange={(value) => setParam("frequency", value === "all" ? undefined : value)}>
          <SelectTrigger className="w-40" aria-label="Frequency"><SelectValue placeholder="Frequency" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any frequency</SelectItem>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
            <SelectItem value="biweekly">Biweekly</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
          </SelectContent>
        </Select>
        <Input className="w-44" placeholder="Funder" defaultValue={searchParams.get("funder") ?? ""} list="book-funders" onBlur={(event) => setParam("funder", event.currentTarget.value.trim() || undefined)} onKeyDown={(event) => { if (event.key === "Enter") setParam("funder", event.currentTarget.value.trim() || undefined) }} />
        <datalist id="book-funders">{funders.map((name) => <option value={name} key={name} />)}</datalist>
        <Input className="w-40" placeholder="Rep" defaultValue={searchParams.get("assignee") ?? ""} onBlur={(event) => setParam("assignee", event.currentTarget.value.trim() || undefined)} onKeyDown={(event) => { if (event.key === "Enter") setParam("assignee", event.currentTarget.value.trim() || undefined) }} />
        <Button variant={searchParams.get("renewal") === "1" ? "secondary" : "outline"} size="sm" onClick={() => setParam("renewal", searchParams.get("renewal") === "1" ? undefined : "1")}>Renewal eligible</Button>
        <BookColumnPicker visible={visible} showCommission={showCommission} onChange={(id, next) => setVisible((current) => { const copy = new Set(current); if (next) copy.add(id); else copy.delete(id); return copy })} />
      </div>

      {result && <BookDashboardCards
        dashboard={result.dashboard}
        onMissedWindow={(window: BookWindow) => setParam("missedWindow", window === "today" ? undefined : window)}
        onCompletedWindow={(window: BookWindow) => setParam("completedWindow", window === "today" ? undefined : window)}
        onRenewals={() => setParam("renewal", "1")}
      />}

      {loading ? <div className="space-y-3">{[0, 1, 2].map((item) => <Skeleton key={item} className="h-16 w-full" />)}</div>
        : failure ? <Card className="border-destructive/40"><CardContent className="flex flex-col items-center gap-3 py-10 text-center"><AlertCircle className="size-8 text-destructive" /><div><p className="font-medium">Funded deals could not be loaded</p><p className="text-sm text-muted-foreground">{failure}</p></div><Button variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 size-4" />Retry</Button></CardContent></Card>
        : !result?.rows.length ? <Card><CardContent className="flex flex-col items-center gap-3 py-14 text-center"><div className="rounded-full bg-muted p-4"><Building2 className="size-7" /></div><div><p className="font-medium">No funded deals yet</p><p className="text-sm text-muted-foreground">Import existing advances with a CSV. New applications live on Pipeline.</p></div>{canImport && <Button onClick={() => setImportOpen(true)}><Upload className="mr-2 size-4" />Upload CSV</Button>}</CardContent></Card>
        : <BookTable
            rows={result.rows}
            visible={showCommission ? visible : new Set([...visible].filter((id) => id !== "commission"))}
            onOpen={(row) => { setParam("advance", row.id); void openAdvance(row.id) }}
            onSms={(row) => { setParam("advance", row.id); void openAdvance(row.id, true) }}
            onCall={onCall}
          />}

      <MerchantSheet key={`${detail?.dealId ?? "none"}:${sheetOpen}:${focusSms}`} detail={detail} open={sheetOpen} focusSms={focusSms} onOpenChange={(open) => { setSheetOpen(open); if (!open) { setParam("advance", undefined); setParam("deal", undefined); setParam("sms", undefined) } }} />
      <HistoricalImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={() => void load()} />
    </div>
  )
}
