"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter } from "@/components/ui/dialog"
import { Table,TableHeader,TableHead,TableBody,TableRow,TableCell } from "@/components/ui/table"
import { requestJson } from "@/lib/mca/client"
import type { platformCompany } from "@/lib/mca/platform-console"
type Detail=Awaited<ReturnType<typeof platformCompany>>
export function CompanyControls({id,paused,owner,ownerCandidates,notifications}:{id:string;paused:boolean}&Pick<Detail,"owner"|"ownerCandidates"|"notifications">) {
  const router=useRouter(),[reason,setReason]=useState(""),[until,setUntil]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("")
  const [membershipId,setMembershipId]=useState(""),[resendId,setResendId]=useState<string|null>(null)
  async function run(input:Record<string,unknown>) {
    setBusy(true);setError("");setNotice("")
    try{await requestJson(`/api/platform/companies/${id}`,{method:"POST",body:JSON.stringify({...input,reason})});setNotice(input.action==="notification_retry"||input.action==="notification_resend"?"Notification queued for delivery. No email was sent inline; the action was audited.":"Company updated. The action was recorded in the audit log.");setResendId(null);router.refresh()}
    catch(e){setError(e instanceof Error?e.message:"Action failed.")}finally{setBusy(false)}
  }
  const disabled=busy||!reason.trim()
  return <div className="space-y-6"><section className="space-y-4 rounded-lg border p-5">
    <h2 className="text-lg font-semibold">Operator controls</h2>
    <p className="text-sm text-muted-foreground">Unpausing clears only the manual hold; normal subscription rules still apply. Extensions never change original trial dates or charge a payment.</p>
    {error&&<p role="alert" className="text-destructive">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <Label className="grid gap-2">Audit reason for any action below (required)<Input value={reason} maxLength={1000} onChange={event=>setReason(event.target.value)} required/></Label>
    <div className="flex flex-wrap gap-3"><Button variant={paused?"outline":"destructive"} disabled={disabled} onClick={()=>void run({action:"access",manualPaused:!paused})}>{paused?"Clear manual pause":"Pause company access"}</Button><Button variant="outline" disabled={disabled} onClick={()=>void run({action:"reconcile"})}>Reconcile with Stripe</Button></div>
    <Label className="grid max-w-sm gap-2">Extend access until (your local time)<Input type="datetime-local" value={until} onChange={event=>setUntil(event.target.value)}/></Label>
    <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={disabled||!until||!Number.isFinite(Date.parse(until))||Date.parse(until)<=Date.now()} onClick={()=>void run({action:"access",accessExtendedUntil:new Date(until).toISOString()})}>Set access extension</Button><Button variant="outline" disabled={disabled} onClick={()=>void run({action:"access",accessExtendedUntil:null})}>Clear extension</Button></div>
    <section className="space-y-3 border-t pt-4"><h3 className="font-semibold">Billing owner</h3>{owner?<><p>{owner.name} · {owner.email} · {owner.status}</p><p className="text-sm text-muted-foreground">An owner is already assigned. Only that owner can transfer ownership through company Team settings.</p></>:<><p className="text-sm text-muted-foreground">This company has no billing owner. Assign an active company administrator so billing notices can be delivered. This operation cannot replace an existing owner.</p><Label className="grid max-w-lg gap-2">Initial owner (active administrators)<select value={membershipId} onChange={event=>setMembershipId(event.target.value)} className="h-9 rounded-md border bg-background px-3"><option value="">Select administrator</option>{ownerCandidates.map(member=><option key={member.membershipId} value={member.membershipId}>{member.name} — {member.email}</option>)}</select></Label>{!ownerCandidates.length&&<p>No eligible active administrators.</p>}<Button variant="outline" disabled={disabled||!membershipId} onClick={()=>void run({action:"assign_owner",membershipId})}>Assign initial billing owner</Button></>}</section>
  </section>
  <section className="space-y-3"><h2 className="text-lg font-semibold">Billing notifications</h2><p className="text-sm text-muted-foreground">Latest 100 notices. Retry preserves the original delivery identity. Explicit resend creates a new notice linked to a delivered original. Both require the audit reason above.</p>
    {!notifications.length?<p>No notifications recorded.</p>:<Table><TableHeader><TableRow><TableHead>Event</TableHead><TableHead>Attempts</TableHead><TableHead>Delivery</TableHead><TableHead>Next attempt</TableHead><TableHead>Action</TableHead></TableRow></TableHeader><TableBody>{notifications.map(row=><TableRow key={row.id}><TableCell>{row.kind}<div className="max-w-xs truncate text-xs text-muted-foreground" title={row.id}>{row.id}</div></TableCell><TableCell>{row.attempts}</TableCell><TableCell>{row.deliveredAt?`Delivered ${row.deliveredAt}`:row.failed?"Retry pending after delivery failure":"Pending"}</TableCell><TableCell>{row.deliveredAt?"—":row.availableAt}</TableCell><TableCell><Button size="sm" variant="outline" disabled={disabled} onClick={()=>row.deliveredAt?setResendId(row.id):void run({action:"notification_retry",notificationId:row.id})}>{row.deliveredAt?"Resend…":"Retry pending notice"}</Button></TableCell></TableRow>)}</TableBody></Table>}
  </section>
  <Dialog open={Boolean(resendId)} onOpenChange={open=>{if(!open&&!busy)setResendId(null)}}><DialogContent><DialogHeader><DialogTitle>Resend delivered billing notice?</DialogTitle><DialogDescription>This creates an additional email with a new delivery identity, linked to the original notice. The worker will send it to the current company owner. Review the recipient and audit reason before confirming.</DialogDescription></DialogHeader><p className="text-sm">Recipient: {owner?.email??"No owner assigned — delivery will wait"}</p><p className="break-words text-sm">Reason: {reason}</p><DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setResendId(null)}>Cancel</Button><Button disabled={disabled||!resendId} onClick={()=>void run({action:"notification_resend",notificationId:resendId})}>Confirm additional email</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
