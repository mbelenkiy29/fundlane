import "server-only"
import { AppError } from "./errors"
import { getDatabase, nowIso } from "./db"
import { withSuperAdminAction } from "./platform-audit"
import { verifyFreshAppTotp } from "./totp-service"
import type { SuperAdminActor } from "./platform-auth"

export function stepUpMinutes(): number {
  const value = Number(process.env.MCA_PLATFORM_STEP_UP_MINUTES ?? "10")
  return Number.isFinite(value) && value > 0 ? Math.min(60,value) : 10
}
export async function requirePlatformStepUp(actor: SuperAdminActor): Promise<string> {
  const row = await getDatabase().prepare<{verified_at:string}>("SELECT verified_at FROM platform_step_ups WHERE session_id=? AND user_id=?").get(actor.sessionId,actor.userId)
  if (!row || !Number.isFinite(Date.parse(row.verified_at)) || Date.now()-Date.parse(row.verified_at)>stepUpMinutes()*60000)
    throw new AppError(403,"step_up_required","Verify a fresh authenticator code to continue.")
  return row.verified_at
}
export async function completePlatformStepUp(actor: SuperAdminActor, code: string, request?: Request): Promise<void> {
  try {
    await withSuperAdminAction({actor,action:"super_admin.step_up_succeeded",request}, async db => {
      await verifyFreshAppTotp(actor.userId,code,db)
      await db.prepare(`INSERT INTO platform_step_ups (session_id,user_id,verified_at) VALUES (?,?,?)
        ON CONFLICT (session_id) DO UPDATE SET user_id=EXCLUDED.user_id,verified_at=EXCLUDED.verified_at`).run(actor.sessionId,actor.userId,nowIso())
    })
  } catch (error) {
    if (error instanceof AppError && error.code === "totp_verification_failed") {
      await withSuperAdminAction({actor,action:"super_admin.step_up_failed",request},async () => undefined)
    }
    throw error
  }
}
