"use client"
import { useEffect, useState, type FormEvent } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table"
import type { CompanyOperationsRow, SmsReviewItem, Page } from "@/lib/mca/platform-contracts"

type QueueRow=CompanyOperationsRow|SmsReviewItem
type QueueKind="companies"|"sms"
const words=(value:string)=>value.replaceAll("_"," ")
export function OperationsQueueResults({kind,page,loading=false,error,loadedAt}:{kind:QueueKind;page?:Page<QueueRow>;loading?:boolean;error?:string;loadedAt?:string}) {
 return <div className="min-w-0 space-y-3" aria-busy={loading}>
  {loading&&<p role="status">Loading queue…</p>}
  {error&&<p role="alert">{error} {page?"Stale snapshot: these results could not be refreshed.":"Try refreshing the queue."}</p>}
  {loadedAt&&<p className="text-sm text-muted-foreground">Snapshot loaded {loadedAt}. Provider observation freshness is unverified.</p>}
  {page&&!page.items.length&&<p>No matching {kind==="sms"?"SMS reviews":"companies"}.</p>}
  {!!page?.items.length&&<Table aria-label={kind==="sms"?"SMS review inventory":"Company operations"}><TableHeader><TableRow><TableHead>Company</TableHead>{kind==="companies"?<><TableHead>Owner / seats</TableHead><TableHead>Subscription / access</TableHead><TableHead>SMS / provider</TableHead></>:<><TableHead>Review / submission</TableHead><TableHead>Registration records</TableHead></>}<TableHead>Needs attention</TableHead></TableRow></TableHeader><TableBody>{page.items.map(row=><TableRow key={row.workspaceId}>
   <TableCell><Link className="underline" href={`/platform/companies/${encodeURIComponent(row.workspaceId)}`}>{"name" in row?row.name:row.companyName}</Link><div className="text-xs">{row.workspaceId}</div></TableCell>
   {"name" in row?<><TableCell>{row.ownerEmail??"Owner not assigned"}<div>{row.occupiedSeats} occupied / {row.purchasedSeats} purchased seats</div></TableCell><TableCell>{words(row.subscriptionStatus)} / {words(row.accessState)}</TableCell><TableCell>{words(row.smsReviewState)} / {words(row.providerState)}<div>Observed: {row.observedAt??"unknown"}</div></TableCell></>:<><TableCell>{words(row.reviewState)}<div>Legacy submission · version unavailable</div><div>Submitted: {row.submittedAt??"unknown"}</div></TableCell><TableCell>{row.registrationSummary.length?row.registrationSummary.map(reg=><div key={reg.id} id={`registration-${reg.id}`}><a className="underline" href={`#registration-${encodeURIComponent(reg.id)}`}>{reg.id}</a> · {words(reg.kind)} · attempt {reg.attempt} · {words(reg.state)}</div>):"No registration records"}</TableCell></>}
   <TableCell className="max-w-sm whitespace-normal">{row.blockedReasons.map(words).join("; ")||"None recorded"}</TableCell>
  </TableRow>)}</TableBody></Table>}
 </div>
}
export function OperationsQueues({kind="companies",workspaceId}:{kind?:QueueKind;workspaceId?:string}) {
 const [query,setQuery]=useState({state:"",workspaceId:workspaceId??"",cursor:""})
 const [refresh,setRefresh]=useState(0)
 const [result,setResult]=useState<{key:string;page?:Page<QueueRow>;error?:string;loadedAt?:string}>({key:""})
 const params=new URLSearchParams({kind,limit:"50"})
 for(const [key,value] of Object.entries(query))if(value)params.set(key,value)
 const url=`/api/platform/queues?${params}`
 const key=`${url}:${refresh}`
 useEffect(()=>{
  const controller=new AbortController()
  void fetch(url,{cache:"no-store",signal:controller.signal}).then(async response=>{
   if(!response.ok)throw new Error(response.status===401||response.status===403?"Access denied. Sign in with an authorized owner session.":"Could not load queue.")
   const page:Page<QueueRow>=await response.json()
   if(!controller.signal.aborted)setResult({key,page,loadedAt:new Date().toISOString()})
  }).catch((error:unknown)=>{if(!controller.signal.aborted)setResult(previous=>({key,error:error instanceof Error?error.message:"Could not load queue.",...(previous.key.startsWith(`${url}:`)&&!String(error).includes("Access denied")?{page:previous.page,loadedAt:previous.loadedAt}:{})}))})
  return ()=>controller.abort()
 },[url,key])
 const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget);setQuery({state:String(form.get("state")??""),workspaceId:workspaceId??String(form.get("workspaceId")??"").trim(),cursor:""});setRefresh(n=>n+1)}
 const loading=result.key!==key
 const visible=result.key.startsWith(`${url}:`)?result:undefined
 return <section className="min-w-0 space-y-4"><h2 className="text-xl font-semibold">{kind==="sms"?"SMS review inventory":"Company operations"}</h2><p className="text-sm text-muted-foreground">Read-only inventory. Filters apply to all records before pagination. Provider state is unknown until a verified observation is available.</p>
  <form onSubmit={submit} className="flex flex-wrap items-end gap-3">{!workspaceId&&<Label className="grid gap-2">Company ID<Input name="workspaceId" maxLength={200} defaultValue={query.workspaceId}/></Label>}<Label className="grid gap-2">SMS review state<select name="state" defaultValue={query.state} className="h-9 rounded-md border bg-background px-3"><option value="">All states</option>{["not_started","draft","pending","approved","rejected"].map(state=><option key={state} value={state}>{words(state)}</option>)}</select></Label><Button type="submit">Apply filters</Button><Button type="button" variant="outline" onClick={()=>setRefresh(n=>n+1)}>Refresh queue</Button></form>
  <OperationsQueueResults kind={kind} page={visible?.page} error={visible?.error} loadedAt={visible?.loadedAt} loading={loading}/>
  <nav aria-label="Queue pages" className="flex flex-wrap gap-3">{query.cursor&&<Button variant="outline" disabled={loading} onClick={()=>setQuery(q=>({...q,cursor:""}))}>First page</Button>}{visible?.page?.nextCursor&&<Button variant="outline" disabled={loading} onClick={()=>setQuery(q=>({...q,cursor:visible.page!.nextCursor!}))}>Next 50</Button>}</nav>
 </section>
}
