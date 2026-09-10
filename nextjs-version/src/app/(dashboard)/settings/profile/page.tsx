"use client"

import * as React from "react"
import { LoaderCircle, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DigestSettings } from "@/components/mca/comms/digest-settings"
import { requestJson } from "@/lib/mca/client"
import type { SessionResponse } from "@/lib/mca/types"

export default function ProfilePage() {
  const [session, setSession] = React.useState<SessionResponse | null>(null)
  const [name, setName] = React.useState("")
  const [phone, setPhone] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => { requestJson<SessionResponse>("/api/auth/session").then((value) => { setSession(value); setName(value.user?.name ?? ""); setPhone(value.user?.phone ?? "") }).catch(() => undefined) }, [])
  async function save(event: React.FormEvent) { event.preventDefault(); if (!session?.membership?.id) return; setSaving(true); try { await requestJson(`/api/memberships/${session.membership.id}`, { method: "PATCH", body: JSON.stringify({ name, phone: phone || null }) }); toast.success("Profile saved") } catch (caught) { toast.error(caught instanceof Error ? caught.message : "Profile could not be saved") } finally { setSaving(false) } }
  if (!session) return <div className="flex min-h-56 items-center justify-center rounded-xl border text-sm text-muted-foreground"><LoaderCircle className="mr-2 size-5 animate-spin" /> Loading profile</div>
  return <div className="space-y-5"><div><h2 className="text-lg font-semibold">My profile</h2><p className="text-sm text-muted-foreground">Contact details and immutable application identity.</p></div><Card><CardHeader><CardTitle>Profile details</CardTitle><CardDescription>Your role and reporting line are managed by a workspace administrator.</CardDescription></CardHeader><CardContent><form onSubmit={save} className="grid max-w-2xl gap-5 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="profile-name">Name</Label><Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} required /></div><div className="space-y-2"><Label htmlFor="profile-phone">Phone</Label><Input id="profile-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></div><div className="space-y-2"><Label>Email</Label><Input value={session.user?.email ?? ""} disabled /></div><div className="space-y-2"><Label>Application ID</Label><Input className="font-mono" value={session.user?.applicationIdentifier ?? ""} disabled /></div><div className="sm:col-span-2"><Button disabled={saving}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}{saving ? "Saving" : "Save profile"}</Button></div></form></CardContent></Card><DigestSettings /></div>
}
