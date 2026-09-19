"use client"

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { CalendarDays, ChevronLeft, ChevronRight, Plus, RefreshCw, Phone, Clock3, Send, Zap, ExternalLink, CircleCheck, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { addDate, dateInZone, localToIso, type ActivityInput, type CalendarEvent, type CalendarFeed, type CalendarKind, type GoogleConnectionView } from "@/lib/mca/calendar/contracts"

const kinds: { id:CalendarKind;label:string;className:string;icon:typeof Phone }[]=[
  {id:"call",label:"Calls",className:"border-emerald-500 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",icon:Phone},
  {id:"followup",label:"Follow-ups",className:"border-amber-500 bg-amber-500/10 text-amber-900 dark:text-amber-300",icon:Clock3},
  {id:"submission_task",label:"Planned submissions",className:"border-sky-500 bg-sky-500/10 text-sky-800 dark:text-sky-300",icon:Send},
  {id:"automated_followup",label:"Automated follow-ups",className:"border-violet-500 bg-violet-500/10 text-violet-800 dark:text-violet-300",icon:Zap},
  {id:"submission",label:"Sent submissions",className:"border-blue-500 bg-blue-500/10 text-blue-800 dark:text-blue-300",icon:CircleCheck},
  {id:"google",label:"Google Calendar",className:"border-slate-400 bg-slate-500/10 text-slate-700 dark:text-slate-300",icon:CalendarDays},
]
const selectClass="border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
async function api<T>(path:string,init?:RequestInit):Promise<T> {
  const response=await fetch(`/api/mca/calendar${path}`,{...init,cache:"no-store",headers:{"content-type":"application/json",...init?.headers}})
  const data=await response.json()
  if(!response.ok) throw new Error(data.error?.message??"Calendar could not be loaded.")
  return data as T
}
function localInput(value:string,timezone:string):string {
  const date=dateInZone(value,timezone)
  const time=new Intl.DateTimeFormat("en-GB",{timeZone:timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(value))
  return `${date}T${time}`
}
function eventDate(event:CalendarEvent,timezone:string) { return event.allDay?event.start:dateInZone(event.start,timezone) }
function occursOn(event:CalendarEvent,day:string,timezone:string) {
  const first=eventDate(event,timezone)
  const last=event.allDay?addDate(event.end,-1):dateInZone(new Date(Date.parse(event.end)-1),timezone)
  return first<=day && last>=day
}
function dateLabel(date:string,options:Intl.DateTimeFormatOptions) { return new Intl.DateTimeFormat("en-US",{...options,timeZone:"UTC"}).format(new Date(date+"T12:00:00Z")) }
function timeLabel(event:CalendarEvent,timezone:string) {
  return event.allDay?"All day":new Intl.DateTimeFormat("en-US",{timeZone:timezone,hour:"numeric",minute:"2-digit"}).format(new Date(event.start))
}
function EventButton({event,timezone,onClick}:{event:CalendarEvent;timezone:string;onClick:()=>void}) {
  const kind=kinds.find(k=>k.id===event.kind)!,Icon=kind.icon
  return <button type="button" onClick={onClick} className={cn("w-full rounded-r-md border-l-[3px] px-2 py-2 text-left text-xs transition-colors hover:brightness-95 focus-visible:outline-2 focus-visible:outline-ring",kind.className,event.status==="cancelled"&&"opacity-60")}>
    <span className="flex items-center gap-1.5"><Icon className="size-3 shrink-0"/><span className="truncate font-medium">{timeLabel(event,timezone)}</span>{event.conflict&&<AlertCircle aria-label="Sync conflict" className="ml-auto size-3.5"/>}</span>
    <span className="mt-1 block break-words font-semibold">{event.title}</span>
    {event.dealName&&<span className="mt-0.5 block truncate opacity-80">{event.dealName}</span>}
    {!["scheduled","pending"].includes(event.status)&&<span className="mt-1 block capitalize">{event.status.replaceAll("_"," ")}</span>}
  </button>
}

function ActivityDialog({event,feed,date,dealId,onClose,onSaved}:{event:CalendarEvent|null;feed:CalendarFeed;date:string;dealId?:string;onClose:()=>void;onSaved:()=>void}) {
  const readonly=Boolean(event && !event.editable)
  const initialTimezone=event?.timezone??feed.timezone
  const [form,setForm]=useState({dealId:event?.dealId??dealId??"",assigneeId:event?.assigneeId??feed.membershipId,kind:(event?.kind??"call") as ActivityInput["kind"],title:event?.title??"",start:event?(event.allDay?event.start:localInput(event.start,initialTimezone)):`${date}T09:00`,end:event?(event.allDay?event.end:localInput(event.end,initialTimezone)):`${date}T09:30`,allDay:event?.allDay??false,timezone:initialTimezone,notes:event?.notes??"",status:(event?.status??"scheduled") as ActivityInput["status"]})
  const [busy,setBusy]=useState(false),[error,setError]=useState("")
  const patch=(values:Partial<typeof form>)=>setForm(current=>({...current,...values}))
  async function save(status=form.status) {
    setError("");setBusy(true)
    try {
      const start=form.allDay?form.start:localToIso(form.start,form.timezone,event?.timezone===form.timezone?event?.start:undefined),end=form.allDay?form.end:localToIso(form.end,form.timezone,event?.timezone===form.timezone?event?.end:undefined)
      if(!start||!end) throw new Error("This local time does not exist in the selected timezone. Choose another time.")
      await api(event?`/activities/${event.id}`:"",{method:event?"PATCH":"POST",body:JSON.stringify({...form,start,end,status,version:event?.version})})
      onSaved();onClose()
    } catch(error) { setError(error instanceof Error?error.message:"The activity could not be saved.") } finally { setBusy(false) }
  }
  async function resolve(choice:"local"|"google") {
    setBusy(true);setError("")
    try { await api(`/activities/${event!.id}/resolve`,{method:"POST",body:JSON.stringify({choice,version:event!.version,etag:event!.conflict!.etag})});onSaved();onClose() }
    catch(error) { setError(error instanceof Error?error.message:"Could not resolve this conflict.") } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose()}}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{event?readonly?"Activity details":"Edit activity":"Schedule activity"}</DialogTitle><DialogDescription>{readonly?"This activity is managed by its source.":"Keep your next step attached to the deal."}</DialogDescription></DialogHeader>
    {error&&<p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
    {event?.conflict&&<div className="space-y-3 rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm"><p className="font-semibold">This activity changed in both calendars</p><p>Fundlane: {event.title} · {event.start}</p><p>Google: {event.conflict.title??"Deleted event"} · {event.conflict.start??"Cancelled"}</p>{event.conflict.reason&&<p>{event.conflict.reason}</p>}<div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy||readonly} onClick={()=>void resolve("local")}>Keep Fundlane</Button><Button size="sm" variant="outline" disabled={busy||readonly} onClick={()=>void resolve("google")}>Keep Google</Button></div></div>}
    {readonly?<div className="space-y-3"><p className="text-lg font-semibold">{event?.title}</p><p>{event?.dealName}</p><p className="text-sm">{event?.start} – {event?.end}</p><Badge variant="secondary">{event?.status}</Badge>{event?.notes&&<p className="text-sm text-muted-foreground">{event.notes}</p>}</div>:<form onSubmit={e=>{e.preventDefault();void save()}} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="activity-kind">Activity</Label><select id="activity-kind" className={selectClass} value={form.kind} disabled={busy||Boolean(event)} onChange={e=>patch({kind:e.target.value as ActivityInput["kind"]})}><option value="call">Call</option><option value="followup">Follow-up</option><option value="submission_task">Planned submission</option></select></div><div className="space-y-1.5"><Label htmlFor="activity-assignee">Assigned to</Label><select required id="activity-assignee" className={selectClass} value={form.assigneeId} disabled={busy} onChange={e=>patch({assigneeId:e.target.value})}>{feed.assignees.map(a=><option key={a.id} value={a.id}>{a.name}{a.id===feed.membershipId?" (you)":""}</option>)}</select></div></div>
      <div className="space-y-1.5"><Label htmlFor="activity-deal">Deal</Label><select required id="activity-deal" className={selectClass} value={form.dealId} disabled={busy||Boolean(event)||Boolean(dealId)} onChange={e=>patch({dealId:e.target.value})}><option value="">Choose a deal</option>{feed.deals.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
      <div className="space-y-1.5"><Label htmlFor="activity-title">Title</Label><Input id="activity-title" required maxLength={240} placeholder={form.kind==="call"?"Discuss funding options":form.kind==="followup"?"Follow up on bank statements":"Prepare submission package"} value={form.title} disabled={busy} onChange={e=>patch({title:e.target.value})}/></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.allDay} disabled={busy} onChange={e=>{const allDay=e.target.checked;patch({allDay,start:allDay?form.start.slice(0,10):form.start+"T09:00",end:allDay?addDate(form.start.slice(0,10),1):form.start+"T09:30"})}}/>All-day task</label>
      <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="activity-start">Start</Label><Input id="activity-start" required type={form.allDay?"date":"datetime-local"} value={form.start} disabled={busy} onChange={e=>patch({start:e.target.value})}/></div><div className="space-y-1.5"><Label htmlFor="activity-end">{form.allDay?"End (following day)":"End"}</Label><Input id="activity-end" required type={form.allDay?"date":"datetime-local"} value={form.end} disabled={busy} onChange={e=>patch({end:e.target.value})}/></div></div>
      <div className="space-y-1.5"><Label htmlFor="activity-timezone">Timezone</Label><Input id="activity-timezone" required value={form.timezone} disabled={busy} onChange={e=>patch({timezone:e.target.value})}/></div>
      <div className="space-y-1.5"><Label htmlFor="activity-notes">Internal notes</Label><Textarea id="activity-notes" maxLength={5000} value={form.notes} disabled={busy} onChange={e=>patch({notes:e.target.value})}/></div>
      <p className="text-xs text-muted-foreground">{form.kind==="submission_task"?"This is a reminder to submit. Send the package from the deal's Submissions tab.":form.kind==="call"?"Scheduling a call adds a calendar reminder. It does not place the call or invite the merchant.":"This is your personal follow-up task. Automated messages follow their existing schedules."}</p>
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy}>{busy?"Saving…":"Save activity"}</Button>{event&&<><Button type="button" variant="outline" disabled={busy} onClick={()=>void save(form.status==="completed"?"scheduled":"completed")}>{form.status==="completed"?"Reopen":"Mark complete"}</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>void save(form.status==="cancelled"?"scheduled":"cancelled")}>{form.status==="cancelled"?"Restore":"Cancel activity"}</Button></>}</div>
    </form>}
    {event?.href&&<Button variant="link" className="justify-start px-0" asChild><Link href={event.href} onClick={onClose}>{event.dealId?"Open deal":"Open in Google Calendar"}<ExternalLink className="ml-1 size-3.5"/></Link></Button>}
  </DialogContent></Dialog>
}

