"use client"
import Link from "next/link"
import { useEffect,useState } from "react"
import { Button } from "@/components/ui/button"
import { requestJson } from "@/lib/mca/client"
import type { VoiceReadiness as Readiness } from "@/lib/mca/voice/contracts"
/** Read-only onboarding contract. This component never registers audio or provisions numbers. */
export function VoiceReadiness(){
 const [readiness,setReadiness]=useState<Readiness|null>(null),[error,setError]=useState("")
 async function load(){try{setError("");setReadiness(await requestJson<Readiness>("/api/mca/voice/readiness"))}catch{setError("Could not check browser calling readiness.")}}
 useEffect(()=>{let active=true;requestJson<Readiness>("/api/mca/voice/readiness").then(r=>{if(active)setReadiness(r)}).catch(()=>{if(active)setError("Could not check browser calling readiness.")});return()=>{active=false}},[])
 return <section className="space-y-2 rounded-lg border p-4" aria-label="Browser calling readiness"><h3 className="font-semibold">Desktop browser calling</h3><p className="text-sm">{readiness?.ready?`Ready · ${readiness.phone}`:readiness?"Setup required":"Checking readiness…"} · Recording off</p>{readiness?.blockers.map(blocker=><p key={blocker} className="text-sm text-muted-foreground">{blocker}</p>)}{error&&<p role="alert">{error}</p>}<Link href="/settings/connections/voice" className="text-sm underline">Calling setup</Link><p className="text-xs text-muted-foreground">Keep an enabled desktop browser tab open to receive calls.</p><Button size="sm" variant="outline" onClick={()=>void load()}>Check again</Button></section>
}
