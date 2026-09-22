"use client"
import { useEffect,useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter } from "@/components/ui/dialog"
import { requestJson } from "@/lib/mca/client"
import type { MembershipSummary } from "@/lib/mca/types"
export function OwnershipTransfer({members,onTransferred}:{members:MembershipSummary[];onTransferred:()=>void}) {
  const [owner,setOwner]=useState<{ownerMembershipId:string|null;canTransfer:boolean}|null>(null),[target,setTarget]=useState(""),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("")
  useEffect(()=>{void requestJson<{ownerMembershipId:string|null;canTransfer:boolean}>("/api/workspace/ownership").then(setOwner).catch(()=>setOwner(null))},[])
  if(!owner?.canTransfer)return null
  const eligible=members.filter(member=>member.status==="active"&&member.id!==owner.ownerMembershipId)
  return <section className="space-y-3 rounded-lg border p-4"><h3 className="font-semibold">Company ownership</h3><p className="text-sm text-muted-foreground">Transfer billing ownership to an active teammate. The new owner receives billing notifications and administrator access.</p><Label className="grid max-w-sm gap-2">New company owner<select className="h-9 rounded border bg-background px-3" value={target} onChange={event=>setTarget(event.target.value)}><option value="">Select an active member</option>{eligible.map(member=><option key={member.id} value={member.id}>{member.name} ({member.email})</option>)}</select></Label><Button variant="outline" disabled={!target} onClick={()=>setOpen(true)}>Transfer ownership</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Transfer company ownership?</DialogTitle><DialogDescription>{eligible.find(member=>member.id===target)?.name} will become the company owner. You will remain a member, but only the new owner can transfer ownership again.</DialogDescription></DialogHeader>{error&&<p role="alert" className="text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setOpen(false)}>Cancel</Button><Button disabled={busy} onClick={async()=>{setBusy(true);setError("");try{await requestJson("/api/workspace/ownership",{method:"POST",body:JSON.stringify({membershipId:target})});setOwner({...owner,canTransfer:false});setOpen(false);onTransferred()}catch(e){setError(e instanceof Error?e.message:"Transfer failed.")}finally{setBusy(false)}}}>Confirm transfer</Button></DialogFooter></DialogContent></Dialog></section>
}
