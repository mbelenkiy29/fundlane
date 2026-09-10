"use client"

import * as React from "react"
import { Loader2, MessageSquareText, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { SmsAccount, SmsSenderKind } from "@/lib/mca/sms/contracts"

type Membership = { id: string; name: string; email: string; role: string; status: string }
type AccountsPayload = { accounts: SmsAccount[]; canManage: boolean }

const emptyForm = {
  label: "",
  senderKind: "phone_number" as SmsSenderKind,
  senderIdentity: "",
  credentialRef: "DEFAULT",
  memberIds: [] as string[],
  isDefault: false,
}

function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    const fields = Object.values(error.fieldErrors ?? {}).flat().filter(Boolean)
    return fields.length ? fields.join(" ") : error.message
  }
  return error instanceof Error ? error.message : "SMS settings could not be updated."
}

export function SmsConnectionsPanel() {
  const [payload, setPayload] = React.useState<AccountsPayload>()
  const [members, setMembers] = React.useState<Membership[]>([])
  const [form, setForm] = React.useState(emptyForm)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [notice, setNotice] = React.useState<string>()

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const next = await requestJson<AccountsPayload>("/api/mca/sms/accounts")
      setPayload({ ...next, accounts: next.accounts.filter((account) => account.credentialRef !== "MANAGED") })
      if (next.canManage) {
        const listed = await requestJson<{ memberships: Membership[] }>("/api/memberships")
        setMembers((listed.memberships ?? []).filter((member) => member.status === "active"))
      }
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy("create")
    setError(undefined)
    setNotice(undefined)
    try {
      await requestJson("/api/mca/sms/accounts", { method: "POST", body: JSON.stringify(form) })
      setForm(emptyForm)
      setNotice("SMS account saved. It can send only when its matching server credential is configured.")
      await load()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(undefined)
    }
  }

  async function update(account: SmsAccount, change: Record<string, unknown>, success: string) {
    setBusy(account.id)
    setError(undefined)
    setNotice(undefined)
    try {
      await requestJson(`/api/mca/sms/accounts/${encodeURIComponent(account.id)}`, { method: "PATCH", body: JSON.stringify(change) })
      setNotice(success)
      await load()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(undefined)
    }
  }

  if (loading) return <Card><CardContent className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading SMS accounts…</CardContent></Card>

  return <Card>
    <CardHeader>
      <div className="flex items-start gap-3"><div className="rounded-md bg-muted p-2"><MessageSquareText className="size-5" /></div><div>
        <CardTitle>Text message accounts</CardTitle>
        <CardDescription>Assign verified Twilio senders to team members. Merchant consent is checked again for every send.</CardDescription>
      </div></div>
    </CardHeader>
    <CardContent className="space-y-5">
      {error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
      {notice && <div role="status" className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}

      {!payload?.accounts.length ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No text message accounts are configured.</div> : <div className="space-y-3">
        {payload.accounts.map((account) => <div key={account.id} className="rounded-lg border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{account.label}</p>{account.isDefault && <Badge>Default</Badge>}<Badge variant={account.state === "active" ? "secondary" : "destructive"}>{account.state}</Badge><Badge variant={account.providerConfigured ? "default" : "outline"}>{account.providerConfigured ? "Provider configured" : "Credentials absent"}</Badge></div>
              <p className="mt-1 text-sm text-muted-foreground">Twilio · {account.senderMasked} · credential {account.credentialRef}</p>
            </div>
            {payload.canManage && account.state === "active" && <div className="flex gap-2">{!account.isDefault && <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void update(account, { isDefault: true }, `${account.label} is now the default.`)}>Make default</Button>}<Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void update(account, { state: "revoked" }, `${account.label} was revoked.`)}>Revoke</Button></div>}
          </div>
          <div className="mt-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Assigned team members</p><div className="mt-2 flex flex-wrap gap-2">
            {members.filter((member) => account.memberIds.includes(member.id)).map((member) => <Badge key={member.id} variant="outline">{member.name}</Badge>)}
            {!members.some((member) => account.memberIds.includes(member.id)) && <span className="text-sm text-muted-foreground">{account.memberIds.length} assigned</span>}
          </div></div>
          {payload.canManage && account.state === "active" && members.length > 0 && <fieldset className="mt-3"><legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Change assignments</legend><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{members.map((member) => <Label key={member.id} className="flex items-center gap-2 rounded-md border p-2 text-sm"><input type="checkbox" checked={account.memberIds.includes(member.id)} onChange={(event) => {
            const memberIds = event.target.checked ? [...account.memberIds, member.id] : account.memberIds.filter((id) => id !== member.id)
            if (memberIds.length) void update(account, { memberIds }, `Assignments for ${account.label} were updated.`)
            else setError("Keep at least one active team member assigned to an SMS account.")
          }} />{member.name}</Label>)}</div></fieldset>}
        </div>)}
      </div>}

      {payload?.canManage && <form onSubmit={create} className="space-y-4 rounded-lg border p-4">
        <div><h3 className="font-medium">Add a Twilio sender</h3><p className="text-sm text-muted-foreground">Credentials stay in the server environment. This form stores only a reference and masked sender identity.</p></div>
        <div className="grid gap-4 md:grid-cols-2">
          <Label className="grid gap-2">Account label<Input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="Merchant texting" required /></Label>
          <Label className="grid gap-2">Sender type<select className="h-9 rounded-md border bg-transparent px-3 text-sm" value={form.senderKind} onChange={(event) => setForm({ ...form, senderKind: event.target.value as SmsSenderKind, senderIdentity: "" })}><option value="phone_number">Phone number</option><option value="messaging_service">Messaging Service</option></select></Label>
          <Label className="grid gap-2">{form.senderKind === "phone_number" ? "Sender phone (E.164)" : "Messaging Service SID"}<Input value={form.senderIdentity} onChange={(event) => setForm({ ...form, senderIdentity: event.target.value })} placeholder={form.senderKind === "phone_number" ? "+12125551212" : "MG…"} required /></Label>
          <Label className="grid gap-2">Credential reference<Input value={form.credentialRef} onChange={(event) => setForm({ ...form, credentialRef: event.target.value.toUpperCase() })} pattern="[A-Z][A-Z0-9_]*" required /><span className="text-xs font-normal text-muted-foreground">Must exactly match a reference under this workspace in MCA_SMS_TWILIO_ACCOUNTS_JSON.</span></Label>
        </div>
        <fieldset><legend className="text-sm font-medium">Allowed team members</legend><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{members.map((member) => <Label key={member.id} className="flex items-center gap-2 rounded-md border p-2 text-sm"><input type="checkbox" checked={form.memberIds.includes(member.id)} onChange={(event) => setForm({ ...form, memberIds: event.target.checked ? [...form.memberIds, member.id] : form.memberIds.filter((id) => id !== member.id) })} />{member.name} <span className="text-muted-foreground">({member.role})</span></Label>)}</div></fieldset>
        <Label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isDefault} onChange={(event) => setForm({ ...form, isDefault: event.target.checked })} />Use as the workspace default</Label>
        <Button disabled={Boolean(busy) || !form.memberIds.length}>{busy === "create" && <Loader2 className="animate-spin" />}Save SMS account</Button>
      </form>}

      <div className="flex gap-3 rounded-lg bg-muted/50 p-4 text-sm"><ShieldCheck className="mt-0.5 size-5 shrink-0" /><p><span className="font-medium">Activation stays fail closed.</span> An account marked “Credentials absent” cannot send. Configure its workspace-specific secret, allowed sender, public HTTPS callback URL, and Twilio Advanced Opt-Out in the deployment environment before use.</p></div>
    </CardContent>
  </Card>
}
