import "server-only"
import { z } from "zod"
import {
  getDatabase,
  withImmediateTransaction,
  nowIso,
  recordAuditEvent,
} from "../db"
import {
  encryptSensitive,
  decryptSensitive,
  createOpaqueToken,
  hashOpaqueToken,
} from "../crypto"
import { createWorkspaceWithAdmin } from "../workspaces"
import { deliverEmail, assertEmailDeliveryConfigured } from "../email"
import { AppError } from "../errors"
import type { DealActor } from "../deals/schema"
import type { AuthContext } from "../types"

export const signupSchema = z
  .object({
    companyName: z.string().trim().min(2).max(100),
    name: z.string().trim().min(2).max(100),
    email: z.email().max(254),
    password: z.string().min(12).max(200),
    terms: z.literal(true),
  })
  .strict()
export const profileSchema = z
  .object({
    businessType: z.enum([
      "Limited Liability Corporation",
      "Corporation",
      "Partnership",
      "Sole Proprietorship",
    ]),
    contactPosition: z.enum([
      "CEO",
      "CFO",
      "General_Manager",
      "VP",
      "Director",
      "Other",
    ]),
    contactTitle: z.string().trim().min(2).max(100),
    legalName: z.string().trim().min(2).max(150),
    ein: z.string().regex(/^\d{2}-?\d{7}$/),
    street: z.string().trim().min(3).max(150),
    city: z.string().trim().min(2).max(100),
    region: z.string().regex(/^[A-Z]{2}$/),
    postalCode: z.string().regex(/^\d{5}(-\d{4})?$/),
    website: z.url().startsWith("https://").max(300),
    contactFirstName: z.string().trim().min(1).max(80),
    contactLastName: z.string().trim().min(1).max(80),
    contactEmail: z.email(),
    contactPhone: z.string().regex(/^\+1\d{10}$/),
    purpose: z.string().trim().min(30).max(2000),
    samples: z.array(z.string().trim().min(20).max(1000)).min(2).max(5),
    consentEvidence: z.string().trim().min(30).max(3000),
    privacyUrl: z.url().startsWith("https://").max(300),
    termsUrl: z.url().startsWith("https://").max(300),
    applicationUpdatesOnly: z.literal(true),
  })
  .strict()
