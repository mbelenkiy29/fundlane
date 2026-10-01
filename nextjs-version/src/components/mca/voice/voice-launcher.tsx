"use client"
import { createContext, useContext } from "react"
import { Phone } from "lucide-react"
import { Button } from "@/components/ui/button"
export const VOICE_LAUNCH_EVENT="fundlane:voice-call"
export const VoiceReadyContext=createContext(false)
export const useVoiceReady=()=>useContext(VoiceReadyContext)
export function launchVoiceCall(dealId:string){window.dispatchEvent(new CustomEvent(VOICE_LAUNCH_EVENT,{detail:{dealId}}))}
export function VoiceLauncher({dealId,href,label="Call"}:{dealId:string;href:string;label?:string}){
 const ready=useVoiceReady()
 return ready?<Button size="sm" variant="outline" onClick={()=>launchVoiceCall(dealId)}><Phone className="size-3.5"/>{label}</Button>:<Button size="sm" variant="outline" asChild><a href={href}><Phone className="size-3.5"/>{label}</a></Button>
}
