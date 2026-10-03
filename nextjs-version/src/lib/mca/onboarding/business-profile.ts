import "server-only"
import { z } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { assertCompanyOperational } from "../company-access"
import { encryptSensitive, decryptSensitive } from "../crypto"
import { getDatabase, nowIso, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { effectivePageVisibility } from "../policy"
import { assertSessionTotpAccess } from "../totp-service"
import { getWorkspaceSettings } from "../workspaces"
import type { BusinessProfile } from "../sms/onboarding"

/** A2P 10DLC fields reuse the SMS registration profile names; privacy and terms URLs are optional here. */
const a2pKeys = { businessType: true, street: true, city: true, region: true, postalCode: true, website: true, contactFirstName: true, contactLastName: true, contactEmail: true, contactPhone: true, contactTitle: true, contactPosition: true, purpose: true, samples: true, consentEvidence: true, privacyUrl: true, termsUrl: true } as const
export type A2pProfile = Omit<Pick<BusinessProfile, keyof typeof a2pKeys>, "privacyUrl" | "termsUrl"> & Partial<Pick<BusinessProfile, "privacyUrl" | "termsUrl">>
// sms/onboarding statically imports this module, so its schema is only loaded lazily here (no static cycle).
async function a2pSchema() {
  const { profileSchema } = await import("../sms/onboarding")
  return profileSchema.pick(a2pKeys).partial({ privacyUrl: true, termsUrl: true }).strict()
}
export interface BusinessBasics { legalName: string; einPresent: boolean; revision: number; registered: boolean; a2p?: A2pProfile }
export const businessBasicsInput = z.object({
  legalName: z.string().trim().min(2).max(150),
  ein: z.string().regex(/^\d{2}-?\d{7}$/),
  expectedRevision: z.number().int().nonnegative(),
}).strict()
type BasicProfile = { legalName: string; ein: string }
const einMessage = "Enter a nine-digit EIN, with an optional hyphen after the first two digits."
type Row = { profile_cipher: string; revision: number }
type SmsIdentity = { profile_cipher: string | null; provider_cipher: string | null; review_state: string; registration_state: string; provisioning_state: string }

/** Only an actor produced by the verified live-session boundary may enter this service. Recheck mutable workspace authority. */
export async function assertBusinessActor(actor: DealActor): Promise<void> {
  if (actor.source !== "user" || !actor.userId || !actor.membershipId || !actor.sessionId || !["admin", "super_admin"].includes(actor.role ?? ""))
    throw new AppError(403, "business_admin_required", "A signed-in company administrator is required.")
  const member = await getDatabase().prepare<{ role: string }>("SELECT role FROM memberships WHERE id=? AND user_id=? AND workspace_id=? AND status='active'").get(actor.membershipId, actor.userId, actor.workspaceId)
  if (!member || member.role !== actor.role || !["admin", "super_admin"].includes(member.role))
    throw new AppError(403, "business_admin_required", "An active company administrator is required.")
  const settings = await getWorkspaceSettings(actor.workspaceId)
  if (!effectivePageVisibility(actor.role!, settings.pageVisibility, settings.featureFlags).integrations)
    throw new AppError(403, "page_disabled", "Business and integration settings are disabled for this workspace.")
  await assertCompanyOperational(actor.workspaceId)
  await assertSessionTotpAccess({ userId: actor.userId, sessionId: actor.sessionId, workspaceId: actor.workspaceId })
}
export async function requireBusinessActor(request: Request, write = false): Promise<DealActor> {
  if (write) assertTrustedMutation(request)
  const context = await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] })
  const actor = await actorForDeals(context)
  await assertBusinessActor(actor)
  return actor
}
function locked(c?: SmsIdentity): boolean {
  return Boolean(c && (c.provider_cipher || c.review_state === "approved" || c.registration_state !== "not_started" || !["idle", "not_started"].includes(c.provisioning_state)))
}
async function existing(workspaceId: string, db: DbExecutor = getDatabase()) {
  const basic = await db.prepare<Row>("SELECT profile_cipher,revision FROM company_basic_profiles WHERE workspace_id=?").get(workspaceId)
  const sms = await db.prepare<SmsIdentity>("SELECT profile_cipher,provider_cipher,review_state,registration_state,provisioning_state FROM sms_companies WHERE workspace_id=?").get(workspaceId)
  const cipher = locked(sms) && sms?.profile_cipher ? sms.profile_cipher : basic?.profile_cipher ?? sms?.profile_cipher
  let profile: BasicProfile | null = null, a2p: A2pProfile | undefined
  if (cipher) {
    try {
      const decoded = JSON.parse(decryptSensitive(cipher, workspaceId)) as BasicProfile & { a2p?: unknown }
      const validated = businessBasicsInput.omit({ expectedRevision: true }).safeParse({ legalName: decoded.legalName, ein: decoded.ein })
      if (!validated.success) throw new Error("Invalid stored business details.")
      profile = validated.data
      if (decoded.a2p !== undefined && cipher === basic?.profile_cipher) a2p = (await a2pSchema()).parse(decoded.a2p)
    } catch { throw new AppError(503, "business_profile_unavailable", "Business details are temporarily unavailable. Contact support.") }
  }
  return { profile, a2p, revision: basic?.revision ?? 0, registered: locked(sms), sms }
}
function conflict(): never { throw new AppError(409, "business_revision_conflict", "Business details changed in another tab. Reload before saving or submitting.") }
export async function getBusinessBasics(actor: DealActor): Promise<BusinessBasics> {
  await assertBusinessActor(actor)
  const data = await existing(actor.workspaceId)
  return { legalName: data.profile?.legalName ?? (await getWorkspaceSettings(actor.workspaceId)).brokerageName, einPresent: Boolean(data.profile?.ein), revision: data.revision, registered: data.registered, ...(data.a2p ? { a2p: data.a2p } : {}) }
}
/** EIN may be omitted on resubmission once stored; omitted A2P details keep the stored A2P details. */
export async function saveBusinessBasics(actor: DealActor, input: { legalName: string; ein?: string; a2p?: unknown; expectedRevision: number }): Promise<{ legalName: string; einPresent: true; revision: number }> {
  await assertBusinessActor(actor)
  const parsed = businessBasicsInput.extend({ ein: businessBasicsInput.shape.ein.optional(), a2p: (await a2pSchema()).optional() }).strict().safeParse(input)
  if (!parsed.success) {
    const fields: Record<string, string[]> = {}
    for (const issue of parsed.error.issues) fields[issue.path.slice(0, 2).join(".") || "request"] = [issue.path[0] === "ein" ? einMessage : "Review this field."]
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", fields)
  }
  return withImmediateTransaction(async db => {
    await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(actor.workspaceId)
    await db.prepare("SELECT workspace_id FROM sms_companies WHERE workspace_id=? FOR UPDATE").get(actor.workspaceId)
    await assertBusinessActor(actor)
    const current = await existing(actor.workspaceId, db)
    if (current.registered) throw new AppError(409, "registration_started", "Contact the platform operator to change an approved or registered business.")
    if (current.revision !== parsed.data.expectedRevision) conflict()
    const ein = (parsed.data.ein ?? current.profile?.ein)?.replace("-", "")
    if (!ein) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { ein: [einMessage] })
    const a2p = parsed.data.a2p ?? current.a2p
    const profile = { legalName: parsed.data.legalName, ein, ...(a2p ? { a2p } : {}) }
    const revision = current.revision + 1, now = nowIso()
    await db.prepare(`INSERT INTO company_basic_profiles(workspace_id,profile_cipher,revision,supplied_at,updated_by_user_id,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET profile_cipher=EXCLUDED.profile_cipher,revision=EXCLUDED.revision,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at`)
      .run(actor.workspaceId, encryptSensitive(JSON.stringify(profile), actor.workspaceId), revision, now, actor.userId, now)
    await recordAuditEvent({ context: actor, action: "company.business_basics_supplied", resourceType: "workspace", resourceId: actor.workspaceId, metadata: { revision, a2pSubmitted: Boolean(parsed.data.a2p) }, executor: db })
    return { legalName: profile.legalName, einPresent: true, revision }
  })
}
/** Server-only: used to compose the complete validated SMS registration, never returned by an HTTP status endpoint. */
export async function businessBasicsForRegistration(actor: DealActor, expectedRevision: number): Promise<BasicProfile | null> {
  await assertBusinessActor(actor)
  const current = await existing(actor.workspaceId)
  if (!Number.isInteger(expectedRevision) || current.revision !== expectedRevision) conflict()
  return current.profile ? { legalName: current.profile.legalName, ein: current.profile.ein } : null
}
