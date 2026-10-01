"use client"
import { Phone } from "lucide-react"
import { Button } from "@/components/ui/button"
export const VOICE_LAUNCH_EVENT="fundlane:voice-call"
export function launchVoiceCall(dealId:string){window.dispatchEvent(new CustomEvent(VOICE_LAUNCH_EVENT,{detail:{dealId}}))}
export function VoiceLauncher({dealId,label="Call"}:{dealId:string;label?:string}){return <Button size="sm" variant="outline" onClick={()=>launchVoiceCall(dealId)}><Phone className="size-3.5"/>{label}</Button>}
