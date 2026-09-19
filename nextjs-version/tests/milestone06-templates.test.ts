import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { createOffer, selectOfferRevision } from "../src/lib/mca/offers/service"
import {
  FORBIDDEN_TEMPLATE_VARIABLES,
  SYNTHETIC_TEMPLATE_DEAL_ID,
  previewMessageTemplate,
  validateTemplateVariables,
} from "../src/lib/mca/comms/templates"
import { TEMPLATE_EDITOR_COPY, templateEditorGate } from "../src/components/mca/comms/template-editor"
import { GET as templatesGet, POST as templatesPost } from "../src/app/api/mca/comms/templates/route"
import { GET as variablesGet } from "../src/app/api/mca/comms/templates/variables/route"
import { POST as previewPost } from "../src/app/api/mca/comms/templates/preview/route"
import { POST as validatePost } from "../src/app/api/mca/comms/templates/validate/route"
import { GET as templateGet, PATCH as templatePatch } from "../src/app/api/mca/comms/templates/[id]/route"
import { POST as publishPost } from "../src/app/api/mca/comms/templates/[id]/publish/route"
import { GET as versionsGet } from "../src/app/api/mca/comms/templates/[id]/versions/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "workspace-m06-templates",
  otherWorkspace: "workspace-m06-templates-other",
  adminUser: "tmpl-admin-user",
  adminMember: "tmpl-admin-member",
  repUser: "tmpl-rep-user",
  repMember: "tmpl-rep-member",
  otherUser: "tmpl-other-user",
  otherMember: "tmpl-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => {
  const membershipId = workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember
  return {
    workspaceId,
    userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
    membershipId,
    role,
    managedMembershipIds: [],
    activeMembershipIds: workspaceId === ids.otherWorkspace ? [ids.otherMember] : [ids.adminMember, ids.repMember],
    source: role ? "user" : "api_key",
    correlationId: `corr-${workspaceId}-${role ?? "key"}`,
  }
}

type ErrorBody = { error: { code: string; message: string; fieldErrors?: Record<string, string[]> } }
type PreviewBody = {
  channel: string
  synthetic: boolean
  dealId?: string
  subject?: string
  html?: string
  text: string
  unknownVariables: string[]
  forbiddenVariables: string[]
  publishBlocked: boolean
  variables: Array<{ name: string; value: string; missing: boolean }>
}
type TemplateBody = {
  id: string
  name: string
  channel: string
  scope: string
  publishedVersionId: string | null
  draft: { id: string; version: number; body: string; published: boolean } | null
  published: { id: string; version: number; body: string; published: boolean } | null
}

