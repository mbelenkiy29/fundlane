"use client"

import * as React from "react"
import Link from "next/link"
import { VoiceLauncher } from "@/components/mca/voice/voice-launcher"
import { ArrowUpRight, Loader2, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { DealMessages } from "@/components/mca/email/deal-messages"
import { RequestError, requestJson } from "@/lib/mca/client"
import { DEAL_STATUS_LABELS, type DealStatus } from "@/lib/mca/deals/schema"
import {
  formatActionSince,
  HOME_COPY,
  type HomeActionCategory,
  type HomeDealPanel,
  type HomeQueueResult,
} from "@/lib/mca/home/contracts"
import { homeQueueView } from "@/lib/mca/home/panel-state"

function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    const fields = Object.values(error.fieldErrors ?? {}).flat().filter(Boolean)
    return fields.length ? fields.join(" ") : error.message
  }
  return error instanceof Error ? error.message : HOME_COPY.failed
}

function chipClass(category: HomeActionCategory): string {
  if (category === "own_action") return "border-transparent bg-red-600 text-white"
  if (category === "overdue_waiting") return "border-transparent bg-amber-400 text-amber-950"
  return "border-transparent bg-violet-600 text-white"
}

function dollars(cents?: number): string {
  if (cents == null) return "Amount unknown"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

export function NeedsAction() {
  const [queue, setQueue] = React.useState<HomeQueueResult>()
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string>()
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>()
  const [category, setCategory] = React.useState<HomeActionCategory | "all">("all")
  const [selectedId, setSelectedId] = React.useState<string>()
  const [focusChannel, setFocusChannel] = React.useState<"sms" | "email">()
  const [panel, setPanel] = React.useState<HomeDealPanel>()
  const [panelLoading, setPanelLoading] = React.useState(false)
  const [panelError, setPanelError] = React.useState<string>()
  const [busy, setBusy] = React.useState<string>()
  const [notice, setNotice] = React.useState<string>()
  const [note, setNote] = React.useState("")
  const [status, setStatus] = React.useState<DealStatus | "">("")
  const pitchKey = React.useRef<string | undefined>(undefined)
  const noteKey = React.useRef<string | undefined>(undefined)

  const loadQueue = React.useCallback(async () => {
    setLoading(true)
    setError(undefined)
    setFieldErrors(undefined)
    try {
      const params = category === "all" ? "" : `?category=${encodeURIComponent(category)}`
      setQueue(await requestJson<HomeQueueResult>(`/api/mca/home/needs-action${params}`))
    } catch (caught) {
      if (caught instanceof RequestError && caught.fieldErrors) setFieldErrors(caught.fieldErrors)
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [category])

  const loadPanel = React.useCallback(async (dealId: string) => {
    setPanelLoading(true)
    setPanelError(undefined)
    try {
      const payload = await requestJson<HomeDealPanel>(`/api/mca/home/needs-action/${encodeURIComponent(dealId)}`)
      setPanel(payload)
      setStatus("")
    } catch (caught) {
      setPanelError(errorText(caught))
    } finally {
      setPanelLoading(false)
    }
  }, [])

  React.useEffect(() => { void loadQueue() }, [loadQueue])
  React.useEffect(() => {
    if (selectedId) void loadPanel(selectedId)
    else setPanel(undefined)
  }, [selectedId, loadPanel])

  const view = homeQueueView({ loading, error, fieldErrors, items: queue?.items })

  async function refreshAll() {
    await loadQueue()
    if (selectedId) await loadPanel(selectedId)
  }

  async function run(scope: string, operation: () => Promise<void>, success: string) {
    setBusy(scope)
    setNotice(undefined)
    setPanelError(undefined)
    try {
      await operation()
      setNotice(success)
      await refreshAll()
    } catch (caught) {
      setPanelError(errorText(caught))
    } finally {
      setBusy(undefined)
    }
  }

  function pitched() {
    const action = panel?.workflowActions.find((item) => item.id === "pitched")
    if (!panel || !action?.revisionId) return
    const key = pitchKey.current ?? crypto.randomUUID()
    pitchKey.current = key
    void run("pitched", async () => {
      if (action.offerId && !panel.offers.find((offer) => offer.revisionId === action.revisionId)?.selected) {
        await requestJson(`/api/mca/offers/${encodeURIComponent(panel.dealId)}/${encodeURIComponent(action.offerId)}/selection`, {
          method: "POST",
          body: JSON.stringify({ revisionId: action.revisionId, selected: true, reason: "Home pitch" }),
        })
      }
      await requestJson("/api/mca/closing/pitches", {
        method: "POST",
        body: JSON.stringify({ dealId: panel.dealId, offerId: action.offerId, revisionId: action.revisionId, idempotencyKey: key }),
      })
      pitchKey.current = undefined
    }, "Pitch logged. That reason is gone if no unpitched offers remain.")
  }

  function addNote() {
    if (!panel || !note.trim()) return
    const key = noteKey.current ?? crypto.randomUUID()
    noteKey.current = key
    void run("note", async () => {
      await requestJson(`/api/mca/deals/${encodeURIComponent(panel.dealId)}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: note.trim(), expectedVersion: panel.version }),
      })
      noteKey.current = undefined
      setNote("")
    }, "Note saved.")
  }

  function updateStatus() {
    if (!panel || !status) return
    void run("status", async () => {
      await requestJson(`/api/mca/deals/${encodeURIComponent(panel.dealId)}/transition`, {
        method: "POST",
        body: JSON.stringify({ status, expectedVersion: panel.version }),
      })
    }, "Status updated. Remaining reasons still come from live deal state.")
  }

  return (
    <Card data-testid="mca-needs-action">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>{HOME_COPY.title}</CardTitle>
          <CardDescription>{HOME_COPY.description}</CardDescription>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void refreshAll()} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {HOME_COPY.retry}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {(["all", "own_action", "overdue_waiting", "renewal"] as const).map((value) => (
            <Button key={value} type="button" size="sm" variant={category === value ? "default" : "outline"} onClick={() => setCategory(value)}>
              {value === "all" ? "All" : value === "own_action" ? HOME_COPY.ownAction : value === "overdue_waiting" ? HOME_COPY.overdueWaiting : HOME_COPY.renewal}
              {queue && value !== "all" ? ` (${queue.counts[value]})` : queue && value === "all" ? ` (${queue.counts.total})` : ""}
            </Button>
          ))}
        </div>
        {view.status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{view.message}</p>
        ) : view.status === "validation" || view.status === "error" ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-destructive">{view.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadQueue()}>{HOME_COPY.retry}</Button>
          </div>
        ) : view.status === "empty" ? (
          <p className="text-sm text-muted-foreground" role="status">{view.message}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{HOME_COPY.deal}</TableHead>
                <TableHead>{HOME_COPY.notification}</TableHead>
                <TableHead>{HOME_COPY.action}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.items.map((item) => (
                <TableRow
                  key={item.dealId}
                  data-state={selectedId === item.dealId ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() => setSelectedId(item.dealId)}
                >
                  <TableCell>
                    <div className="font-medium">{item.legalName}</div>
                    <div className="text-xs text-muted-foreground">{item.displayId}</div>
                  </TableCell>
                  <TableCell>
                    {item.notification}
                    {item.reasons.length > 1 ? <span className="ml-2 text-xs text-muted-foreground">+{item.reasons.length - 1}</span> : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1" onClick={(event) => event.stopPropagation()}>
                      {item.suggestedActions.map((action) =>
                        action.id === "call" && action.href ? (
                          action.enabled ? <VoiceLauncher key={action.id} dealId={item.dealId} href={action.href} label={action.label} /> : <Button key={action.id} size="sm" variant="outline" disabled>{action.label}</Button>
                        ) : action.id === "call" ? (
                          <Button
                            key={action.id}
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled
                            title={HOME_COPY.noPhone}
                            aria-label={HOME_COPY.noPhone}
                          >
                            {action.label}
                          </Button>
                        ) : (
                          <Button
                            key={action.id}
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!action.enabled}
                            onClick={() => {
                              setSelectedId(item.dealId)
                              setFocusChannel(action.id === "email" ? "email" : "sms")
                            }}
                          >
                            {action.label}
                          </Button>
                        ),
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <Sheet open={Boolean(selectedId)} onOpenChange={(open) => { if (!open) { setSelectedId(undefined); setFocusChannel(undefined) } }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{panel?.legalName ?? HOME_COPY.panelLoading}</SheetTitle>
            <SheetDescription>{panel ? `${panel.displayId} · ${DEAL_STATUS_LABELS[panel.status]}` : HOME_COPY.description}</SheetDescription>
          </SheetHeader>
          <div className="space-y-5 px-4 pb-6">
            {panelLoading ? <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{HOME_COPY.panelLoading}</p> : null}
            {panelError ? <p className="text-sm text-destructive" role="alert">{panelError}</p> : null}
            {notice ? <p className="text-sm text-muted-foreground" role="status">{notice}</p> : null}
            {panel && !panel.reasons.length ? <p className="text-sm text-muted-foreground" role="status">{HOME_COPY.panelEmpty}</p> : null}
            {panel ? (
              <>
                {focusChannel ? (
                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">Message</h3>
                    <DealMessages dealId={panel.dealId} channel={focusChannel} />
                  </section>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/pipeline?deal=${encodeURIComponent(panel.dealId)}`}>{HOME_COPY.fullDeal} <ArrowUpRight className="size-4" /></Link>
                  </Button>
                  {panel.workflowActions.find((item) => item.id === "pitched")?.enabled ? (
                    <Button type="button" size="sm" disabled={Boolean(busy)} onClick={pitched}>
                      {busy === "pitched" ? <Loader2 className="size-4 animate-spin" /> : null}
                      {HOME_COPY.pitched}
                    </Button>
                  ) : null}
                  {panel.workflowActions.find((item) => item.id === "submit")?.enabled ? (
                    <Button asChild size="sm">
                      <Link href={`/pipeline?deal=${encodeURIComponent(panel.dealId)}&submit=1`}>{HOME_COPY.submit}</Link>
                    </Button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-40 flex-1 space-y-1">
                    <Label>{HOME_COPY.updateStatus}</Label>
                    <Select value={status || undefined} onValueChange={(value) => setStatus(value as DealStatus)}>
                      <SelectTrigger><SelectValue placeholder="Next status" /></SelectTrigger>
                      <SelectContent>
                        {panel.allowedStatuses.map((value) => (
                          <SelectItem key={value} value={value}>{DEAL_STATUS_LABELS[value]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button type="button" size="sm" disabled={!status || Boolean(busy)} onClick={updateStatus}>
                    {busy === "status" ? <Loader2 className="size-4 animate-spin" /> : null}
                    {HOME_COPY.updateStatus}
                  </Button>
                </div>
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{HOME_COPY.action}</h3>
                  <ul className="space-y-1">
                    {panel.reasons.map((item) => (
                      <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
                        <Badge className={chipClass(item.category)}>{item.label}</Badge>
                        <span className="text-xs text-muted-foreground tabular-nums">{formatActionSince(item.since, panel.now)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="space-y-1">
                  <h3 className="text-sm font-medium">{HOME_COPY.contacts}</h3>
                  <p className="text-sm">{panel.contacts.name || "No contact name"}</p>
                  <p className="text-sm text-muted-foreground">{panel.contacts.email || "No email"} · {panel.contacts.phone || "No phone"}</p>
                </section>
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{HOME_COPY.offers}</h3>
                  {panel.offers.length ? panel.offers.map((offer) => (
                    <div key={offer.id} className="rounded-md border p-2 text-sm">
                      <div className="font-medium">{offer.funderName}</div>
                      <div className="text-xs text-muted-foreground">{dollars(offer.amountCents)} · {offer.selected ? "Selected" : "Not selected"} · {offer.pitched ? "Pitched" : "Unpitched"}</div>
                    </div>
                  )) : <p className="text-sm text-muted-foreground">No offers yet.</p>}
                </section>
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{HOME_COPY.submissions}</h3>
                  {panel.submissions.length ? panel.submissions.map((item) => (
                    <div key={item.id} className="rounded-md border p-2 text-sm">
                      <div className="font-medium">{item.funderName}</div>
                      <div className="text-xs text-muted-foreground">{item.status}{item.routeKind ? ` · ${item.routeKind}` : ""} · {item.hasResponse ? "Response on file" : "No response"}{item.overdue ? " · overdue" : ""}</div>
                    </div>
                  )) : <p className="text-sm text-muted-foreground">No submissions yet.</p>}
                </section>
                {panel.advances.length ? (
                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">{HOME_COPY.advances}</h3>
                    {panel.advances.map((item) => (
                      <div key={item.id} className="rounded-md border p-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{item.funderName}</span>
                          {item.renewalEligible ? <Badge className={chipClass("renewal")}>Renewal</Badge> : null}
                        </div>
                        <div className="text-xs text-muted-foreground">{dollars(item.principalCents)} · {item.fundedAt.slice(0, 10)}</div>
                      </div>
                    ))}
                  </section>
                ) : null}
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{HOME_COPY.notes}</h3>
                  {panel.notes.length ? panel.notes.map((item) => (
                    <p key={item.id} className="rounded-md border p-2 text-sm">{item.body}</p>
                  )) : <p className="text-sm text-muted-foreground">No notes yet.</p>}
                  <Label htmlFor="home-note">{HOME_COPY.addNote}</Label>
                  <Textarea id="home-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder={HOME_COPY.notePlaceholder} />
                  <Button type="button" size="sm" disabled={!note.trim() || Boolean(busy)} onClick={addNote}>
                    {busy === "note" ? <Loader2 className="size-4 animate-spin" /> : null}
                    {HOME_COPY.addNote}
                  </Button>
                </section>
              </>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  )
}
