"use client"

import * as React from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { requestJson } from "@/lib/mca/client"

type Settings = { mode: "off" | "score_only" | "auto_submit"; minMatchScore: number; maxFundersPerDeal: number; eligibleFunderIds: string[] }
type Payload = { settings: Settings; funders: Array<{ id: string; name: string; providerReadiness?: string }> }

export function AutoSubmitSettingsPanel({ enabled }: { enabled: boolean }) {
  const [payload, setPayload] = React.useState<Payload>()
  const [settings, setSettings] = React.useState<Settings>()
  const [message, setMessage] = React.useState<string>()
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!enabled) return
    let active = true
    void requestJson<Payload>("/api/mca/underwriting/auto-submit").then(value => {
      if (active) { setPayload(value); setSettings(value.settings) }
    }).catch(() => {})
    return () => { active = false }
  }, [enabled])
  if (!payload || !settings) return null

  async function save() {
    if (!settings) return
    setBusy(true); setMessage(undefined)
    try {
      const saved = await requestJson<Settings>("/api/mca/underwriting/auto-submit", { method: "POST", body: JSON.stringify(settings) })
      setSettings(saved); setMessage("Auto-submit settings saved.")
    } catch (error) { setMessage(error instanceof Error ? error.message : "Settings could not be saved.") }
    finally { setBusy(false) }
  }

  return <Card>
    <CardHeader><CardTitle>Auto-submit</CardTitle><CardDescription>Available when enabled. Deals must have complete fields and documents. Only selected funders with a ready API adapter are sent; sandbox adapters can send only to sandbox funders in development.</CardDescription></CardHeader>
    <CardContent className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div><Label htmlFor="auto-mode">Mode</Label><Select value={settings.mode} onValueChange={value => setSettings({ ...settings, mode: value as Settings["mode"] })}><SelectTrigger id="auto-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="off">Off</SelectItem><SelectItem value="score_only">Score only</SelectItem><SelectItem value="auto_submit">Auto-submit</SelectItem></SelectContent></Select></div>
        <div><Label htmlFor="auto-score">Minimum match score</Label><Input id="auto-score" type="number" min={0} max={100} value={settings.minMatchScore} onChange={event => setSettings({ ...settings, minMatchScore: Number(event.target.value) })} /></div>
        <div><Label htmlFor="auto-max">Maximum funders per deal</Label><Input id="auto-max" type="number" min={1} max={25} value={settings.maxFundersPerDeal} onChange={event => setSettings({ ...settings, maxFundersPerDeal: Number(event.target.value) })} /></div>
      </div>
      <fieldset><legend className="text-sm font-medium">Eligible funders</legend><div className="grid gap-1 sm:grid-cols-2">{payload.funders.map(funder => <label key={funder.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.eligibleFunderIds.includes(funder.id)} onChange={event => setSettings({ ...settings, eligibleFunderIds: event.target.checked ? [...settings.eligibleFunderIds, funder.id] : settings.eligibleFunderIds.filter(id => id !== funder.id) })} />{funder.name}{funder.providerReadiness && <span className="text-muted-foreground"> · {funder.providerReadiness}</span>}</label>)}</div></fieldset>
      <Button disabled={busy} onClick={() => void save()}>Save auto-submit settings</Button>
      {message && <p role="status" className="text-sm">{message}</p>}
    </CardContent>
  </Card>
}