let dealAId = ""
let dealBId = ""
let emptyDealId = ""
let otherDealId = ""
let templateCounter = 0

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Templates Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, name, phone, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "hank@broker.example.test", "Hank Rearden", "(917) 283-2821", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "casey@broker.example.test", "Casey Rep", "(555) 222-1111", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "other@broker.example.test", "Other Admin", "(555) 000-0000", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`).run(userId, email, name, phone, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("tmpl-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("tmpl-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("tmpl-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("tmpl-intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("tmpl-read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("tmpl-write-key", "write-secret", ["deals:write"], ids.workspace)

  const dealA = (await createDeal(actor(), {
    idempotencyKey: "tmpl-deal-a",
    legalName: "Atlas <Corp>",
    contactEmail: "ops@atlas.example.test",
    contactPhone: "(555) 123-4567",
    owners: [{ firstName: "<script>alert(1)</script>", lastName: "Galt", email: "john@atlas.example.test", phone: "(555) 987-6543", isPrimary: true }],
    assignments: [
      { membershipId: ids.repMember, kind: "originator", isPrimary: true },
      { membershipId: ids.adminMember, kind: "closer", isPrimary: true },
    ],
  })).deal
  dealAId = dealA.id
  const low = await createOffer(actor(), {
    dealId: dealAId,
    funderName: "Northstar Capital",
    terms: { amountCents: 5_000_000, termMonths: 24, paymentAmountCents: 220_000, paymentFrequency: "monthly", commissionCents: 999_999, factorRate: 1.35, buyRate: 1.1, feeCents: 12_345 },
  })
  await selectOfferRevision(actor(), { dealId: dealAId, offerId: low.id, revisionId: low.currentRevisionId, selected: true })
  await createOffer(actor(), {
    dealId: dealAId,
    funderName: "Summit Advance",
    terms: { amountCents: 10_000_000, termMonths: 12, paymentAmountCents: 520_000, paymentFrequency: "weekly", commissionCents: 888_888 },
  })

  const dealB = (await createDeal(actor(), {
    idempotencyKey: "tmpl-deal-b",
    legalName: "OtherCorp Secret LLC",
    contactEmail: "hidden@othercorp.example.test",
    assignments: [{ membershipId: ids.adminMember, kind: "originator", isPrimary: true }],
  })).deal
  dealBId = dealB.id
  await createOffer(actor(), {
    dealId: dealBId,
    funderName: "Secret Funder",
    terms: { amountCents: 77_000_000, termMonths: 6, paymentAmountCents: 1_000_000, paymentFrequency: "daily", commissionCents: 654_321 },
  })

  emptyDealId = (await createDeal(actor(), {
    idempotencyKey: "tmpl-deal-empty",
    assignments: [{ membershipId: ids.adminMember, kind: "originator", isPrimary: true }],
  })).deal.id

  otherDealId = (await createDeal(actor(ids.otherWorkspace), {
    idempotencyKey: "tmpl-deal-other-ws",
    legalName: "Foreign Workspace Merchant",
    assignments: [{ membershipId: ids.otherMember, kind: "originator", isPrimary: true }],
  })).deal.id
}

function cookieRequest(path: string, token: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      cookie: `mca_session=${token}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function bearerRequest(path: string, secret: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer mca_${secret}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("m06_templates")
  Object.assign(process.env, testDatabase.env())
  await seed()
})

beforeEach(async () => {
  await getDatabase().execute("DELETE FROM mca_message_template_versions")
  await getDatabase().execute("DELETE FROM mca_message_templates")
})

