"use client"
import {useEffect,useState} from "react"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {Label} from "@/components/ui/label"
import {requestJson} from "@/lib/mca/client"
import {VoiceReadiness} from "./voice-readiness"
export function VoiceSettings(){
 const [numbers,setNumbers]=useState<{id:string;phone:string;state:string}[]>([]),[numberId,setNumberId]=useState(""),[applicationSid,setApplicationSid]=useState(""),[confirmed,setConfirmed]=useState(false),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0)
 useEffect(()=>{let active=true;requestJson<{numbers:{id:string;phone:string;state:string}[]}>("/api/mca/sms/onboarding").then(r=>{if(active)setNumbers(r.numbers.filter(n=>!["released","releasing"].includes(n.state)))}).catch(()=>{if(active)setMessage("Company numbers could not be loaded.")});return()=>{active=false}},[])
 async function save(){setBusy(true);try{await requestJson("/api/mca/voice/config",{method:"POST",body:JSON.stringify({numberId,applicationSid,callbacksConfirmed:confirmed})});setMessage("Calling settings saved. Review readiness below.");setRevision(v=>v+1)}catch(error){setMessage(error instanceof Error?error.message:"Settings could not be saved.")}finally{setBusy(false)}}
 return <div className="space-y-4"><h2 className="text-xl font-semibold">Desktop browser calls</h2><p className="text-sm text-muted-foreground">Select an existing company number. Your administrator configures Twilio Voice callbacks separately. Recording stays off.</p><Label htmlFor="voice-number">Company designated number</Label><select id="voice-number" className="block rounded border p-2" value={numberId} onChange={e=>setNumberId(e.target.value)}><option value="">Choose number</option>{numbers.map(n=><option key={n.id} value={n.id}>{n.phone}</option>)}</select><Label htmlFor="voice-application">Existing TwiML application SID</Label><Input id="voice-application" value={applicationSid} onChange={e=>setApplicationSid(e.target.value)} placeholder="AP…"/><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Voice application and number webhooks are configured for this company.</label><Button disabled={busy||!numberId||!/^AP[0-9a-f]{32}$/i.test(applicationSid)} onClick={()=>void save()}>Save calling settings</Button>{message&&<p role="status" className="text-sm">{message}</p>}<VoiceReadiness key={revision}/></div>
}
