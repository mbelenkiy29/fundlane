import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { authContinuation } from "@/lib/mca/auth-navigation"
import { authOrigin } from "@/lib/mca/supabase-auth-http"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

const inputSchema = z.object({ email: z.email().max(320), next: z.string().max(2048).optional() })
const response = () => NextResponse.json(
  { message: "If an account exists, we've sent a link." },
  { headers: { "Cache-Control": "no-store" } },
)

export async function POST(request: Request) {
  if (process.env.MCA_MAGIC_LINK_ENABLED !== "true") return new Response(null, { status: 404 })
  try {
    assertTrustedMutation(request)
    const input = await readJson(request, inputSchema)
    const email = input.email.trim().toLowerCase()
    await consumeRequestRateLimit(clientRateKey(request, "auth:magic-link:ip"), 10)
    await consumeRequestRateLimit(`auth:magic-link:email:${createHash("sha256").update(email).digest("hex")}`, 3)
    const callback = new URL("/auth/callback", authOrigin(request))
    callback.searchParams.set("flow", "magic-link")
    callback.searchParams.set("next", authContinuation(input.next ?? null))
    try {
      const client = await createSupabaseServerClient()
      await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: callback.href } })
    } catch {
      // Keep provider failures account-neutral, including SDK exceptions.
    }
    return response()
  } catch (error) {
    if (error instanceof z.ZodError) return apiError(new AppError(400, "validation_failed", "Enter a valid email address."))
    return apiError(error)
  }
}
