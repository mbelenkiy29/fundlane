"use client"
import { useEffect,useRef,useState } from "react"
import { Button } from "@/components/ui/button"
import { requestJson } from "@/lib/mca/client"
import { BrowserVoice,type VoiceSnapshot,type VoiceDevice } from "@/lib/mca/voice/browser"
import type { VoiceReadiness,VoiceHistoryItem } from "@/lib/mca/voice/contracts"
import { VOICE_LAUNCH_EVENT } from "./voice-launcher"
const post=<T,>(url:string,body?:unknown)=>requestJson<T>(`/api/mca/voice/${url}`,{method:"POST",...(body===undefined?{}:{body:JSON.stringify(body)})})
export function VoiceProvider({children}:{children:React.ReactNode}){
 const [snapshot,setSnapshot]=useState<VoiceSnapshot>({state:"disabled",message:"Calling is disabled."}),[readiness,setReadiness]=useState<VoiceReadiness|null>(null),[history,setHistory]=useState<VoiceHistoryItem[]>([]),[open,setOpen]=useState(false),[pendingDeal,setPendingDeal]=useState<string|null>(null),[failure,setFailure]=useState("")
 const controller=useRef<BrowserVoice|null>(null),pending=useRef<string|null>(null),deviceClass=useRef<typeof import("@twilio/voice-sdk").Device|null>(null),setupGeneration=useRef(0)
 const [sdkLoading,setSdkLoading]=useState(false)
 useEffect(()=>{
  let active=true
  async function load(){try{const [r,h]=await Promise.all([requestJson<VoiceReadiness>("/api/mca/voice/readiness"),requestJson<{calls:VoiceHistoryItem[]}>("/api/mca/voice/history")]);if(active){setReadiness(r);setHistory(h.calls);setFailure("")}}catch{if(active)setFailure("Calling information is unavailable. Try again.")}}
  // SDK is loaded only after enable, never on mount.
  const voice=new BrowserVoice({createDevice:token=>{const Device=deviceClass.current;if(!Device)throw Error("SDK not loaded");return new Device(token,{allowIncomingWhileBusy:false}) as unknown as VoiceDevice},token:()=>post<{token:string}>("token"),presence:enabled=>post("presence",{enabled}),intent:dealId=>post<{intentId:string}>("dial-intents",{dealId}),cancelIntent:intentId=>post("cancel",{intentId}),onState:s=>{if(active){setSnapshot(s);if(s.state==="incoming")setOpen(true);if(s.state==="ready")void load()}}})
  controller.current=voice
  const launch=(event:Event)=>{const dealId=(event as CustomEvent<{dealId?:string}>).detail?.dealId;if(!dealId)return;pending.current=dealId;setPendingDeal(dealId);setOpen(true)}
  window.addEventListener(VOICE_LAUNCH_EVENT,launch);void load()
  const timer=setInterval(()=>void load(),30_000)
  return()=>{active=false;clearInterval(timer);window.removeEventListener(VOICE_LAUNCH_EVENT,launch);controller.current=null;void voice.disable()}
 },[])
 async function enable(){
  const voice=controller.current;if(!voice||sdkLoading)return
  const generation=++setupGeneration.current;setSdkLoading(true)
  try{const {Device}=await import("@twilio/voice-sdk");if(generation!==setupGeneration.current||controller.current!==voice)return;deviceClass.current=Device;await voice.enable()}catch{if(generation===setupGeneration.current)setFailure("Browser calling could not load. Retry.")}finally{if(generation===setupGeneration.current)setSdkLoading(false)}
 }
 function disable(){++setupGeneration.current;setSdkLoading(false);pending.current=null;setPendingDeal(null);void controller.current?.disable()}
 async function call(){const id=pending.current;if(id){pending.current=null;setPendingDeal(null);await controller.current?.dial(id)}}
 const busy=["dialing","incoming","connected"].includes(snapshot.state)
 return <>{children}<div className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-background p-3 shadow-lg"><div className="flex items-center justify-between"><Button size="sm" variant="ghost" onClick={()=>setOpen(v=>!v)}>Browser calls{history.some(c=>c.state==="missed")?" · missed":""}</Button>{busy&&<span className="text-xs" role="status">{snapshot.state}</span>}</div>{open&&<div className="space-y-3 pt-2"><p role="status" className="text-sm">{snapshot.message}</p><p className="text-xs text-muted-foreground">{readiness?.phone??"No designated number"} · Recording off · Keep this desktop tab open</p>{failure&&<p role="alert" className="text-sm">{failure}</p>}{readiness?.blockers.map(b=><p key={b} className="text-xs">{b}</p>)}<div className="flex flex-wrap gap-2">{["disabled","error"].includes(snapshot.state)&&<Button size="sm" disabled={!readiness?.ready||sdkLoading} onClick={()=>void enable()}>{snapshot.state==="error"?"Retry calling":"Enable calling"}</Button>}{(snapshot.state==="registering"||sdkLoading)&&<Button size="sm" variant="outline" onClick={disable}>Cancel setup</Button>}{snapshot.state==="ready"&&pendingDeal&&<Button size="sm" onClick={()=>void call()}>Call merchant</Button>}{snapshot.state==="incoming"&&<Button size="sm" onClick={()=>controller.current?.answer()}>Answer {snapshot.caller}</Button>}{busy&&<Button size="sm" variant="outline" onClick={()=>void controller.current?.end()}>{snapshot.state==="incoming"?"Reject":snapshot.state==="dialing"?"Cancel call":"Disconnect"}</Button>}{snapshot.state==="ready"&&<Button size="sm" variant="outline" onClick={disable}>Disable calling</Button>}</div><div><h4 className="text-sm font-medium">Recent calls</h4>{!history.length&&<p className="text-xs text-muted-foreground">No calls yet.</p>}{history.slice(0,8).map(c=><p key={c.id} className="text-xs">{c.direction} · {c.phone} · {c.state}</p>)}</div></div>}</div></>
}
