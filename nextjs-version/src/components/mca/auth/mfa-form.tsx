"use client"
import { useEffect, useState } from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage } from "@/lib/mca/auth-navigation"

type Security = { factors: { id: string; name: string; status: string }[]; verified: boolean }
export function MfaForm() {
  const [state, setState] = useState<Security | null>(null), [factorId, setFactorId] = useState("")
  const [enrollment, setEnrollment] = useState<{ id: string; secret: string; qrCode: string } | null>(null)
  const [code, setCode] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("")
  useEffect(() => { let cancelled = false; requestJson<Security>("/api/auth/mfa").then(data => { if (!cancelled) { setState(data); setFactorId(data.factors[0]?.id ?? "") } }).catch(e => { if (!cancelled) setError(authErrorMessage(e)) }); return () => { cancelled = true } }, [])
  async function run(action: () => Promise<void>) { setBusy(true); setError(""); try { await action() } catch (e) { setError(authErrorMessage(e)) } finally { setBusy(false) } }
  return <div className="space-y-5">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!state ? <p>Loading account security…</p> : state.verified ? <p role="status">Multi-factor authentication is complete for this session.</p> : <>
      {!factorId && <Button disabled={busy} onClick={() => run(async () => { const data = await requestJson<{ id: string; secret: string; qrCode: string }>("/api/auth/mfa", { method: "POST", body: JSON.stringify({ action: "enroll" }) }); setEnrollment(data); setFactorId(data.id) })}>Set up authenticator</Button>}
      {enrollment && <div className="space-y-3"><p>Scan this QR code with your authenticator app, or enter the setup key manually. Keep this key private.</p>{/* Supabase supplies the data URI; never inject SVG markup. */}<Image unoptimized src={enrollment.qrCode} alt="Authenticator setup QR code" width={200} height={200}/><code className="block break-all rounded border p-3">{enrollment.secret}</code></div>}
      {factorId && <form className="space-y-4" onSubmit={e => { e.preventDefault(); void run(async () => { await requestJson("/api/auth/mfa", { method: "POST", body: JSON.stringify({ action: "verify", factorId, code }) }); setEnrollment(null); setCode(""); setState(await requestJson<Security>("/api/auth/mfa")) }) }}>
        {!enrollment && state.factors.length > 1 && <Label className="grid gap-2">Authenticator<select value={factorId} onChange={e => setFactorId(e.target.value)} className="rounded border bg-background p-2">{state.factors.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Label>}
        <Label className="grid gap-2">Authenticator code<Input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required/></Label><Button disabled={busy}>{busy ? "Verifying…" : "Verify authenticator"}</Button>
      </form>}
    </>}
    <Button asChild variant="outline"><a href="/onboarding">Continue to your workspace</a></Button>
  </div>
}
