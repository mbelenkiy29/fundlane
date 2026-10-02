"use client"
import { useEffect, useState } from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage, type CanonicalEnrollmentContinuation } from "@/lib/mca/auth-navigation"

type Security = {
  available: boolean
  enrolled: boolean
  pending: boolean
  recoveryRemaining: number
  enrollmentRequired: boolean
  challengeRequired: boolean
  sessionVerified: boolean
  platformVerified: boolean
  factors: { id: string; name: string; status: string }[]
  verified: boolean
}

export function MfaForm({ mode = "manage", continueTo = "/onboarding" }: { mode?: "manage" | "challenge" | "enroll"; continueTo?: "/onboarding" | "/platform" | CanonicalEnrollmentContinuation }) {
  const continuationLabel = continueTo === "/platform" ? "Continue to platform administration" : "Continue to your workspace"
  const [state, setState] = useState<Security | null>(null)
  const [enrollment, setEnrollment] = useState<{ secret: string; qrCode: string } | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [factorId, setFactorId] = useState("")

  useEffect(() => {
    let cancelled = false
    requestJson<Security>("/api/auth/mfa").then(data => {
      if (cancelled) return
      setState(data)
      setFactorId(data.factors[0]?.id ?? "")
    }).catch(e => { if (!cancelled) setError(authErrorMessage(e)) })
    return () => { cancelled = true }
  }, [])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError("")
    try { await action() } catch (e) { setError(authErrorMessage(e)) } finally { setBusy(false) }
  }

  async function refresh() {
    setState(await requestJson<Security>("/api/auth/mfa"))
  }

  if (!state && !error) return <p>Loading account security…</p>

  const appTotp = Boolean(state?.available)
  const sessionVerified = continueTo === "/platform" ? state?.platformVerified : state?.sessionVerified
  const challenge = Boolean(appTotp && state?.enrolled && !sessionVerified && (mode === "challenge" || state.challengeRequired))
  const mustEnroll = Boolean(appTotp && (mode === "enroll" || state?.enrollmentRequired) && !state?.enrolled)
  const showLegacy = Boolean(factorId && state?.factors.length && (!state.enrolled || !state.available))

  return <div className="space-y-5">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {state && !state.available && <p role="status">Application authenticator enrollment is unavailable on this deployment. Ask an operator to configure the existing data encryption key. An existing platform authenticator can still be verified below.</p>}
    {mustEnroll && <p role="status">Your company requires an authenticator app before you can use the workspace.</p>}
    {challenge && <p role="status">Enter an authenticator or recovery code to finish signing in.</p>}
    {sessionVerified && mode === "challenge" && !challenge && <p role="status">Authenticator verification is complete. {continuationLabel}.</p>}
    {appTotp && state?.enrolled && !recoveryCodes && !challenge && <p role="status">Authenticator-app two-factor authentication is on. {state.recoveryRemaining} unused recovery codes remain.</p>}
    {recoveryCodes && <div className="space-y-3">
      <p>Store these single-use recovery codes now. They will not be shown again.</p>
      <ul className="grid gap-2 font-mono text-sm">{recoveryCodes.map(item => <li key={item} className="rounded border p-2">{item}</li>)}</ul>
      <Button type="button" variant="outline" onClick={() => setRecoveryCodes(null)}>I have saved these codes</Button>
    </div>}
    {appTotp && enrollment && <div className="space-y-3">
      <p>Scan this QR code with your authenticator app, or enter the setup key manually. Keep this key private.</p>
      <Image unoptimized src={enrollment.qrCode} alt="Authenticator setup QR code" width={200} height={200} />
      <code className="block break-all rounded border p-3">{enrollment.secret}</code>
    </div>}
    {appTotp && !state?.enrolled && !enrollment && <Button disabled={busy} onClick={() => run(async () => {
      const data = await requestJson<{ secret: string; qrCode: string }>("/api/auth/mfa", { method: "POST", body: JSON.stringify({ action: "enroll" }) })
      setEnrollment(data)
    })}>Set up authenticator</Button>}
    {appTotp && (enrollment || challenge) && <form className="space-y-4" onSubmit={e => { e.preventDefault(); void run(async () => {
      if (enrollment) {
        const result = await requestJson<{ recoveryCodes: string[] }>("/api/auth/mfa", { method: "POST", body: JSON.stringify({ action: "confirm", code }) })
        setRecoveryCodes(result.recoveryCodes)
        setEnrollment(null)
      } else {
        await requestJson("/api/auth/mfa", { method: "POST", body: JSON.stringify({ action: "challenge", code }) })
      }
      setCode("")
      await refresh()
    }) }}>
      <Label className="grid gap-2">{enrollment ? "Authenticator code" : "Authenticator or recovery code"}
        <Input value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" required />
      </Label>
      <Button disabled={busy || !code}>{busy ? "Verifying…" : enrollment ? "Confirm authenticator" : "Verify and continue"}</Button>
    </form>}
    {appTotp && state?.enrolled && !challenge && !recoveryCodes && <div className="flex flex-wrap gap-2">
      <form className="space-y-3 rounded border p-4" onSubmit={e => { e.preventDefault(); void run(async () => {
        const result = await requestJson<{ recoveryCodes: string[] }>("/api/auth/mfa", { method: "POST", body: JSON.stringify({ action: "regenerate", code }) })
        setRecoveryCodes(result.recoveryCodes)
        setCode("")
        await refresh()
      }) }}>
        <Label className="grid gap-2">Regenerate recovery codes<Input value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" required /></Label>
        <Button type="submit" variant="outline" disabled={busy}>Regenerate codes</Button>
      </form>
      <form className="space-y-3 rounded border p-4" onSubmit={e => { e.preventDefault(); void run(async () => {
        await requestJson("/api/auth/mfa", { method: "POST", body: JSON.stringify({ action: "disable", code }) })
        setCode("")
        await refresh()
      }) }}>
        <Label className="grid gap-2">Disable two-factor authentication<Input value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" required /></Label>
        <Button type="submit" variant="destructive" disabled={busy}>Disable authenticator</Button>
      </form>
    </div>}
    {showLegacy && state ? <form className="space-y-4" onSubmit={e => { e.preventDefault(); void run(async () => {
      await requestJson("/api/auth/mfa", { method: "POST", body: JSON.stringify({ action: "verify", factorId, code }) })
      setCode("")
      await refresh()
    }) }}>
      <p className="text-sm text-muted-foreground">Existing platform authenticator</p>
      {state.factors.length > 1 && <Label className="grid gap-2">Authenticator<select value={factorId} onChange={e => setFactorId(e.target.value)} className="rounded border bg-background p-2">{state.factors.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Label>}
      <Label className="grid gap-2">Authenticator code<Input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required /></Label>
      <Button disabled={busy}>{busy ? "Verifying…" : "Verify authenticator"}</Button>
    </form> : null}
    <Button asChild variant="outline"><a href={continueTo}>{continuationLabel}</a></Button>
  </div>
}
