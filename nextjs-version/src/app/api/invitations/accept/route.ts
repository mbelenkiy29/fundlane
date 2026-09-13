import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { supabaseIdentity, setActiveWorkspace } from "@/lib/mca/supabase-auth"
import { acceptSupabaseInvitation, inspectSupabaseInvitation } from "@/lib/mca/supabase-team"
import { readJson } from "@/lib/mca/http"
import { apiError, AppError } from "@/lib/mca/errors"
const tokenSchema=z.string().min(20).max(300)
export async function GET(request: Request) {
  try { await consumeRequestRateLimit(clientRateKey(request,"invite-preview"),30);return NextResponse.json(await inspectSupabaseInvitation(tokenSchema.parse(new URL(request.url).searchParams.get("token"))),{ headers:{ "Cache-Control":"no-store" } }) } catch(error) { return apiError(error instanceof z.ZodError ? new AppError(400,"invitation_invalid","This invitation is invalid or expired.") : error) }
}
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request);await consumeRequestRateLimit(clientRateKey(request,"invite-accept"),20)
    const { token }=await readJson(request,z.object({ token:tokenSchema }))
    const identity=await supabaseIdentity()
    if (!identity) throw new AppError(401,"authentication_required","Verify your email and sign in before accepting this invitation.")
    const workspaceId=await acceptSupabaseInvitation(identity,token);await setActiveWorkspace(identity,workspaceId)
    return NextResponse.json({ success:true,workspaceId })
  } catch(error) { return apiError(error instanceof z.ZodError ? new AppError(400,"invitation_invalid","This invitation is invalid or expired.") : error) }
}
