"use client"
import { useEffect, useRef, useState } from "react"
import { PLATFORM_REFRESH_EVENT } from "@/lib/mca/platform-refresh"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { requestJson } from "@/lib/mca/client"
import { PlatformHeading, PlatformSection, PlatformStatus } from "./presentation"

type Company = {
  optOutReady: boolean
  workspaceId: string
  name: string
  reviewState: string
  registrationState: string
  emailVerified: boolean
  suspended: boolean
  note?: string
  numberLimit: number
  monthlyLimitCents: number
  registrationLimitCents: number
  profile: Record<string, unknown> | null
}
export default function SmsReview() {
  const [loading, setLoading] = useState(true)
  const [companies, setCompanies] = useState<Company[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [operation, setOperation] = useState(""),
    [stepUpCode, setStepUpCode] = useState("")
  const reading = useRef(false)
  const [snapshotAt, setSnapshotAt] = useState<string>()
  async function load() {
    if (reading.current) return
    reading.current = true
    try { setCompanies(
      (await requestJson<{ companies: Company[] }>("/api/mca/sms/operator"))
        .companies
    ); setSnapshotAt(new Date().toISOString()); setError("") } finally { reading.current = false }
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    const refresh = () => { if (!busy) void load().catch(() => setError("SMS review snapshot is stale; refresh failed.")) }
    window.addEventListener(PLATFORM_REFRESH_EVENT, refresh)
    return () => window.removeEventListener(PLATFORM_REFRESH_EVENT, refresh)
  }, [busy])
  return (
    <section className="space-y-5">
      <PlatformHeading snapshotAt={snapshotAt} title="Company SMS review" description="Platform operators review the actual business, application-update use case, and consent evidence. Company roles do not grant access here." />
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <PlatformSection title="Verify before approving or rejecting" description="Approve and reject decisions require a fresh authenticator code from this session. Verification lasts a few minutes.">
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Authenticator code"
            autoComplete="one-time-code"
            inputMode="numeric"
            className="w-48"
            value={stepUpCode}
            onChange={(e) => setStepUpCode(e.target.value)}
          />
          <Button
            type="button"
            disabled={busy || !stepUpCode}
            onClick={async () => {
              setBusy(true)
              setError("")
              try {
                await requestJson("/api/platform/step-up", {
                  method: "POST",
                  body: JSON.stringify({ code: stepUpCode }),
                })
                setStepUpCode("")
                setNotice("Authenticator verified for this session.")
              } catch (e) {
                setError(e instanceof Error ? e.message : "Verification failed")
              } finally {
                setBusy(false)
              }
            }}
          >
            Verify code
          </Button>
        </div>
      </PlatformSection>
      {loading && <p role="status" className="text-sm text-muted-foreground">Loading SMS reviews…</p>}
      {!loading && !error && !companies.length && <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">No companies available for review.</p>}
      {companies.map((c) => (
        <form
          key={c.workspaceId}
          className="space-y-4 rounded-xl border bg-card p-6 shadow-sm"
          onSubmit={async (e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget)
            setBusy(true)
            setError("")
            try {
              await requestJson("/api/mca/sms/operator", {
                method: "POST",
                body: JSON.stringify({
                  workspaceId: c.workspaceId,
                  decision: f.get("decision"),
                  optOutConfirmed: f.get("optOutConfirmed") === "on",
                  note: f.get("note"),
                  numberLimit: Number(f.get("numberLimit")),
                  monthlyLimitCents: Number(f.get("monthlyLimitCents")),
                  registrationLimitCents: Number(
                    f.get("registrationLimitCents")
                  ),
                }),
              })
              setNotice("Review saved.")
              await load()
            } catch (e) {
              setError(e instanceof Error ? e.message : "Review failed")
            } finally {
              setBusy(false)
            }
          }}
        >
          <h2 className="text-lg font-medium">{c.name}</h2>
          <p className="text-sm">
            Email {c.emailVerified ? "verified" : "unverified"} · Review{" "}
            <PlatformStatus value={c.reviewState} /> · Carrier <PlatformStatus value={c.registrationState} />
            {c.suspended ? " · Suspended" : ""}
          </p>
          <dl className="grid gap-2 text-sm md:grid-cols-2">
            {Object.entries(c.profile ?? {}).map(([key, value]) => (
              <div key={key}>
                <dt className="font-medium">{key}</dt>
                <dd className="whitespace-pre-wrap break-words">
                  {Array.isArray(value) ? value.join("\n") : String(value)}
                </dd>
              </div>
            ))}
          </dl>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              ["numberLimit", "Maximum numbers", c.numberLimit],
              [
                "monthlyLimitCents",
                "Monthly allowance (cents)",
                c.monthlyLimitCents,
              ],
              [
                "registrationLimitCents",
                "Registration allowance (cents)",
                c.registrationLimitCents,
              ],
            ].map(([name, label, value]) => (
              <Label className="grid gap-2" key={String(name)}>
                {label}
                <Input
                  name={String(name)}
                  type="number"
                  min={0}
                  required
                  defaultValue={value}
                />
              </Label>
            ))}
          </div>
          <Label className="grid gap-2">
            Decision
            <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" name="decision">
              {["approved", "rejected", "suspended", "resumed", "limits"].map(
                (x) => (
                  <option key={x}>{x}</option>
                )
              )}
            </select>
          </Label>
          <Label className="flex gap-2">
            <input
              type="checkbox"
              name="optOutConfirmed"
              defaultChecked={c.optOutReady}
            />
            I verified Advanced Opt-Out is enabled on this company’s Twilio
            Messaging Service.
          </Label>
          <Label className="grid gap-2">
            Reason / evidence reference
            <Textarea
              name="note"
              minLength={5}
              required
              defaultValue={c.note ?? ""}
            />
          </Label>
          <Button disabled={busy}>Save decision and limits</Button>
        </form>
      ))}
      <PlatformSection title="Reconcile an interrupted purchase or subaccount creation">
        <Input
          aria-label="Operation ID"
          value={operation}
          onChange={(e) => setOperation(e.target.value)}
        />
        <Button
          disabled={busy || !operation}
          onClick={async () => {
            setBusy(true)
            try {
              await requestJson("/api/mca/sms/operator/reconcile", {
                method: "POST",
                body: JSON.stringify({ id: operation }),
              })
              setNotice("Remote resource recovered; the operation can resume.")
            } catch (e) {
              setError(e instanceof Error ? e.message : "Reconciliation failed")
            } finally {
              setBusy(false)
            }
          }}
        >
          Verify remote result
        </Button>
      </PlatformSection>
    </section>
  )
}