after(async () => {
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("MIC-147: typed variables render offers, scoped uploads, and omit commissions and other deals", async () => {
  const body = [
    "Biz {{business_name}} {owner_first_name} {{owner_last_name}}",
    "Rep {{rep_first_name}} {{originator_email}} closer {{closer_first_name}}",
    "ALL",
    "{{all_offers_all_details}}",
    "SELECTED",
    "{{selected_offers_all_details}}",
    "HIGHEST {{highest_offer_funding_amount}}",
    "{{highest_offer_all_details}}",
    "DOCS {{docs_check_summary}}",
    "{{missing_docs}}",
    "AUTO {{auto_upload_url}}",
    "STM {{statements_upload_url}}",
  ].join("\n")

  const email = await previewMessageTemplate(actor(), {
    body,
    subject: "Hello {{business_name}}",
    channel: "email",
    scope: "merchant",
    dealId: dealAId,
    origin: "http://localhost",
  })
  assert.equal(email.synthetic, false)
  assert.equal(email.dealId, dealAId)
  assert.equal(email.subject, "Hello Atlas <Corp>")
  assert.match(email.text, /Atlas <Corp>/)
  assert.match(email.text, /<script>alert\(1\)<\/script>/)
  assert.match(email.html ?? "", /Atlas &lt;Corp&gt;/)
  assert.match(email.html ?? "", /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.equal((email.html ?? "").includes("<script>alert"), false)
  assert.match(email.text, /Casey/)
  assert.match(email.text, /casey@broker\.example\.test/)
  assert.match(email.text, /Hank/)
  assert.match(email.text, /Offer 1:[\s\S]*Funding Amount: \$100,000/)
  assert.match(email.text, /Offer 2:[\s\S]*Funding Amount: \$50,000/)
  const selectedSection = email.text.slice(email.text.indexOf("SELECTED"), email.text.indexOf("HIGHEST"))
  assert.match(selectedSection, /\$50,000/)
  assert.equal(selectedSection.includes("$100,000"), false)
  assert.match(email.text, /HIGHEST \$100,000/)
  assert.match(email.text, /Missing 4 of 4 required documents/)
  assert.match(email.text, /- Funding Application/)
  assert.match(email.text, new RegExp(`did=${dealAId}`))
  assert.match(email.text, /target=auto/)
  assert.match(email.text, /target=statements/)
  assert.equal(email.text.includes(dealBId), false)
  assert.equal(email.text.includes("OtherCorp"), false)
  assert.equal(email.text.includes("Secret Funder"), false)
  assert.equal(email.text.includes("77,000"), false)
  assert.equal(email.text.includes("9,999"), false)
  assert.equal(email.text.includes("8,888"), false)
  assert.equal(email.text.toLowerCase().includes("commission"), false)
  assert.equal(email.text.includes("1.35"), false)
  assert.equal(email.text.includes("12,345"), false)

  const sms = await previewMessageTemplate(actor(), {
    body: "{{all_offers_all_details}} {{highest_offer_funding_amount}}",
    channel: "sms",
    scope: "merchant",
    dealId: dealAId,
    origin: "http://localhost",
  })
  assert.match(sms.text, /Offer 1: \$100,000, 12 months, \$5,200\.00 weekly/)
  assert.equal(sms.text.includes("Funding Amount:"), false)
  assert.equal(sms.html, undefined)
  assert.equal(sms.text.includes("<br>"), false)

  const missing = await previewMessageTemplate(actor(), {
    body: "Name={{owner_first_name}};biz={{business_name}};hi={{highest_offer_funding_amount}};sel={{selected_offers_all_details}}",
    channel: "email",
    scope: "merchant",
    dealId: emptyDealId,
    origin: "http://localhost",
  })
  assert.match(missing.text, /Name=;biz=;hi=;sel=$/)
  assert.equal(missing.text.includes("undefined"), false)
  assert.equal(missing.text.includes("null"), false)

  const synthetic = await previewMessageTemplate(actor(), {
    body: "{{business_name}} {{highest_offer_funding_amount}} {{auto_upload_url}}",
    channel: "email",
    scope: "merchant",
    origin: "http://localhost",
  })
  assert.equal(synthetic.synthetic, true)
  assert.equal(synthetic.dealId, SYNTHETIC_TEMPLATE_DEAL_ID)
  assert.match(synthetic.text, /Atlas Corporation/)
  assert.match(synthetic.text, /\$100,000/)
  assert.match(synthetic.text, new RegExp(`did=${SYNTHETIC_TEMPLATE_DEAL_ID}`))

  const isolation = await previewPost(cookieRequest("/api/mca/comms/templates/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ body: "{{business_name}} {{all_offers_all_details}} {{auto_upload_url}}", channel: "email", scope: "merchant", dealId: dealAId }),
  }))
  assert.equal(isolation.status, 200)
  const isolated = await isolation.json() as PreviewBody
  assert.equal(isolated.text.includes("Foreign Workspace Merchant"), false)
  assert.equal(isolated.text.includes(otherDealId), false)
  assert.match(isolated.text, new RegExp(`did=${dealAId}`))

  const otherDeal = await previewPost(cookieRequest("/api/mca/comms/templates/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ body: "{{business_name}}", channel: "email", scope: "merchant", dealId: otherDealId }),
  }))
  assert.equal(otherDeal.status, 404)

  assert.ok(FORBIDDEN_TEMPLATE_VARIABLES.includes("commission"))
  const forbidden = validateTemplateVariables({ body: "Pay {{commission_cents}}", channel: "email", scope: "merchant" })
  assert.equal(forbidden.publishable, false)
  assert.ok(forbidden.forbidden.includes("commission_cents"))
})

test("highestOffer template values skip expired revisions even when state is active", async () => {
  const expiredHigh = await createOffer(actor(), {
    dealId: dealAId,
    funderName: "Expired Summit",
    terms: { amountCents: 20_000_000, termMonths: 12, paymentAmountCents: 800_000, paymentFrequency: "weekly" },
  })
  await getDatabase().prepare("UPDATE mca_offer_revisions SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", expiredHigh.currentRevisionId)
  const preview = await previewMessageTemplate(actor(), {
    body: "HIGHEST {{highest_offer_funding_amount}} {{highest_offer_all_details}} ALL {{all_offers_all_details}}",
    channel: "email",
    scope: "merchant",
    dealId: dealAId,
    origin: "http://localhost",
  })
  assert.match(preview.text, /HIGHEST \$100,000/)
  assert.equal(preview.text.includes("$200,000"), false)
  assert.equal(preview.text.includes("Expired Summit"), false)
})

test("MIC-147: unknown variables block publish, drafts keep identity, and versions are retained", async () => {
  templateCounter += 1
  const created = await templatesPost(cookieRequest("/api/mca/comms/templates", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ name: `Unknown ${templateCounter}`, channel: "email", scope: "merchant", subject: "Hi {{business_name}}", body: "Hello {{not_a_real_variable}}" }),
  }))
  assert.equal(created.status, 201)
  const template = await created.json() as TemplateBody
  const draftId = template.draft?.id
  assert.ok(draftId)

  const savedAgain = await templatePatch(cookieRequest(`/api/mca/comms/templates/${template.id}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ body: "Hello {{not_a_real_variable}} still" }),
  }), params(template.id))
  assert.equal(savedAgain.status, 200)
  const saved = await savedAgain.json() as TemplateBody
  assert.equal(saved.draft?.id, draftId)
  assert.equal(saved.draft?.version, 1)
  assert.equal(saved.publishedVersionId, null)

  const preview = await previewPost(cookieRequest("/api/mca/comms/templates/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ templateId: template.id, body: "Hello {{not_a_real_variable}}", channel: "email", scope: "merchant", dealId: dealAId }),
  }))
  assert.equal(preview.status, 200)
  const rendered = await preview.json() as PreviewBody
  assert.equal(rendered.publishBlocked, true)
  assert.ok(rendered.unknownVariables.includes("not_a_real_variable"))
  assert.equal(rendered.text.includes("{{not_a_real_variable}}"), false)
  assert.equal(rendered.text.includes("{not_a_real_variable}"), false)
  assert.match(rendered.text, /^Hello $/)

  const blocked = await publishPost(cookieRequest(`/api/mca/comms/templates/${template.id}/publish`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({}),
  }), params(template.id))
  assert.equal(blocked.status, 422)
  const blockedBody = await blocked.json() as ErrorBody
  assert.equal(blockedBody.error.code, "unknown_variable")
  assert.match(blockedBody.error.message, /Unknown variables cannot be published/)

  const after = await templateGet(cookieRequest(`/api/mca/comms/templates/${template.id}`, "admin-session-token"), params(template.id))
  const afterBody = await after.json() as TemplateBody
  assert.equal(afterBody.publishedVersionId, null)
  assert.equal(afterBody.draft?.id, draftId)

  const commission = await templatesPost(cookieRequest("/api/mca/comms/templates", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ name: `Commission ${templateCounter}`, channel: "email", scope: "merchant", subject: "Pay", body: "Pay {{commission}} {{buy_rate}}" }),
  }))
  const commissionTemplate = await commission.json() as TemplateBody
  const commissionPublish = await publishPost(cookieRequest(`/api/mca/comms/templates/${commissionTemplate.id}/publish`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({}),
  }), params(commissionTemplate.id))
  assert.equal(commissionPublish.status, 422)
  assert.equal((await commissionPublish.json() as ErrorBody).error.code, "forbidden_variable")

  const ok = await templatesPost(cookieRequest("/api/mca/comms/templates", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ name: `Publish ${templateCounter}`, channel: "email", scope: "merchant", subject: "{{business_name}}", body: "Hi {{owner_first_name}} {{selected_offers_all_details}}" }),
  }))
  const okTemplate = await ok.json() as TemplateBody
  const published = await publishPost(cookieRequest(`/api/mca/comms/templates/${okTemplate.id}/publish`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({}),
  }), params(okTemplate.id))
  assert.equal(published.status, 200)
  const publishedBody = await published.json() as TemplateBody
  const publishedVersionId = publishedBody.publishedVersionId
  assert.ok(publishedVersionId)
  assert.equal(publishedBody.published?.published, true)

  const replay = await publishPost(cookieRequest(`/api/mca/comms/templates/${okTemplate.id}/publish`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({}),
  }), params(okTemplate.id))
  assert.equal(replay.status, 200)
  assert.equal(((await replay.json()) as TemplateBody).publishedVersionId, publishedVersionId)

  const edited = await templatePatch(cookieRequest(`/api/mca/comms/templates/${okTemplate.id}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ body: "Hi {{owner_first_name}} v2 {{highest_offer_funding_amount}}" }),
  }), params(okTemplate.id))
  const editedBody = await edited.json() as TemplateBody
  assert.equal(editedBody.draft?.version, 2)
  assert.notEqual(editedBody.draft?.id, publishedVersionId)

  const versions = await versionsGet(cookieRequest(`/api/mca/comms/templates/${okTemplate.id}/versions`, "admin-session-token"), params(okTemplate.id))
  assert.equal(versions.status, 200)
  const history = await versions.json() as { versions: Array<{ id: string; version: number; published: boolean }> }
  assert.equal(history.versions.length, 2)
  assert.equal(history.versions[0]?.version, 2)
  assert.equal(history.versions[1]?.id, publishedVersionId)
  assert.equal(history.versions[1]?.published, true)

  const publishedV2 = await publishPost(cookieRequest(`/api/mca/comms/templates/${okTemplate.id}/publish`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({}),
  }), params(okTemplate.id))
  const publishedV2Body = await publishedV2.json() as TemplateBody
  assert.equal(publishedV2.status, 200)
  assert.equal(publishedV2Body.published?.version, 2)
  assert.equal(publishedV2Body.draft, null)
})