export type BusinessProfile = z.infer<typeof profileSchema>
export type Company = {
  workspace_id: string
  owner_user_id: string
  email_verified_at: string | null
  profile_cipher: string | null
  review_state: string
  review_note: string | null
  registration_state: string
  provider_cipher: string | null
  opt_out_ready: number
  suspended: number
  number_limit: number
  monthly_limit_cents: number
  registration_limit_cents: number
}
export type ProviderConfig = {
  accountSid: string
  authToken: string
  apiKeySid?: string
  apiKeySecret?: string
  profileSid?: string
  trustSid?: string
  brandSid?: string
  serviceSid?: string
  campaignSid?: string
  [key: string]: string | undefined
}
export function admin(actor: DealActor) {
  if (
    actor.source !== "user" ||
    !["admin", "super_admin"].includes(actor.role ?? "")
  )
    throw new AppError(
      403,
      "sms_admin_required",
      "A company administrator is required."
    )
}
export function isPlatformOperator(userId: string | null): boolean {
  return (
    !!userId &&
    (process.env.MCA_PLATFORM_OPERATOR_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(userId)
  )
}
export function operator(context: AuthContext) {
  if (context.authType !== "session" || !isPlatformOperator(context.userId))
    throw new AppError(
      403,
      "platform_operator_required",
      "Platform operator access is required."
    )
}
export function platformReady(): boolean {
  return (
    process.env.MCA_SMS_ISV_APPROVED === "true" &&
    !!process.env.MCA_SMS_ELIGIBILITY_REFERENCE &&
    !!process.env.MCA_TWILIO_PRIMARY_PROFILE_SID
  )
}
export function publicOrigin(): string {
  for (const candidate of [process.env.MCA_SMS_PUBLIC_BASE_URL, process.env.MCA_APP_ORIGIN]) {
    const value = candidate?.trim()
    if (!value) continue
    try {
      const u = new URL(value)
      if (u.protocol === "https:" && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash)
        return u.origin
    } catch { /* Try the fallback origin. */ }
  }
  throw new AppError(503, "sms_public_url_unconfigured", "Configure the public HTTPS origin.")
}
export async function company(
  workspaceId: string
): Promise<Company | undefined> {
  return getDatabase()
    .prepare<Company>("SELECT * FROM sms_companies WHERE workspace_id=?")
    .get(workspaceId)
}
export function provider(c: Company): ProviderConfig | undefined {
  return c.provider_cipher
    ? JSON.parse(decryptSensitive(c.provider_cipher, c.workspace_id))
    : undefined
}
export async function saveProvider(workspaceId: string, p: ProviderConfig) {
  await getDatabase()
    .prepare(
      "UPDATE sms_companies SET provider_cipher=?,updated_at=? WHERE workspace_id=?"
    )
    .run(
      encryptSensitive(JSON.stringify(p), workspaceId),
      nowIso(),
      workspaceId
    )
}
export async function ensureCompany(actor: DealActor) {
  admin(actor)
  await getDatabase()
    .prepare(
      "INSERT INTO sms_companies (workspace_id,owner_user_id,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING"
    )
    .run(actor.workspaceId, actor.userId, nowIso(), nowIso())
  return (await company(actor.workspaceId))!
}
export async function signUp(
  input: z.infer<typeof signupSchema>,
  authenticated?: AuthContext | null
) {
  assertEmailDeliveryConfigured()
  const email = input.email.trim().toLowerCase()
  const result = await withImmediateTransaction(async (db) => {
    await db
      .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`signup:${email}`)
    const existing = await db
      .prepare<{ id: string }>("SELECT id FROM users WHERE lower(email)=?")
      .get(email)
    if (
      existing &&
      (authenticated?.authType !== "session" ||
        authenticated.userId !== existing.id)
    )
      throw new AppError(
        409,
        "sign_in_required",
        "Sign in to your existing account before creating another company."
      )
    const created = await createWorkspaceWithAdmin({
      workspaceName: input.companyName,
      adminName: input.name,
      adminEmail: email,
      password: input.password,
      role: "admin",
    })
    await db
      .prepare(
        "INSERT INTO sms_companies (workspace_id,owner_user_id,created_at,updated_at) VALUES (?,?,?,?)"
      )
      .run(created.workspaceId, created.userId, nowIso(), nowIso())
    await recordAuditEvent({
      context: { workspaceId: created.workspaceId, userId: created.userId },
      action: "company.signup",
      resourceType: "workspace",
      resourceId: created.workspaceId,
    })
    return created
  })
  return result
}
export async function sendVerification(workspaceId: string, userId: string) {
  const c = await company(workspaceId)
  if (!c || c.owner_user_id !== userId)
    throw new AppError(
      403,
      "company_owner_required",
      "The company owner must verify their email."
    )
  if (c.email_verified_at) return { delivery: "verified" }
  const user = await getDatabase()
    .prepare<{ email: string }>("SELECT email FROM users WHERE id=?")
    .get(userId)
  const token = createOpaqueToken(),
    expiresAt = new Date(Date.now() + 86400000).toISOString()
  await getDatabase()
    .prepare(
      "INSERT INTO sms_email_tokens (token_hash,workspace_id,user_id,expires_at,created_at) VALUES (?,?,?,?,?)"
    )
    .run(hashOpaqueToken(token), workspaceId, userId, expiresAt, nowIso())
  // Only send tokens through email; unlike template preview emails these are never returned to a browser.
  try {
    const delivery = await deliverEmail({
      recipient: user!.email,
      template: "company_email_verification",
      actionUrl: `${publicOrigin()}/verify-company?token=${encodeURIComponent(token)}`,
      expiresAt,
    })
    return { delivery: delivery.delivery }
  } catch (error) {
    await getDatabase()
      .prepare("DELETE FROM sms_email_tokens WHERE token_hash=?")
      .run(hashOpaqueToken(token))
    throw error
  }
}
export async function verifyEmail(token: string) {
  return withImmediateTransaction(async (db) => {
    const row = await db
      .prepare<{
        workspace_id: string
        user_id: string
      }>("UPDATE sms_email_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING workspace_id,user_id")
      .get(nowIso(), hashOpaqueToken(token), nowIso())
    if (!row)
      throw new AppError(
        400,
        "verification_invalid",
        "This verification link is invalid, used, or expired."
      )
    await db
      .prepare(
        "UPDATE sms_companies SET email_verified_at=?,updated_at=? WHERE workspace_id=? AND owner_user_id=?"
      )
      .run(nowIso(), nowIso(), row.workspace_id, row.user_id)
    await db
      .prepare(
        "UPDATE sms_email_tokens SET used_at=? WHERE workspace_id=? AND used_at IS NULL"
      )
      .run(nowIso(), row.workspace_id)
    await recordAuditEvent({
      context: { workspaceId: row.workspace_id, userId: row.user_id },
      action: "company.email_verified",
      resourceType: "workspace",
      resourceId: row.workspace_id,
    })
    return { verified: true, workspaceId: row.workspace_id }
  })
}
export async function onboardingStatus(actor: DealActor) {
  const c = await company(actor.workspaceId)
  const manageable =
    actor.source === "user" &&
    ["admin", "super_admin"].includes(actor.role ?? "")
  const numbers = await getDatabase()
    .prepare(
      "SELECT id,account_id,phone,membership_id,state,monthly_cents FROM sms_numbers WHERE workspace_id=? ORDER BY created_at"
    )
    .all(actor.workspaceId)
  const operations = manageable
    ? await getDatabase()
        .prepare(
          "SELECT id,kind,state,step,error_code,updated_at FROM sms_operations WHERE workspace_id=? ORDER BY created_at DESC LIMIT 30"
        )
        .all(actor.workspaceId)
    : []
  return {
    emailVerified: !!c?.email_verified_at,
    reviewState: c?.review_state ?? "draft",
    reviewNote: c?.review_note,
    registrationState: c?.registration_state ?? "not_started",
    suspended: !!c?.suspended,
    platformReady: platformReady(),
    canManage: manageable,
    isOperator: isPlatformOperator(actor.userId),
    profile:
      manageable && c?.profile_cipher
        ? JSON.parse(decryptSensitive(c.profile_cipher, actor.workspaceId))
        : null,
    limits: {
      numbers: c?.number_limit ?? 0,
      monthlyCents: c?.monthly_limit_cents ?? 0,
      registrationCents: c?.registration_limit_cents ?? 0,
    },
    optOutReady: !!c?.opt_out_ready,
    numbers: manageable
      ? numbers
      : numbers.filter((n) => n.membership_id === actor.membershipId),
    operations,
  }
}
export async function submitProfile(actor: DealActor, input: BusinessProfile) {
  admin(actor)
  const profile = profileSchema.parse(input)
  await ensureCompany(actor)
  await withImmediateTransaction(async (db) => {
    const c = await db
      .prepare<Company>(
        "SELECT * FROM sms_companies WHERE workspace_id=? FOR UPDATE"
      )
      .get(actor.workspaceId)
    if (!c?.email_verified_at)
      throw new AppError(
        409,
        "email_verification_required",
        "Verify the company owner's email first."
      )
    if (c.provider_cipher)
      throw new AppError(
        409,
        "registration_started",
        "Contact the platform operator to change an already registered business."
      )
    await db
      .prepare(
        "UPDATE sms_companies SET profile_cipher=?,review_state='pending',review_note=NULL,updated_at=? WHERE workspace_id=?"
      )
      .run(
        encryptSensitive(JSON.stringify(profile), actor.workspaceId),
        nowIso(),
        actor.workspaceId
      )
    await recordAuditEvent({
      context: actor,
      action: "company.review_requested",
      resourceType: "workspace",
      resourceId: actor.workspaceId,
    })
  })
  return onboardingStatus(actor)
}
export const reviewSchema = z
  .object({
    workspaceId: z.string().min(1),
    decision: z.enum([
      "approved",
      "rejected",
      "suspended",
      "resumed",
      "limits",
    ]),
    note: z.string().trim().min(5).max(1000),
    numberLimit: z.number().int().min(0).max(100),
    monthlyLimitCents: z.number().int().min(0).max(1000000),
    registrationLimitCents: z.number().int().min(0).max(100000),
    optOutConfirmed: z.boolean().optional(),
  })
  .strict()