function GoogleSettings({onChanged}:{onChanged:()=>void}) {
  const [connection,setConnection]=useState<GoogleConnectionView>(),[busy,setBusy]=useState(false),[error,setError]=useState("")
  const load=useCallback(()=>{void api<GoogleConnectionView>("/google").then(value=>{setConnection(value);setError("")}).catch(e=>setError(e.message))},[])
  useEffect(()=>{load();const interval=setInterval(load,30000);return()=>clearInterval(interval)},[load])
  async function change(action:string,calendarIds?:string[]) {
    setBusy(true);setError("")
    try {setConnection(await api("/google",{method:"PATCH",body:JSON.stringify({action,calendarIds})}));onChanged()}
    catch(e){setError(e instanceof Error?e.message:"Could not update Google Calendar.")}finally{setBusy(false)}
  }
  async function connect() {
    setBusy(true);setError("")
    try { const result=await api<{url:string}>("/google/connect",{method:"POST"});window.location.assign(result.url) }
    catch(e){setError(e instanceof Error?e.message:"Could not connect Google Calendar.");setBusy(false)}
  }
  return <div className="space-y-3 border-t pt-4"><div className="flex items-center gap-2 text-sm font-semibold"><CalendarDays className="size-4"/>Google Calendar</div>{error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
    {!connection?<p className="text-xs text-muted-foreground">Loading connection…</p>:<>
      {connection.connected?<><p className="break-all text-xs">{connection.email}</p><Badge variant="secondary">{connection.enabled?connection.status:"Sync paused"}</Badge>{connection.lastSync&&<p className="text-xs text-muted-foreground">Last synced {new Date(connection.lastSync).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</p>}{connection.error&&<p className="text-xs text-destructive">{connection.error}</p>}
        {connection.calendars.map(calendar=><label key={calendar.id} className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" disabled={busy} checked={calendar.selected} onChange={e=>void change("select",connection.calendars.filter(c=>c.id===calendar.id?e.target.checked:c.selected).map(c=>c.id))}/><span>{calendar.name}</span></label>)}
        <p className="text-xs text-muted-foreground">Google events are visible only to you. The overlay covers the past 93 days and next year.</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy||!connection.enabled||connection.status==="reconnect"} onClick={()=>void change("sync")}>Retry sync</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void change("disconnect")}>Disconnect</Button></div>{connection.status==="reconnect"&&<Button size="sm" disabled={busy||!connection.enabled} onClick={()=>void connect()}>Reconnect Google</Button>}
      </>:<><p className="text-xs text-muted-foreground">See your availability here and keep pipeline appointments in sync.</p><Button size="sm" className="w-full" disabled={busy||!connection.configured||!connection.enabled} onClick={()=>void connect()}>Connect Google</Button>{(!connection.configured||!connection.enabled)&&<p className="text-xs text-muted-foreground">Google Calendar sync is not running in this environment. You can schedule pipeline activity now.</p>}</>}
    </>}
  </div>
}

const subscribeViewport=(listener:()=>void)=>{
  const query=window.matchMedia("(max-width: 640px)")
  query.addEventListener("change",listener)
  return()=>query.removeEventListener("change",listener)
}
const mobileSnapshot=()=>window.matchMedia("(max-width: 640px)").matches
const serverMobileSnapshot=()=>false

export function CalendarWorkspace({dealId}:{dealId?:string}) {
  const [date,setDate]=useState(()=>dateInZone(new Date(),"America/New_York"))
  const mobile=useSyncExternalStore(subscribeViewport,mobileSnapshot,serverMobileSnapshot)
  const [chosenView,setView]=useState<"month"|"week"|"day"|"agenda">()
  const view=chosenView??(dealId||mobile?"agenda":"month")
  const [scope,setScope]=useState("mine"),[feed,setFeed]=useState<CalendarFeed>(),[loading,setLoading]=useState(true),[error,setError]=useState("")
  const [revision,setRevision]=useState(0),[filters,setFilters]=useState<CalendarKind[]>(kinds.map(k=>k.id)),[showCancelled,setShowCancelled]=useState(false)
  const [dialog,setDialog]=useState<{event:CalendarEvent|null;date:string}|null>(null)
  const timezone=feed?.timezone??"America/New_York"
  const days=useMemo(()=>{
    let start=date,count=1
    if(dealId){start=addDate(dateInZone(new Date(),timezone),-7);count=92}
    else if(view==="month") {start=date.slice(0,7)+"-01";start=addDate(start,-new Date(start+"T12:00:00Z").getUTCDay());count=42}
    else if(view==="week") {start=addDate(date,-new Date(date+"T12:00:00Z").getUTCDay());count=7}
    else if(view==="agenda") count=30
    return Array.from({length:count},(_,i)=>addDate(start,i))
  },[date,view,dealId,timezone])
  const refresh=useCallback(()=>setRevision(v=>v+1),[])
  useEffect(()=>{
    const controller=new AbortController()
    const query=new URLSearchParams({from:localToIso(days[0]+"T00:00",timezone)??days[0]+"T00:00:00Z",to:localToIso(addDate(days.at(-1)!,1)+"T00:00",timezone)??addDate(days.at(-1)!,1)+"T00:00:00Z",scope,...(dealId?{dealId}:{})})
    void api<CalendarFeed>("?"+query,{signal:controller.signal}).then(result=>{setFeed(result);setError("");setLoading(false)}).catch(e=>{if(e.name!=="AbortError"){setError(e.message);setLoading(false)}})
    return()=>controller.abort()
  },[days,scope,dealId,revision,timezone])
  useEffect(()=>{const interval=setInterval(refresh,30000);window.addEventListener("focus",refresh);return()=>{clearInterval(interval);window.removeEventListener("focus",refresh)}},[refresh])
  const events=feed?.events.filter(e=>filters.includes(e.kind)&&(showCancelled||e.status!=="cancelled"))??[]
  function navigate(direction:number){if(view==="month"){const d=new Date(date.slice(0,7)+"-01T12:00:00Z");d.setUTCMonth(d.getUTCMonth()+direction);setDate(d.toISOString().slice(0,10))}else setDate(addDate(date,direction*(view==="week"?7:view==="agenda"?30:1)))}
  const today=dateInZone(new Date(),timezone)
  return <section className={cn("space-y-4",!dealId&&"px-4 pb-6 lg:px-6")}>
    {!dealId&&<div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">Calendar</h1><p className="mt-1 text-sm text-muted-foreground">Calls, follow-ups, and submissions. Every next step, in one place.</p></div><Button disabled={!feed} onClick={()=>setDialog({event:null,date:today})}><Plus className="mr-1 size-4"/>Schedule activity</Button></div>}
    {typeof window!=="undefined"&&new URLSearchParams(window.location.search).get("google")==="failed"&&<p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">Google could not be connected. Try again and allow the requested calendar permissions.</p>}
    <div className={cn("flex flex-col overflow-hidden rounded-xl border bg-background",!dealId&&"lg:grid lg:grid-cols-[220px_minmax(0,1fr)]")}>
      {!dealId&&<aside className="order-2 space-y-5 border-t p-4 lg:order-none lg:border-t-0 lg:border-r"><div className="flex items-center gap-3"><div className="flex size-12 flex-col items-center justify-center rounded-lg bg-primary text-primary-foreground"><span className="text-[10px]">{dateLabel(today,{month:"short"})}</span><span className="text-xl font-semibold leading-none">{today.slice(8)}</span></div><div><p className="text-sm font-medium">Your workday</p><p className="text-xs text-muted-foreground">{events.filter(e=>occursOn(e,today,timezone)&&e.status==="scheduled").length} upcoming today</p></div></div><div className="space-y-2"><p className="text-sm font-semibold">Show on calendar</p>{kinds.map(kind=><label key={kind.id} className="flex items-center gap-2 py-0.5 text-xs"><input type="checkbox" checked={filters.includes(kind.id)} onChange={e=>setFilters(current=>e.target.checked?[...current,kind.id]:current.filter(id=>id!==kind.id))}/><span className={cn("size-2 rounded-full border",kind.className)}/>{kind.label}</label>)}<label className="flex items-center gap-2 pt-2 text-xs text-muted-foreground"><input type="checkbox" checked={showCancelled} onChange={e=>setShowCancelled(e.target.checked)}/>Include cancelled</label></div><GoogleSettings onChanged={refresh}/></aside>}
      <div className="order-1 min-w-0 lg:order-none"><div className="flex flex-wrap items-center justify-between gap-3 border-b p-3"><div className="flex items-center gap-1">{!dealId&&<><Button size="icon" variant="ghost" aria-label="Previous period" onClick={()=>navigate(-1)}><ChevronLeft className="size-4"/></Button><Button size="icon" variant="ghost" aria-label="Next period" onClick={()=>navigate(1)}><ChevronRight className="size-4"/></Button></>}<h2 className="px-1 text-base font-semibold">{dealId?"Deal schedule":dateLabel(date,{month:"long",year:"numeric",...(view==="day"?{day:"numeric"}:{})})}</h2>{!dealId&&<Button size="sm" variant="outline" onClick={()=>setDate(today)}>Today</Button>}</div><div className="flex flex-wrap items-center gap-2"><select aria-label="Calendar ownership" className={cn(selectClass,"w-auto")} value={scope} onChange={e=>setScope(e.target.value)}><option value="mine">My calendar</option>{feed?.canViewTeam&&<option value="team">Team calendar</option>}</select>{!dealId&&<select aria-label="Calendar view" className={cn(selectClass,"w-auto")} value={view} onChange={e=>setView(e.target.value as typeof view)}>{["month","week","day","agenda"].map(v=><option key={v} value={v}>{v[0].toUpperCase()+v.slice(1)}</option>)}</select>}<Button size="icon" variant="ghost" aria-label="Refresh calendar" onClick={refresh}><RefreshCw className="size-4"/></Button>{dealId&&<Button size="sm" disabled={!feed} onClick={()=>setDialog({event:null,date:today})}><Plus className="mr-1 size-4"/>Schedule</Button>}</div></div>
        <div className="flex items-center justify-between border-b px-4 py-2 text-xs text-muted-foreground"><span>{timezone}</span><span>{events.length} activities in this period</span></div>
        {error?<div role="alert" className="space-y-3 p-8 text-center"><p className="text-sm text-destructive">{error}</p><Button variant="outline" onClick={refresh}>Retry</Button></div>:loading?<p className="p-10 text-center text-sm text-muted-foreground">Loading your calendar…</p>:view==="month"||view==="week"?<div className="overflow-x-auto"><div className="grid min-w-[630px] grid-cols-7">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=><div key={d} className="border-b px-2 py-2 text-center text-xs font-medium text-muted-foreground">{d}</div>)}{days.map(day=><div key={day} className={cn("min-h-32 space-y-1.5 border-r border-b p-1.5 last:border-r-0",view==="week"&&"min-h-96",view==="month"&&day.slice(0,7)!==date.slice(0,7)&&"bg-muted/35",day===today&&"bg-primary/[0.035]")}><button type="button" aria-label={`Schedule activity on ${day}`} className={cn("mb-1 flex size-7 items-center justify-center rounded-full text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",day===today&&"bg-primary text-primary-foreground hover:bg-primary/90")} onClick={()=>setDialog({event:null,date:day})}>{Number(day.slice(8))}</button>{events.filter(e=>occursOn(e,day,timezone)).map(event=><EventButton key={event.id} event={event} timezone={timezone} onClick={()=>setDialog({event,date:day})}/>)}</div>)}</div></div>:<div className="divide-y">{days.filter(day=>view==="day"||events.some(e=>occursOn(e,day,timezone))).map(day=><div key={day} className="grid gap-3 p-4 sm:grid-cols-[110px_minmax(0,1fr)]"><div><p className="text-sm font-semibold">{dateLabel(day,{weekday:"short",month:"short",day:"numeric"})}</p>{day===today&&<p className="text-xs text-primary">Today</p>}</div><div className="space-y-2">{events.filter(e=>occursOn(e,day,timezone)).map(event=><EventButton key={event.id} event={event} timezone={timezone} onClick={()=>setDialog({event,date:day})}/>)}</div></div>)}{!events.length&&<div className="space-y-3 p-10 text-center"><CalendarDays className="mx-auto size-8 text-muted-foreground"/><p className="font-medium">Room for your next step</p><p className="text-sm text-muted-foreground">Schedule a call, follow-up, or submission reminder.</p><Button variant="outline" disabled={!feed} onClick={()=>setDialog({event:null,date:today})}>Schedule activity</Button></div>}</div>}
      </div>
    </div>
    {dialog&&feed&&<ActivityDialog event={dialog.event} feed={feed} date={dialog.date} dealId={dealId} onClose={()=>setDialog(null)} onSaved={refresh}/>}
  </section>
}
