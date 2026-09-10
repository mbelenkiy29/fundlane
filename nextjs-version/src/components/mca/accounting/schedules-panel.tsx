"use client"

import * as React from "react"
import { AlertCircle, Loader2, Pause, Play, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { requestJson } from "@/lib/mca/client"
import type {
  AdvanceSummary,
  DistributionSchedule,
  ReverseConsolidation,
  ReverseConsolidationWorkspace,
  ScheduledInstallment,
  SplitTemplateVersion,
} from "@/lib/mca/accounting/contracts"
import { formatCents, formatMcaDate } from "./format"

function parseDollars(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) return null
  const result = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
  return Number.isSafeInteger(result) ? result : null
}

function isMondayUtc(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return false
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0))
  return utc.getUTCDay() === 1 && utc.toISOString().slice(0, 10) === date
}

const NO_TRANSFER = "Records are expected accounting rows only. No bank transfer is initiated."

export function SchedulesPanel() {
  const [consolidations, setConsolidations] = React.useState<ReverseConsolidation[]>([])
  const [schedules, setSchedules] = React.useState<DistributionSchedule[]>([])
  const [installments, setInstallments] = React.useState<ScheduledInstallment[]>([])
  const [advances, setAdvances] = React.useState<AdvanceSummary[]>([])
  const [templates, setTemplates] = React.useState<SplitTemplateVersion[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [selectedId, setSelectedId] = React.useState("")
  const [retryKey, setRetryKey] = React.useState(() => crypto.randomUUID())
  const [form, setForm] = React.useState({
    dealId: "",
    advanceIds: [] as string[],
    startDate: "",
    count: "4",
    amount: "",
    templateKey: "",
  })
  const [amend, setAmend] = React.useState({ startDate: "", count: "", amount: "", templateKey: "", reason: "" })
  const [exceptDate, setExceptDate] = React.useState("")
  const [paidDate, setPaidDate] = React.useState("")

  const selected = schedules.find((item) => item.id === selectedId)
  const selectedInstallments = installments.filter((item) => item.scheduleId === selectedId)
  const dealOptions = [...new Map(advances.map((item) => [item.dealId, { id: item.dealId, name: item.businessName }])).values()]
  const dealAdvances = advances.filter((item) => item.dealId === form.dealId && item.status !== "reversed")

  const load = React.useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const [workspace, advanceData, templateData] = await Promise.all([
        requestJson<ReverseConsolidationWorkspace>("/api/mca/accounting/schedules"),
        requestJson<{ advances: AdvanceSummary[] }>("/api/mca/advances"),
        requestJson<{ templates: SplitTemplateVersion[] }>("/api/mca/accounting/splits"),
      ])
      setConsolidations(workspace.consolidations)
      setSchedules(workspace.schedules)
      setInstallments(workspace.installments)
      setAdvances(advanceData.advances)
      setTemplates(templateData.templates)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Schedules could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  function fail(caught: unknown, fallback: string) {
    setError(caught instanceof Error ? caught.message : fallback)
  }

  function templateFromKey(key: string): SplitTemplateVersion | undefined {
    const [templateId, version] = key.split(":")
    return templates.find((item) => item.templateId === templateId && String(item.version) === version)
  }

  function toggleAdvance(id: string) {
    setForm((current) => ({
      ...current,
      advanceIds: current.advanceIds.includes(id)
        ? current.advanceIds.filter((item) => item !== id)
        : [...current.advanceIds, id],
    }))
  }

  async function create(event: React.FormEvent) {
    event.preventDefault()
    const amount = parseDollars(form.amount)
    const count = Number(form.count)
    const template = templateFromKey(form.templateKey)
    if (!form.dealId || form.advanceIds.length === 0) {
      setError("Choose a deal and at least one referenced advance.")
      return
    }
    if (!isMondayUtc(form.startDate)) {
      setError("Start date must be a Monday (YYYY-MM-DD, UTC).")
      return
    }
    if (!Number.isSafeInteger(count) || count <= 0 || amount === null || amount <= 0 || !template) {
      setError("Enter a positive installment count, dollar amount, and split template.")
      return
    }
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const saved = await requestJson<{ schedule: DistributionSchedule }>("/api/mca/accounting/schedules", {
        method: "POST",
        body: JSON.stringify({
          dealId: form.dealId,
          referencedAdvanceIds: form.advanceIds,
          startDate: form.startDate,
          installmentCount: count,
          installmentCents: amount,
          splitTemplateId: template.templateId,
          splitTemplateVersion: template.version,
          idempotencyKey: retryKey,
        }),
      })
      setRetryKey(crypto.randomUUID())
      setSelectedId(saved.schedule.id)
      setNotice(`Reverse consolidation saved. ${NO_TRANSFER}`)
      setForm({ dealId: "", advanceIds: [], startDate: "", count: "4", amount: "", templateKey: "" })
      await load()
    } catch (caught) {
      fail(caught, "Reverse consolidation could not be created.")
    } finally {
      setBusy(false)
    }
  }

  async function run(scheduleId?: string) {
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const result = await requestJson<{ inserted: number }>("/api/mca/accounting/schedules/run", {
        method: "POST",
        body: JSON.stringify(scheduleId ? { scheduleId } : {}),
      })
      setNotice(`Scheduler inserted ${result.inserted} expected installment row${result.inserted === 1 ? "" : "s"}. ${NO_TRANSFER}`)
      await load()
    } catch (caught) {
      fail(caught, "Weekly schedules could not be run.")
    } finally {
      setBusy(false)
    }
  }

  async function patch(scheduleId: string, body: Record<string, unknown>, success: string) {
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await requestJson(`/api/mca/accounting/schedules/${scheduleId}`, { method: "PATCH", body: JSON.stringify(body) })
      setNotice(success)
      await load()
    } catch (caught) {
      fail(caught, "The schedule could not be updated.")
    } finally {
      setBusy(false)
    }
  }

  async function submitAmend(event: React.FormEvent) {
    event.preventDefault()
    if (!selected) return
    const amount = parseDollars(amend.amount)
    const count = Number(amend.count)
    const template = templateFromKey(amend.templateKey)
    if (!isMondayUtc(amend.startDate) || !Number.isSafeInteger(count) || count <= 0 || amount === null || amount <= 0 || !template) {
      setError("Amendment requires a Monday start date, positive count, dollar amount, and split template.")
      return
    }
    await patch(selected.id, {
      action: "amend",
      startDate: amend.startDate,
      installmentCount: count,
      installmentCents: amount,
      splitTemplateId: template.templateId,
      splitTemplateVersion: template.version,
      reason: amend.reason || undefined,
    }, `Schedule version updated. Unpaid future rows were voided and regenerated. ${NO_TRANSFER}`)
  }

  React.useEffect(() => {
    if (!selected) return
    setAmend({
      startDate: selected.startDate,
      count: String(selected.installmentCount),
      amount: (selected.installmentCents / 100).toFixed(2),
      templateKey: `${selected.splitTemplateId}:${selected.splitTemplateVersion}`,
      reason: "",
    })
  }, [selected])

  const expectedDates = [...new Set(selectedInstallments.filter((item) => item.status === "expected" && item.scheduleVersion === selected?.version).map((item) => item.occurrenceDate))]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle>Reverse consolidations and weekly distributions</CardTitle>
            <CardDescription>{NO_TRANSFER}</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
              <Play className="size-4" />Run scheduler
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="size-4" />Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="size-4" />{error}</p>}
          {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
          {loading ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />Loading schedules…
            </p>
          ) : schedules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reverse consolidations or weekly distribution schedules yet.</p>
          ) : (
            <div className="divide-y rounded border">
              {schedules.map((schedule) => {
                const consolidation = consolidations.find((item) => item.scheduleId === schedule.id)
                const advance = advances.find((item) => item.dealId === schedule.dealId)
                return (
                  <button
                    type="button"
                    key={schedule.id}
                    onClick={() => setSelectedId(schedule.id)}
                    className={`grid w-full gap-2 p-3 text-left text-sm sm:grid-cols-5 ${selectedId === schedule.id ? "bg-muted" : ""}`}
                  >
                    <span>
                      <strong>{advance?.businessName ?? "Unknown merchant"}</strong>
                      <br />
                      {consolidation ? `${consolidation.referencedAdvanceIds.length} referenced advance${consolidation.referencedAdvanceIds.length === 1 ? "" : "s"}` : "No consolidation"}
                    </span>
                    <span className="capitalize">{schedule.status}<br />version {schedule.version}</span>
                    <span>{formatMcaDate(schedule.startDate)} · {schedule.installmentCount} Mondays</span>
                    <span>{formatCents(schedule.installmentCents)} expected each week</span>
                    <span>{installments.filter((item) => item.scheduleId === schedule.id && item.status === "expected").length} expected rows</span>
                  </button>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create reverse consolidation</CardTitle>
          <CardDescription>Attaches a Monday weekly expected-distribution schedule to existing advances. The retry identity stays stable after a failed request.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={create}>
            <div>
              <Label>Deal</Label>
              <Select value={form.dealId} onValueChange={(dealId) => setForm({ ...form, dealId, advanceIds: [] })}>
                <SelectTrigger><SelectValue placeholder="Choose deal" /></SelectTrigger>
                <SelectContent>
                  {dealOptions.map((deal) => <SelectItem value={deal.id} key={deal.id}>{deal.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Split template</Label>
              <Select value={form.templateKey} onValueChange={(templateKey) => setForm({ ...form, templateKey })}>
                <SelectTrigger><SelectValue placeholder="Choose 60/40 or other saved split" /></SelectTrigger>
                <SelectContent>
                  {templates.map((template) => (
                    <SelectItem value={`${template.templateId}:${template.version}`} key={`${template.templateId}:${template.version}`}>
                      {template.name} · v{template.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label>Referenced advances</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {form.dealId === "" ? (
                  <p className="text-sm text-muted-foreground">Choose a deal to list its advances.</p>
                ) : dealAdvances.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No active advances on this deal.</p>
                ) : dealAdvances.map((advance) => (
                  <Button key={advance.id} type="button" size="sm" variant={form.advanceIds.includes(advance.id) ? "default" : "outline"} onClick={() => toggleAdvance(advance.id)}>
                    {advance.funderName}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="schedule-start">Monday start date</Label>
              <Input id="schedule-start" required type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} />
            </div>
            <div>
              <Label htmlFor="schedule-count">Installment count</Label>
              <Input id="schedule-count" required type="number" min="1" step="1" value={form.count} onChange={(event) => setForm({ ...form, count: event.target.value })} />
            </div>
            <div>
              <Label htmlFor="schedule-amount">Installment dollars</Label>
              <Input id="schedule-amount" required value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
            </div>
            <div className="flex items-end">
              <Button disabled={busy} type="submit"><Plus className="size-4" />Create schedule</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Schedule actions</CardTitle>
          <CardDescription>
            {selected
              ? `Version ${selected.version} · ${selected.status} · ${formatMcaDate(selected.startDate)} · ${NO_TRANSFER}`
              : "Select a schedule above."}
          </CardDescription>
        </CardHeader>
        {selected && (
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy || selected.status !== "active"} onClick={() => void run(selected.id)}>
                <Play className="size-4" />Run this schedule
              </Button>
              <Button size="sm" variant="outline" disabled={busy || selected.status !== "active"} onClick={() => void patch(selected.id, { action: "pause" }, "Schedule paused. Running the scheduler is a no-op until it is active again.")}>
                <Pause className="size-4" />Pause
              </Button>
              <Button size="sm" variant="ghost" disabled={busy || selected.status === "cancelled"} onClick={() => void patch(selected.id, { action: "cancel" }, `Schedule cancelled. Unpaid expected rows were voided; paid rows stay immutable. ${NO_TRANSFER}`)}>
                Cancel
              </Button>
            </div>
            {selected.status !== "cancelled" && (
              <>
                <form className="grid gap-3 rounded border p-3 sm:grid-cols-5" onSubmit={submitAmend}>
                  <div>
                    <Label htmlFor="amend-start">Amend Monday start</Label>
                    <Input id="amend-start" type="date" value={amend.startDate} onChange={(event) => setAmend({ ...amend, startDate: event.target.value })} />
                  </div>
                  <div>
                    <Label htmlFor="amend-count">Count</Label>
                    <Input id="amend-count" type="number" min="1" step="1" value={amend.count} onChange={(event) => setAmend({ ...amend, count: event.target.value })} />
                  </div>
                  <div>
                    <Label htmlFor="amend-amount">Dollars</Label>
                    <Input id="amend-amount" value={amend.amount} onChange={(event) => setAmend({ ...amend, amount: event.target.value })} />
                  </div>
                  <div>
                    <Label>Split</Label>
                    <Select value={amend.templateKey} onValueChange={(templateKey) => setAmend({ ...amend, templateKey })}>
                      <SelectTrigger><SelectValue placeholder="Template" /></SelectTrigger>
                      <SelectContent>
                        {templates.map((template) => (
                          <SelectItem value={`${template.templateId}:${template.version}`} key={`amend-${template.templateId}:${template.version}`}>
                            {template.name} · v{template.version}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end">
                    <Button size="sm" disabled={busy} type="submit">Amend unpaid future</Button>
                  </div>
                </form>
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label>Except unpaid occurrence</Label>
                    <Select value={exceptDate || undefined} onValueChange={setExceptDate}>
                      <SelectTrigger className="w-48"><SelectValue placeholder="Occurrence date" /></SelectTrigger>
                      <SelectContent>
                        {expectedDates.map((date) => <SelectItem value={date} key={date}>{formatMcaDate(date)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !exceptDate}
                    onClick={() => void patch(selected.id, { action: "except", occurrenceDate: exceptDate }, `Unpaid occurrence voided. ${NO_TRANSFER}`)}
                  >
                    Void occurrence
                  </Button>
                  <div>
                    <Label htmlFor="installment-paid-date">Actual paid date</Label>
                    <Input id="installment-paid-date" type="date" value={paidDate} onChange={(event) => setPaidDate(event.target.value)} />
                  </div>
                </div>
              </>
            )}
            <div>
              <p className="text-sm font-medium">Installments</p>
              {selectedInstallments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No expected installments yet. Run the scheduler to materialize Monday rows.</p>
              ) : selectedInstallments.map((item) => (
                <div key={item.id} className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
                  <span>
                    {formatMcaDate(item.occurrenceDate)} · {item.recipientName} · {(item.percentageBasisPoints / 100).toFixed(2)}% · {formatCents(item.amountCents)} · v{item.scheduleVersion} · <span className="capitalize">{item.status}</span>
                    {item.paidAt ? ` ${formatMcaDate(item.paidAt)}` : ""}
                  </span>
                  {item.status === "expected" && selected.status !== "cancelled" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        if (!paidDate) { setError("Choose the actual paid date before marking an installment paid."); return }
                        void patch(selected.id, {
                          action: "pay",
                          installmentId: item.id,
                          paidAt: `${paidDate}T12:00:00.000Z`,
                        }, `Installment marked paid. ${NO_TRANSFER}`)
                      }}
                    >
                      Mark paid
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
