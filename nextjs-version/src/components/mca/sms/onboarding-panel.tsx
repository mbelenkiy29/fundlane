"use client"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { requestJson } from "@/lib/mca/client"
import { smsChannelStatus } from "@/lib/mca/integrations/connection-status"
import { ConnectionStatusBadge } from "@/components/mca/integrations/connection-status"
import type { SmsReadiness } from "@/lib/mca/sms/contracts"
type Status = {
  optOutReady: boolean
  emailVerified: boolean
  reviewState: string
  reviewNote?: string
  registrationState: string
  suspended: boolean
  platformReady: boolean
  canManage: boolean
  isOperator: boolean
  profile: Record<string, unknown> | null
  limits: { numbers: number; monthlyCents: number; registrationCents: number }
  numbers: {
    id: string
    phone: string
    membership_id: string | null
    state: string
    monthly_cents: number
    readiness: SmsReadiness
  }[]
  operations: {
    id: string
    kind: string
    state: string
    step?: string
    error_code?: string
  }[]
}
const fields = [
  ["legalName", "Legal business name"],
  ["ein", "EIN"],
  ["street", "Street address"],
  ["city", "City"],
  ["region", "State (two letters)"],
  ["postalCode", "ZIP code"],
  ["website", "Business website (https://)"],
  ["contactFirstName", "Contact first name"],
  ["contactLastName", "Contact last name"],
  ["contactEmail", "Contact email"],
  ["contactPhone", "Contact phone (+1…)"],
  ["contactTitle", "Contact job title"],
  ["privacyUrl", "Privacy policy URL"],
  ["termsUrl", "Terms URL"],
]
export function SmsOnboardingPanel() {
  const [status, setStatus] = useState<Status>(),
    [members, setMembers] = useState<
      { id: string; name: string; status: string }[]
    >([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [area, setArea] = useState("212"),
    [employee, setEmployee] = useState(""),
    [available, setAvailable] = useState<
      { phone: string; monthlyCents: number }[]
    >([]),
    [purchase, setPurchase] = useState<{
      phone: string
      monthlyCents: number
    } | null>(null),
    [release, setRelease] = useState<string | null>(null)
  const load = useCallback(async () => {
    const s = await requestJson<Status>("/api/mca/sms/onboarding")
    setStatus(s)
    if (s.canManage) {
      const m = await requestJson<{
        memberships: { id: string; name: string; status: string }[]
      }>("/api/memberships")
      setMembers(m.memberships.filter((x) => x.status === "active"))
    }
  }, [])
  useEffect(() => {
    void load().catch((e) => setError(e.message))
  }, [load])
  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await action()
      setNotice(message)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to complete request")
    } finally {
      setBusy(false)
    }
  }
  const post = (url: string, body: unknown, method = "POST") =>
    requestJson(url, { method, body: JSON.stringify(body) })
  if (!status)
    return (
      <Card>
        <CardContent className="p-6">
          {error || "Loading company SMS setup…"}
        </CardContent>
      </Card>
    )
  const smsStatus = smsChannelStatus({ onboarding: status })
  return (
    <Card id="company-sms">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Company SMS <ConnectionStatusBadge label={smsStatus.label} />
        </CardTitle>
        <CardDescription>
          Verify your company, register application updates, and assign a
          dedicated number to each employee.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!smsStatus.ready && (
          <p className="rounded border bg-muted p-3 text-sm">{smsStatus.detail}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            Email: {status.emailVerified ? "verified" : "not verified"}
          </Badge>
          <Badge variant="outline">Business: {status.reviewState}</Badge>
          <Badge variant="outline">Carrier: {status.registrationState}</Badge>
          {status.suspended && <Badge variant="destructive">Suspended</Badge>}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {status.reviewNote && (
          <p className="rounded border p-3 text-sm">
            Review note: {status.reviewNote}
          </p>
        )}
        {!status.platformReady && (
          <p className="rounded border bg-muted p-3 text-sm">
            SMS activation is awaiting the platform’s Twilio ISV setup and
            application-update eligibility review. You can prepare your business
            information now.
          </p>
        )}
        {status.registrationState !== "not_started" && !status.optOutReady && (
          <p className="text-sm">
            The platform operator must enable and confirm Advanced Opt-Out for
            this company before sending is enabled.
          </p>
        )}
        <div className="flex gap-4 text-sm">
          <a href="/sms" className="underline">
            Open SMS inbox
          </a>
          {status.canManage && (
            <a href="/api/mca/sms/usage?format=csv" className="underline">
              Download usage
            </a>
          )}
          {status.isOperator && (
            <a href="/settings/sms-review" className="underline">
              Company review queue
            </a>
          )}
        </div>
        {status.canManage && (
          <>
            {!status.emailVerified && (
              <div className="space-y-2">
                <p className="text-sm">
                  The company owner must verify their email before submitting
                  business details.
                </p>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () =>
                        post("/api/mca/sms/onboarding", {
                          action: "verify_email",
                        }),
                      "Verification email requested. Check the company owner’s inbox."
                    )
                  }
                >
                  Send verification email
                </Button>
              </div>
            )}
            {status.emailVerified &&
              status.registrationState === "not_started" && (
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const f = new FormData(e.currentTarget),
                      profile: Record<string, unknown> = {}
                    for (const [key, value] of f.entries()) profile[key] = value
                    profile.samples = [f.get("sample1"), f.get("sample2")]
                    delete profile.sample1
                    delete profile.sample2
                    profile.applicationUpdatesOnly =
                      f.get("applicationUpdatesOnly") === "on"
                    void act(
                      () =>
                        post("/api/mca/sms/onboarding", {
                          action: "submit",
                          profile,
                        }),
                      "Business details submitted for review."
                    )
                  }}
                >
                  <h3 className="font-medium">Business verification</h3>
                  <div className="grid gap-4 md:grid-cols-2">
                    {fields.map(([name, label]) => (
                      <Label key={name} className="grid gap-2">
                        {label}
                        <Input
                          name={name}
                          defaultValue={String(status.profile?.[name] ?? "")}
                          required
                        />
                      </Label>
                    ))}
                    <Label className="grid gap-2">
                      Business type
                      <select
                        name="businessType"
                        className="rounded border p-2"
                        defaultValue={String(
                          status.profile?.businessType ??
                            "Limited Liability Corporation"
                        )}
                      >
                        {[
                          "Limited Liability Corporation",
                          "Corporation",
                          "Partnership",
                          "Sole Proprietorship",
                        ].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </Label>
                    <Label className="grid gap-2">
                      Contact position
                      <select
                        name="contactPosition"
                        className="rounded border p-2"
                        defaultValue={String(
                          status.profile?.contactPosition ?? "CEO"
                        )}
                      >
                        {[
                          "CEO",
                          "CFO",
                          "General_Manager",
                          "VP",
                          "Director",
                          "Other",
                        ].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </Label>
                  </div>
                  {[
                    ["purpose", "Describe requested application updates"],
                    [
                      "consentEvidence",
                      "Describe how recipients consent, with evidence URLs",
                    ],
                    ["sample1", "First exact example message"],
                    ["sample2", "Second exact example message"],
                  ].map(([name, label]) => (
                    <Label key={name} className="grid gap-2">
                      {label}
                      <Textarea
                        name={name}
                        minLength={name.startsWith("sample") ? 20 : 30}
                        defaultValue={
                          name.startsWith("sample")
                            ? String(
                                (
                                  status.profile?.samples as
                                    | string[]
                                    | undefined
                                )?.[name === "sample1" ? 0 : 1] ?? ""
                              )
                            : String(status.profile?.[name] ?? "")
                        }
                        required
                      />
                    </Label>
                  ))}
                  <Label className="flex gap-2">
                    <input
                      type="checkbox"
                      name="applicationUpdatesOnly"
                      required
                    />
                    This program is for requested application updates from our
                    privately held US company, with direct recipient consent.
                  </Label>
                  <Button disabled={busy}>Submit business for review</Button>
                </form>
              )}
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Pilot allowance: {status.limits.numbers} numbers · $
                {(status.limits.monthlyCents / 100).toFixed(2)} monthly
                estimated spend · $
                {(status.limits.registrationCents / 100).toFixed(2)}{" "}
                registration allowance. Billing is handled manually. Carrier
                charges can arrive later.
              </p>
              {status.reviewState === "approved" &&
                status.registrationState === "not_started" && (
                  <Button
                    disabled={busy || !status.platformReady || status.suspended}
                    onClick={() =>
                      void act(
                        () =>
                          post("/api/mca/sms/provisioning", {
                            kind: "register",
                            idempotencyKey: "company-registration-v1",
                          }),
                        "Registration queued. Carrier approval can take time; refresh to check progress."
                      )
                    }
                  >
                    Start registration using approved allowance
                  </Button>
                )}{" "}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(
                    () => post("/api/mca/sms/provisioning", {}, "PATCH"),
                    "SMS status refreshed."
                  )
                }
              >
                Refresh registration and jobs
              </Button>
            </div>
            {status.operations.length > 0 && (
              <div className="space-y-2">
                {status.operations.map((o) => (
                  <div key={o.id} className="rounded border p-3 text-sm">
                    <span title={o.id}>
                      {o.kind}: {o.state.replaceAll("_", " ")}
                    </span>
                    <p className="text-xs text-muted-foreground">
                      Operation {o.id}
                    </p>
                    {o.error_code && <span> · {o.error_code}</span>}
                    {o.state === "needs_review" && (
                      <p>
                        A provider response needs operator reconciliation before
                        retrying.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
            {status.registrationState === "approved" && !status.suspended && (
              <div className="space-y-4">
                <h3 className="font-medium">Get an employee number</h3>
                <div className="flex flex-wrap gap-3">
                  <Label>
                    Area code
                    <Input
                      value={area}
                      onChange={(e) => setArea(e.target.value)}
                      maxLength={3}
                      className="w-28"
                    />
                  </Label>
                  <Label>
                    Employee
                    <select
                      className="block rounded border p-2"
                      value={employee}
                      onChange={(e) => setEmployee(e.target.value)}
                    >
                      <option value="">Select employee</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </Label>
                  <Button
                    disabled={busy || !employee}
                    onClick={() =>
                      void act(async () => {
                        const result = await requestJson<{
                          numbers: typeof available
                        }>(
                          `/api/mca/sms/numbers?areaCode=${encodeURIComponent(area)}`
                        )
                        setAvailable(result.numbers)
                      }, "Search complete.")
                    }
                  >
                    Search numbers
                  </Button>
                </div>
                {available.map((n) => (
                  <div
                    key={n.phone}
                    className="flex items-center justify-between rounded border p-3"
                  >
                    <span>
                      {n.phone} · ${(n.monthlyCents / 100).toFixed(2)}/month
                      plus usage
                    </span>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setPurchase(n)}
                    >
                      Select
                    </Button>
                  </div>
                ))}
                {purchase && (
                  <div
                    role="dialog"
                    aria-label="Confirm number purchase"
                    className="space-y-3 rounded border p-4"
                  >
                    <p>
                      Purchase {purchase.phone} for{" "}
                      {members.find((m) => m.id === employee)?.name}? Rental is
                      ${(purchase.monthlyCents / 100).toFixed(2)} per month plus
                      SMS and carrier charges until released.
                    </p>
                    <Button
                      disabled={busy || !employee}
                      onClick={() =>
                        void act(async () => {
                          await post("/api/mca/sms/provisioning", {
                            kind: "purchase",
                            phone: purchase.phone,
                            membershipId: employee,
                            maxMonthlyCents: purchase.monthlyCents,
                            idempotencyKey: `buy:${purchase.phone}:${employee}`,
                          })
                          setPurchase(null)
                          setAvailable([])
                        }, "Number purchase queued.")
                      }
                    >
                      Confirm paid purchase
                    </Button>{" "}
                    <Button variant="outline" onClick={() => setPurchase(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            )}
            <div className="space-y-3">
              {status.numbers.map((n) => (
                <div key={n.id} className="space-y-2 rounded border p-3">
                  <div className="flex justify-between">
                    <span>
                      {n.phone} · {n.state}
                    </span>
                    {n.state !== "released" && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => setRelease(n.id)}
                      >
                        Release number
                      </Button>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground" role="status">
                    {n.readiness.ready ? "Ready for SMS when merchant consent is recorded." : n.readiness.blockers.map((b) => b.message).join(" ")}
                  </p>
                  {n.state !== "released" && (
                    <Label className="block">
                      Assigned employee
                      <select
                        className="ml-3 rounded border p-2"
                        value={n.membership_id ?? ""}
                        disabled={busy}
                        onChange={(e) =>
                          void act(
                            () =>
                              post(
                                "/api/mca/sms/numbers",
                                {
                                  numberId: n.id,
                                  membershipId: e.target.value,
                                },
                                "PATCH"
                              ),
                            "Number reassigned. Deal permissions still control conversation access."
                          )
                        }
                      >
                        <option value="">Unassigned / inactive employee</option>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </Label>
                  )}
                  {release === n.id && (
                    <div role="dialog" aria-label="Confirm number release">
                      <p className="text-sm">
                        Release {n.phone}? You may not be able to get this
                        number back.
                      </p>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await post("/api/mca/sms/provisioning", {
                              kind: "release",
                              numberId: n.id,
                              idempotencyKey: `release:${n.id}`,
                            })
                            setRelease(null)
                          }, "Release queued.")
                        }
                      >
                        Confirm release
                      </Button>{" "}
                      <Button
                        variant="outline"
                        onClick={() => setRelease(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