test("MIC-147: API permissions match the UI and loading/empty/validation states are usable", async () => {
  const source = readFileSync(resolve(process.cwd(), "src/components/mca/comms/template-editor.tsx"), "utf8")
  assert.match(source, /Loading message templates/)
  assert.match(source, /No message templates yet/)
  assert.match(source, /Enter a template name/)
  assert.match(source, /Unknown variables cannot be published/)
  assert.match(source, /Merchant templates cannot access commission or another deal's data/)
  assert.match(source, /Template published/)
  assert.match(source, /role="alert"/)
  assert.match(source, /Variable picker/)
  assert.match(source, /Preview synthetic example/)
  assert.equal(TEMPLATE_EDITOR_COPY.unknown, "Unknown variables cannot be published.")
  assert.equal(templateEditorGate({
    loading: true, templates: [], name: "", body: "", unknownVariables: [], forbiddenVariables: [], canPublish: true,
  }).phase, "loading")
  assert.equal(templateEditorGate({
    loading: false, templates: [], name: "", body: "", unknownVariables: [], forbiddenVariables: [], canPublish: true,
  }).phase, "empty")
  assert.equal(templateEditorGate({
    loading: false, templates: [{ id: "t", name: "n", channel: "email", scope: "merchant", published: false, publishedVersionId: null, updatedAt: "" }],
    name: "n", body: "Hi {{nope}}", unknownVariables: ["nope"], forbiddenVariables: [], canPublish: true,
  }).publishEnabled, false)
  assert.equal(templateEditorGate({
    loading: false, templates: [{ id: "t", name: "n", channel: "email", scope: "merchant", published: false, publishedVersionId: null, updatedAt: "" }],
    name: "n", body: "Hi {{business_name}}", unknownVariables: [], forbiddenVariables: [], canPublish: true,
  }).publishEnabled, true)

  const listRep = await templatesGet(cookieRequest("/api/mca/comms/templates", "rep-session-token"))
  assert.equal(listRep.status, 403)
  const createRep = await templatesPost(cookieRequest("/api/mca/comms/templates", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ name: "Rep", channel: "email", scope: "merchant" }),
  }))
  assert.equal(createRep.status, 403)

  const previewRepA = await previewPost(cookieRequest("/api/mca/comms/templates/preview", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ body: "{{business_name}}", channel: "email", scope: "merchant", dealId: dealAId }),
  }))
  assert.equal(previewRepA.status, 200)
  assert.match(((await previewRepA.json()) as PreviewBody).text, /Atlas/)

  const previewRepB = await previewPost(cookieRequest("/api/mca/comms/templates/preview", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ body: "{{business_name}}", channel: "email", scope: "merchant", dealId: dealBId }),
  }))
  assert.equal(previewRepB.status, 404)

  const created = await templatesPost(cookieRequest("/api/mca/comms/templates", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ name: "Perms", channel: "sms", scope: "merchant", body: "Hi {{business_name}}" }),
  }))
  const template = await created.json() as TemplateBody

  const intakeList = await templatesGet(bearerRequest("/api/mca/comms/templates", "intake-secret"))
  assert.equal(intakeList.status, 403)
  const intakePreview = await previewPost(bearerRequest("/api/mca/comms/templates/preview", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ body: "Hi", channel: "sms", scope: "merchant", dealId: dealAId }),
  }))
  assert.equal(intakePreview.status, 403)

  const readPreview = await previewPost(bearerRequest("/api/mca/comms/templates/preview", "read-secret", {
    method: "POST",
    body: JSON.stringify({ body: "{{business_name}}", channel: "email", scope: "merchant", dealId: dealAId }),
  }))
  assert.equal(readPreview.status, 200)
  const readList = await templatesGet(bearerRequest("/api/mca/comms/templates", "read-secret"))
  assert.equal(readList.status, 403)
  const readPublish = await publishPost(bearerRequest(`/api/mca/comms/templates/${template.id}/publish`, "read-secret", {
    method: "POST",
    body: JSON.stringify({}),
  }), params(template.id))
  assert.equal(readPublish.status, 403)

  const writePublish = await publishPost(bearerRequest(`/api/mca/comms/templates/${template.id}/publish`, "write-secret", {
    method: "POST",
    body: JSON.stringify({}),
  }), params(template.id))
  assert.equal(writePublish.status, 403)

  const variables = await variablesGet(cookieRequest("/api/mca/comms/templates/variables", "admin-session-token"))
  assert.equal(variables.status, 200)
  const catalog = await variables.json() as { variables: Array<{ name: string }> }
  assert.ok(catalog.variables.some((item) => item.name === "all_offers_all_details"))
  assert.equal(catalog.variables.some((item) => item.name.includes("commission")), false)

  const blank = await templatesPost(cookieRequest("/api/mca/comms/templates", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ name: "   ", channel: "email", scope: "merchant" }),
  }))
  assert.equal(blank.status, 422)

  const otherGet = await templateGet(cookieRequest(`/api/mca/comms/templates/${template.id}`, "other-session-token"), params(template.id))
  assert.equal(otherGet.status, 404)

  const json = JSON.stringify(await (await templatesGet(cookieRequest("/api/mca/comms/templates", "admin-session-token"))).json())
  assert.equal(json.includes("credentialCipher"), false)
  assert.equal(json.includes("password_hash"), false)
})