export async function reviewCompany(
  context: AuthContext,
  input: z.infer<typeof reviewSchema>
) {
  operator(context)
  await withImmediateTransaction(async (db) => {
    const c = await db
      .prepare<Company>(
        "SELECT * FROM sms_companies WHERE workspace_id=? FOR UPDATE"
      )
      .get(input.workspaceId)
    if (!c) throw new AppError(404, "company_missing", "Company not found.")
    if (
      input.decision === "approved" &&
      (!c.email_verified_at || !c.profile_cipher)
    )
      throw new AppError(
        409,
        "company_incomplete",
        "Email verification and business details are required."
      )
    if (input.optOutConfirmed && !provider(c)?.serviceSid)
      throw new AppError(
        409,
        "service_missing",
        "Create the company Messaging Service before confirming Advanced Opt-Out."
      )
    const review = ["approved", "rejected"].includes(input.decision)
      ? input.decision
      : c.review_state
    const suspended =
      input.decision === "suspended"
        ? 1
        : input.decision === "resumed"
          ? 0
          : c.suspended
    await db
      .prepare(
        "UPDATE sms_companies SET review_state=?,review_note=?,reviewed_by=?,opt_out_ready=?,suspended=?,number_limit=?,monthly_limit_cents=?,registration_limit_cents=?,updated_at=? WHERE workspace_id=?"
      )
      .run(
        review,
        input.note,
        context.userId,
        input.optOutConfirmed === undefined
          ? c.opt_out_ready
          : input.optOutConfirmed
            ? 1
            : 0,
        suspended,
        input.numberLimit,
        input.monthlyLimitCents,
        input.registrationLimitCents,
        nowIso(),
        input.workspaceId
      )
    await recordAuditEvent({
      context: { workspaceId: input.workspaceId, userId: context.userId },
      action: `company.${input.decision}`,
      resourceType: "workspace",
      resourceId: input.workspaceId,
      metadata: {
        note: input.note,
        numberLimit: input.numberLimit,
        monthlyLimitCents: input.monthlyLimitCents,
      },
    })
  })
  return { updated: true }
}
export async function reviewQueue(context: AuthContext) {
  operator(context)
  const rows = await getDatabase()
    .prepare<
      Company & { name: string }
    >("SELECT c.*,w.name FROM sms_companies c JOIN workspaces w ON w.id=c.workspace_id ORDER BY c.updated_at DESC LIMIT 100")
    .all()
  return {
    companies: rows.map((c) => ({
      workspaceId: c.workspace_id,
      name: c.name,
      emailVerified: !!c.email_verified_at,
      reviewState: c.review_state,
      registrationState: c.registration_state,
      suspended: !!c.suspended,
      optOutReady: !!c.opt_out_ready,
      note: c.review_note,
      numberLimit: c.number_limit,
      monthlyLimitCents: c.monthly_limit_cents,
      registrationLimitCents: c.registration_limit_cents,
      profile: c.profile_cipher
        ? JSON.parse(decryptSensitive(c.profile_cipher, c.workspace_id))
        : null,
    })),
  }
}
