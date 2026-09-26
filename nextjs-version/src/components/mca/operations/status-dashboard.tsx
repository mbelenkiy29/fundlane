"use client"
import { useCallback, useEffect, useState } from "react"
import {
  Line,
  LineChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from "recharts"
import { Button } from "@/components/ui/button"
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table"
import {
  documentWorkerReady,
  type Status,
  type Window,
  type ErrorEvent,
} from "@/lib/mca/operations/contracts"
const number = (n: number | null | undefined) =>
  n == null ? "Unavailable" : n.toLocaleString()
const stamp = (s: string) =>
  new Date(s).toLocaleString(undefined, { timeZone: "UTC" })
export function StatusDashboard({ preview, documentRuntimeEnabled = false }: { preview?: Status; documentRuntimeEnabled?: boolean }) {
  const [window, setWindow] = useState<Window>("24h"),
    [data, setData] = useState<Status | null>(preview ?? null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<ErrorEvent[]>([]),
    [next, setNext] = useState<string | null>(null),
    [component, setComponent] = useState("")
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (preview) return
      setBusy(true)
      try {
        const [status, events] = await Promise.all([
          fetch(`/api/admin/status?window=${window}`, {
            signal,
            cache: "no-store",
          }),
          fetch(
            `/api/admin/status/errors?window=${window}&component=${component}`,
            { signal, cache: "no-store" }
          ),
        ])
        if (!status.ok || !events.ok)
          throw new Error(
            status.status === 403
              ? "Owner access is required."
              : "Status could not be loaded. Check native platform logs."
          )
        const [body, list] = await Promise.all([status.json(), events.json()])
        if (signal?.aborted) return
        setData(body)
        setErrors(list.errors)
        setNext(list.next)
        setError("")
      } catch (e) {
        if (!signal?.aborted)
          setError(e instanceof Error ? e.message : "Status unavailable")
      } finally {
        if (!signal?.aborted) setBusy(false)
      }
    },
    [window, component, preview]
  )
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(controller.signal)
    }, 60000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [load])
  const more = async () => {
    try {
      const r = await fetch(
        `/api/admin/status/errors?window=${window}&component=${component}&before=${next}`,
        { cache: "no-store" }
      )
      if (!r.ok) throw new Error()
      const body = await r.json()
      setErrors((x) => [...x, ...body.errors])
      setNext(body.next)
    } catch {
      setError("More errors could not be loaded.")
    }
  }
  const latest = data?.latest,
    metrics = latest?.metrics,
    stale = data?.stale || Boolean(error)
  const state =
    !latest || stale || !metrics
      ? "Unknown"
      : latest.website_ok &&
          latest.database_ok &&
          !data?.incidents.some((i) => i.opened_at)
        ? "Healthy"
        : "Degraded"
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Fundlane / Owner console
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Platform status
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Health, delivery, and activity across Fundlane.
          </p>
          {preview && (
            <p className="mt-2 text-sm font-medium text-amber-700">
              Sample data · Design preview
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <select
            aria-label="Time range"
            value={window}
            onChange={(e) => setWindow(e.target.value as Window)}
            className="rounded-md border bg-background px-3 text-sm"
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          <Button
            variant="outline"
            disabled={busy || Boolean(preview)}
            onClick={() => void load()}
          >
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </header>
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900"
        >
          {error} Previous data, if shown, is stale.
        </p>
      )}
      {metrics && !documentWorkerReady(metrics) && (
        <p
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          Document worker heartbeat is stale. Check the document cron schedule, CRON_SECRET, database access, and native executor logs.
        </p>
      )}
      {documentRuntimeEnabled && metrics && metrics.scannerUnavailable > 0 && (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          {metrics.scannerUnavailable} document job{metrics.scannerUnavailable === 1 ? " is" : "s are"} waiting for a scanner verdict. Check native executor health or Cloudmersive credentials; retry failed scans after recovery.
        </p>
      )}
      {documentRuntimeEnabled && metrics && metrics.documentFailed > 0 && (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          {metrics.documentFailed} document or intake job{metrics.documentFailed === 1 ? " has" : "s have"} failed. Inspect worker job error codes and retry only after the cause is resolved.
        </p>
      )}
      {data?.emailRuntime && (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="font-semibold">Email conversation worker</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Last completed tick: {data.emailRuntime.lastCompletedAt ? stamp(data.emailRuntime.lastCompletedAt) : "Never"}
            {(!data.emailRuntime.lastCompletedAt || Date.now() - Date.parse(data.emailRuntime.lastCompletedAt) > 600_000) && " · Worker stale or stopped"}
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            {[
              ["Queued", number(data.emailRuntime.queued)],
              ["Oldest queued", data.emailRuntime.oldestQueuedSeconds == null ? "None" : `${Math.floor(data.emailRuntime.oldestQueuedSeconds / 60)} min`],
              ["Expired senders", number(data.emailRuntime.expiredSenders)],
              ["Revoked senders", number(data.emailRuntime.revokedSenders)],
              ["Sync failures", number(data.emailRuntime.syncFailures)],
              ["Stale or never synced", number(data.emailRuntime.staleSyncs)],
            ].map(([title, value]) => <div key={title}><dt className="text-sm text-muted-foreground">{title}</dt><dd className="mt-1 text-xl font-semibold">{value}</dd></div>)}
          </dl>
        </section>
      )}
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/20 p-4">
        <div className="flex items-center gap-3">
          <span
            className={`h-3 w-3 rounded-full ${state === "Healthy" ? "bg-emerald-500" : state === "Degraded" ? "bg-amber-500" : "bg-slate-400"}`}
          />
          <strong>{state}</strong>
          <span className="text-sm text-muted-foreground">
            {latest
              ? `Last check ${stamp(latest.checked_at)}`
              : "Awaiting first scheduled check"}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          Checks every minute · UTC reporting
        </span>
      </section>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          title="Observed availability"
          value={
            data?.observedAvailability == null
              ? "No samples"
              : `${(data.observedAvailability * 100).toFixed(1)}%`
          }
          detail={`${data?.samples ?? 0} scheduled samples`}
        />
        <Metric
          title="Website response"
          value={
            latest?.website_ok
              ? `${number(latest.website_ms)} ms`
              : "Unavailable"
          }
          detail={stale ? "Stale observation" : "Latest scheduled check"}
        />
        <Metric
          title="Database response"
          value={
            latest?.database_ok
              ? `${number(latest.database_ms)} ms`
              : "Unavailable"
          }
          detail="Through the application connection"
        />
        <Metric
          title="Recorded errors"
          value={number(data?.errors)}
          detail="Selected window · server and workers"
        />
      </div>
      {Boolean(data?.jobKinds?.length) && <Panel title="Jobs by kind" subtitle="Current queue and delivery outcomes · UTC">
        <div className="overflow-x-auto">
          <Table><TableHeader><TableRow>
            <TableHead>Kind</TableHead><TableHead>Queued</TableHead><TableHead>Running</TableHead><TableHead>Failures</TableHead><TableHead>Queue age</TableHead><TableHead>Oldest pending</TableHead><TableHead>Last success</TableHead>
          </TableRow></TableHeader><TableBody>
            {(data?.jobKinds ?? []).map((job) => <TableRow key={job.kind}>
              <TableCell>{job.kind}</TableCell><TableCell>{job.queued}</TableCell><TableCell>{job.running}</TableCell><TableCell>{job.failures}</TableCell>
              <TableCell>{job.oldestPendingSeconds === null ? "—" : `${Math.floor(job.oldestPendingSeconds / 60)} min`}</TableCell>
              <TableCell>{job.oldestPendingAt ? stamp(job.oldestPendingAt) : "—"}</TableCell>
              <TableCell>{job.lastSuccessAt ? stamp(job.lastSuccessAt) : "—"}</TableCell>
            </TableRow>)}
          </TableBody></Table>
        </div>
      </Panel>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Response time" subtitle="Hourly average · milliseconds">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data?.health ?? []}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="time"
                  tickFormatter={(v) =>
                    new Date(v).toLocaleTimeString([], {
                      hour: "2-digit",
                      timeZone: "UTC",
                    })
                  }
                  minTickGap={50}
                />
                <YAxis />
                <Tooltip labelFormatter={(v) => stamp(String(v))} />
                <Legend />
                <Line
                  name="Website"
                  dataKey="websiteMs"
                  stroke="#2563eb"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  name="Database"
                  dataKey="databaseMs"
                  stroke="#059669"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel
          title="Recorded errors"
          subtitle="Hourly events · collection starts at rollout"
        >
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data?.health ?? []}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="time"
                  tickFormatter={(v) =>
                    new Date(v).toLocaleTimeString([], {
                      hour: "2-digit",
                      timeZone: "UTC",
                    })
                  }
                  minTickGap={50}
                />
                <YAxis allowDecimals={false} />
                <Tooltip labelFormatter={(v) => stamp(String(v))} />
                <Line
                  name="Errors"
                  dataKey="errors"
                  stroke="#d97706"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Background jobs"
          subtitle="Current snapshot · all job types"
        >
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {[
              ["Queued", metrics?.queued],
              ["Running", metrics?.running],
              ["Failed", metrics?.failed],
              ["Retrying", metrics?.retrying],
              ["Expired leases", metrics?.expired],
              [
                "Oldest eligible",
                metrics
                  ? `${Math.floor(metrics.oldestSeconds / 60)} min`
                  : null,
              ],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-sm text-muted-foreground">{k}</dt>
                <dd className="mt-1 text-xl font-semibold">
                  {typeof v === "string" ? v : number(v as number | null)}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel
          title="Email delivery"
          subtitle="Current totals · acceptance does not establish inbox delivery"
        >
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {[
              ["Queued", metrics?.emailQueued],
              ["Provider accepted", metrics?.emailAccepted],
              ["Failed", metrics?.emailFailed],
              ["Blocked", metrics?.emailBlocked],
              ["Ambiguous sends", metrics?.emailUnknown],
              ["Reconnect sender", metrics?.reconnect],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-sm text-muted-foreground">{k}</dt>
                <dd className="mt-1 text-xl font-semibold">
                  {number(v as number | null)}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
      {data?.calendar && (
        <Panel title="Google Calendar sync" subtitle="Current connections · owner-only aggregate">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {[
              ["Connections", data.calendar.connections],
              ["Stale over 10 min", data.calendar.stale],
              ["Failures", data.calendar.failures],
              ["Reconnect needed", data.calendar.reconnect],
              ["Watches due within 24h", data.calendar.expiringWatches],
            ].map(([label, value]) => (
              <div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 text-xl font-semibold">{number(value as number)}</dd></div>
            ))}
          </dl>
        </Panel>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric
          title="Companies"
          value={number(data?.companies)}
          detail="All time"
        />
        <Metric
          title="New companies"
          value={number(data?.newCompanies)}
          detail="Selected window"
        />
        <Metric
          title="Active users"
          value={number(data?.activeUsers)}
          detail="Authenticated activity"
        />
        <Metric
          title="Application links"
          value={number(data?.invitations)}
          detail="Created in selected window"
        />
        <Metric
          title="Applications submitted"
          value={number(data?.submitted)}
          detail="Via tracked invitations"
        />
      </div>
      <Panel
        title="Daily activity"
        subtitle="UTC days · available history only"
      >
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data?.usage ?? []}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="day" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar
                name="Active users"
                dataKey="activeUsers"
                fill="#2563eb"
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
              <Bar
                name="Application links"
                dataKey="invitations"
                fill="#059669"
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
              <Bar
                name="Submitted"
                dataKey="submitted"
                fill="#a78bfa"
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>
      <Panel
        title="Open incidents and alert delivery"
        subtitle="Opening, six-hour reminders, and recovery notifications"
      >
        {!data ? (
          <p>Unavailable</p>
        ) : data.incidents.length ? (
          data.incidents.map((i) => (
            <p key={i.component} className="py-2 text-sm">
              <strong>{i.component.replaceAll("_", " ")}</strong> ·{" "}
              {i.opened_at ? stamp(i.opened_at) : "Recovered"} · Alert{" "}
              {i.delivery_state ?? "not sent"}
            </p>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No recorded open incidents.
          </p>
        )}
      </Panel>
      <Panel title="Recent errors" subtitle="Sanitized metadata only">
        <label className="mb-4 block text-sm">
          Component{" "}
          <select
            aria-label="Error component"
            value={component}
            onChange={(e) => setComponent(e.target.value)}
            className="ml-2 rounded border bg-background p-2"
          >
            <option value="">All</option>
            {["api", "worker", "database", "email"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <Table aria-label="Recent errors">
            <TableHeader>
              <TableRow>
                {["Time", "Component", "Code", "Route", "Correlation ID"].map(
                  (x) => (
                    <TableHead key={x}>
                      {x}
                    </TableHead>
                  )
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {errors.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    {stamp(e.occurred_at)}
                  </TableCell>
                  <TableCell>{e.component}</TableCell>
                  <TableCell>{e.code}</TableCell>
                  <TableCell>{e.route ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {e.correlation_id ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        {!errors.length && (
          <p className="py-4 text-sm text-muted-foreground">
            {error
              ? "Error history unavailable."
              : "No recorded errors in this view."}
          </p>
        )}
        {next && (
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => void more()}
          >
            Load older errors
          </Button>
        )}
      </Panel>
      <footer className="space-y-2 text-xs text-muted-foreground">
        <p>
          Collection{" "}
          {data ? `started ${stamp(data.startedAt)}` : "not available"}. Missing
          history is not evidence of uptime. Database or email-provider outages
          may interrupt alerts.
        </p>
        <p className="break-all">
          Deployment: {latest?.deployment ?? "Unavailable"}
        </p>
        <div className="flex gap-4">
          <a
            className="underline"
            href="https://vercel.com/michael-belenkiys-projects/fundlane/logs"
            target="_blank"
            rel="noreferrer"
          >
            Vercel runtime logs ↗
          </a>
          <a
            className="underline"
            href="https://supabase.com/dashboard/project/drubsfvhlggmtyiigwxy/logs/explorer"
            target="_blank"
            rel="noreferrer"
          >
            Supabase diagnostics ↗
          </a>
        </div>
      </footer>
    </div>
  )
}
function Metric({
  title,
  value,
  detail,
}: {
  title: string
  value: string
  detail: string
}) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="text-sm text-muted-foreground">{title}</h2>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
    </section>
  )
}
function Panel({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="font-semibold">{title}</h2>
      <p className="mb-5 mt-1 text-xs text-muted-foreground">{subtitle}</p>
      {children}
    </section>
  )
}
