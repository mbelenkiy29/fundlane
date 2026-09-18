import "server-only"

import { getDatabase, newId, nowIso } from "../db"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { saveIntegration } from "../intake/repository"
import { DEFAULT_OPTIONAL_FIELDS, FUNDLANE_FORM_ID, FUNDLANE_FORM_NAME, type OptionalFields } from "./form-schema"
import type { FormBranding } from "./contracts"

export interface ApplicationFormOption {
  id: string
  name: string
  formId: string
  provider: string
}

function parseOptional(raw: string | null | undefined): OptionalFields {
  try {
    const value = raw ? JSON.parse(raw) as OptionalFields : {}
    return { ...DEFAULT_OPTIONAL_FIELDS, ...value }
  } catch {
    return { ...DEFAULT_OPTIONAL_FIELDS }
  }
}

export async function ensureFundlaneForm(actor: Pick<DealActor, "workspaceId" | "membershipId">): Promise<ApplicationFormOption> {
  const existing = await getDatabase().prepare<ApplicationFormOption>(
    `SELECT id, display_name AS name, form_id AS "formId", provider FROM intake_integrations
     WHERE workspace_id=? AND provider='fundlane' LIMIT 1`,
  ).get(actor.workspaceId)
  if (existing?.formId) return existing
  const id = newId()
  const pool = actor.membershipId ? [actor.membershipId] : []
  try {
    await saveIntegration({
      id,
      workspaceId: actor.workspaceId,
      provider: "fundlane",
      displayName: FUNDLANE_FORM_NAME,
      formId: FUNDLANE_FORM_ID,
      mapping: {},
      allowedHosts: [],
      senderRules: [],
      assignmentPool: pool,
      initialStatus: "new_application",
      enabled: true,
      approvalState: "approved",
      automaticProcessing: pool.length > 0,
      automaticSince: pool.length ? nowIso() : undefined,
    })
  } catch (error) {
    const raced = await getDatabase().prepare<ApplicationFormOption>(
      `SELECT id, display_name AS name, form_id AS "formId", provider FROM intake_integrations
       WHERE workspace_id=? AND provider='fundlane' LIMIT 1`,
    ).get(actor.workspaceId)
    if (raced?.formId) return raced
    throw error
  }
  await getDatabase().prepare(
    `INSERT INTO mca_application_form_settings(integration_id,workspace_id,optional_fields_json,updated_at)
     VALUES (?,?,?,?) ON CONFLICT (integration_id) DO NOTHING`,
  ).run(id, actor.workspaceId, JSON.stringify(DEFAULT_OPTIONAL_FIELDS), nowIso())
  return { id, name: FUNDLANE_FORM_NAME, formId: FUNDLANE_FORM_ID, provider: "fundlane" }
}

export async function formBranding(workspaceId: string, integrationId: string): Promise<FormBranding> {
  const row = await getDatabase().prepare<{
    accent: string | null; welcome_title: string | null; welcome_body: string | null
    thank_you_title: string | null; optional_fields_json: string | null
  }>("SELECT accent,welcome_title,welcome_body,thank_you_title,optional_fields_json FROM mca_application_form_settings WHERE workspace_id=? AND integration_id=?").get(workspaceId, integrationId)
  return {
    accent: row?.accent ?? null,
    welcomeTitle: row?.welcome_title || "Business funding application",
    welcomeBody: row?.welcome_body || "Have your business details and recent bank statements handy. Your representative will receive the application when you submit it.",
    thankYouTitle: row?.thank_you_title || "Application received",
    optionalFields: parseOptional(row?.optional_fields_json),
  }
}

export async function saveFormBranding(actor: DealActor, input: {
  accent?: string; welcomeTitle?: string; welcomeBody?: string; thankYouTitle?: string; optionalFields?: OptionalFields
}): Promise<FormBranding> {
  if (actor.role !== "admin" && actor.role !== "super_admin") {
    throw new AppError(403, "permission_denied", "Only administrators can customize the application form.")
  }
  const form = await ensureFundlaneForm(actor)
  const current = await formBranding(actor.workspaceId, form.id)
  const next: FormBranding = {
    accent: input.accent === undefined ? current.accent : input.accent.trim() || null,
    welcomeTitle: input.welcomeTitle?.trim() || current.welcomeTitle,
    welcomeBody: input.welcomeBody?.trim() || current.welcomeBody,
    thankYouTitle: input.thankYouTitle?.trim() || current.thankYouTitle,
    optionalFields: { ...current.optionalFields, ...input.optionalFields },
  }
  await getDatabase().prepare(
    `INSERT INTO mca_application_form_settings(integration_id,workspace_id,accent,welcome_title,welcome_body,thank_you_title,optional_fields_json,updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT (integration_id) DO UPDATE SET accent=EXCLUDED.accent,welcome_title=EXCLUDED.welcome_title,
       welcome_body=EXCLUDED.welcome_body,thank_you_title=EXCLUDED.thank_you_title,optional_fields_json=EXCLUDED.optional_fields_json,updated_at=EXCLUDED.updated_at`,
  ).run(form.id, actor.workspaceId, next.accent, next.welcomeTitle, next.welcomeBody, next.thankYouTitle, JSON.stringify(next.optionalFields), nowIso())
  return next
}
