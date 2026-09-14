import "server-only"
import { timingSafeEqual } from "node:crypto"
import { supabaseIdentity } from "../supabase-auth"
import { AppError } from "../errors"
export function assertPlatformOwnerId(userId: string | null) {
  if (!userId)
    throw new AppError(401, "authentication_required", "Sign in to continue.")
  if (
    !process.env.MCA_PLATFORM_OWNER_USER_ID ||
    userId !== process.env.MCA_PLATFORM_OWNER_USER_ID
  )
    throw new AppError(
      403,
      "permission_denied",
      "Platform owner access is required."
    )
}
export async function requirePlatformOwner() {
  const identity = await supabaseIdentity()
  assertPlatformOwnerId(identity?.user.id ?? null)
  return identity!
}
export function requireMonitor(request: Request) {
  const secret = process.env.MCA_MONITOR_TOKEN
  const actual = request.headers.get("authorization") ?? ""
  const expected = `Bearer ${secret}`
  if (
    !secret ||
    secret.length < 32 ||
    actual.length !== expected.length ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
    throw new AppError(
      401,
      "authentication_required",
      "Monitor authentication required."
    )
}
