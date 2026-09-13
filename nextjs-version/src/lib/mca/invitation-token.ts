import { hashOpaqueToken } from "./crypto"

/** Distinguishes replacement invitations from legacy links during repeatable cutover. */
export function hashSupabaseInvitationToken(token: string): string {
  return `supabase:${hashOpaqueToken(token)}`
}
