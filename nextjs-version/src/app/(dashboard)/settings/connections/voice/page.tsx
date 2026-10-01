import {redirect} from "next/navigation"
import {authenticateSupabaseSession} from "@/lib/mca/supabase-auth"
import {VoiceSettings} from "@/components/mca/voice/voice-settings"
export default async function VoiceSettingsPage(){const session=await authenticateSupabaseSession();if(!session||!["admin","super_admin"].includes(session.role))redirect("/errors/forbidden");return <VoiceSettings/>}
