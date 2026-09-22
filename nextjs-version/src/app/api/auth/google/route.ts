import { NextResponse } from "next/server"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { authOrigin } from "@/lib/mca/supabase-auth-http"
import { authContinuation } from "@/lib/mca/auth-navigation"
import { readJson } from "@/lib/mca/http"
import { apiError, AppError } from "@/lib/mca/errors"

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    await consumeRequestRateLimit(clientRateKey(request, "auth:google"), 20)
    const input = await readJson(request, z.object({ next: z.string().max(2048).optional() }))
    const callback = new URL("/auth/callback", authOrigin(request))
    callback.searchParams.set("next", authContinuation(input.next ?? null))
    const client = await createSupabaseServerClient()
    const { data, error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: callback.href, skipBrowserRedirect: true } })
    if (error || !data.url) throw new AppError(400, "oauth_unavailable", "Google sign-in is unavailable. Please try again.")
    return NextResponse.json({ url: data.url }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
