import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import "./helpers/business-auth"
import { closeDatabaseForTests, getDatabase, nowIso } from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { buildWorkspaceSetup } from "../src/lib/mca/setup/contracts"
import { dismissWorkspaceSetup, getWorkspaceSetup } from "../src/lib/mca/setup/service"
import { GET, POST } from "../src/app/api/mca/setup/route"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const now = "2026-09-25T12:00:00.000Z"
const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
const pages = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })

const ids = {
  workspace: "ws-setup",
  empty: "ws-setup-empty",
  dismiss: "ws-setup-dismiss",
  adminUser: "user-setup-admin",
  adminMember: "member-setup-admin",
  emptyUser: "user-setup-empty",
  emptyMember: "member-setup-empty",
  dismissUser: "user-setup-dismiss",
  dismissMember: "member-setup-dismiss",
  inviteUser: "user-setup-invite",
  inviteMember: "member-setup-invite",
}

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>

function cookieRequest(path: string, token: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { cookie: `mca_session=${token}`, origin: "http://localhost", ...init?.headers },
  })
}

async function insertWorkspace(id: string, name: string) {
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, ?, 'America/New_York', 8, ?, ?, ?, ?, ?)`).run(id, name, flags, pages, actions, now, now)
}

async function insertUser(userId: string, memberId: string, email: string, workspaceId: string, role = "admin", status = "active") {
  const db = getDatabase()
  await db.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
    VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)`).run(memberId, workspaceId, userId, role, status, now, now)
}

before(async () => {
  fixture = await createPostgresTestDatabase("setup")
  Object.assign(process.env, fixture.env())
  await insertWorkspace(ids.workspace, "Setup Brokerage")
  await insertWorkspace(ids.empty, "A")
  await insertWorkspace(ids.dismiss, "Dismiss Brokerage")
  await insertUser(ids.adminUser, ids.adminMember, "setup-admin@example.test", ids.workspace)
  await insertUser(ids.emptyUser, ids.emptyMember, "setup-empty@example.test", ids.empty)
  await insertUser(ids.dismissUser, ids.dismissMember, "setup-dismiss@example.test", ids.dismiss)
  await insertUser(ids.inviteUser, ids.inviteMember, "setup-invite@example.test", ids.workspace, "rep", "pending")
  await getDatabase().prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("setup-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("setup-admin-token"), now, now)
  await getDatabase().prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("setup-empty-session", ids.emptyUser, ids.emptyMember, hashOpaqueToken("setup-empty-token"), now, now)
  await getDatabase().prepare(`INSERT INTO mca_funders (id, workspace_id, idempotency_key, legal_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("funder-setup", ids.workspace, "funder-setup", "North Capital", now, now)
  await getDatabase().prepare(`INSERT INTO deals
    (id, workspace_id, display_id, legal_name, requested_amount, industry, address_json, merchant_id, status,
     pipeline_version, draft_state, missing_required_json, field_sources_json, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, NULL, '{}', NULL, 'lead', 1, 'partial', '[]', '{}', 1, ?, ?)`).run(
    "deal-setup", ids.workspace, "MCA-SETUP", "First Merchant LLC", now, now,
  )
  await getDatabase().prepare(`INSERT INTO invitations
    (id, workspace_id, membership_id, email, token_hash, expires_at, status, delivery_status, delivery_correlation_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '2099-01-01T00:00:00.000Z', 'pending', 'preview', ?, ?, ?, ?)`).run(
    "invite-setup", ids.workspace, ids.inviteMember, "setup-invite@example.test", hashOpaqueToken("invite-token"), "corr-setup", ids.adminUser, now, now,
  )
  await getDatabase().prepare(`INSERT INTO mca_email_senders
    (id, workspace_id, provider, purpose, from_name, from_address, credential_cipher, state, is_default, created_at, updated_at)
    VALUES (?, ?, 'smtp', 'fallback', 'Setup', 'setup@example.test', 'cipher', 'verified', 0, ?, ?)`).run(
    "sender-setup", ids.workspace, now, now,
  )
})

after(async () => {
  await closeDatabaseForTests()
  await fixture?.close()
})

test("buildWorkspaceSetup marks a fresh workspace incomplete except the named company profile", () => {
  const setup = buildWorkspaceSetup({
    brokerageName: "Acme Funding",
    dismissedAt: null,
    funderCount: 0,
    dealCount: 0,
    memberCount: 1,
    pendingInvitationCount: 0,
    verifiedSenderCount: 0,
    enabledIntakeCount: 0,
    connectedDatamerchCount: 0,
  })
  assert.equal(setup.dismissed, false)
  assert.equal(setup.completedCount, 1)
  assert.equal(setup.totalCount, 5)
  assert.equal(setup.allComplete, false)
  assert.equal(setup.nextStep?.id, "funders")
  assert.deepEqual(setup.steps.map((step) => [step.id, step.complete]), [
    ["company_profile", true],
    ["funders", false],
    ["first_deal", false],
    ["team", false],
    ["integrations", false],
  ])
})

test("buildWorkspaceSetup treats pending invitations and existing connection status as complete", () => {
  const setup = buildWorkspaceSetup({
    brokerageName: "Acme Funding",
    dismissedAt: nowIso(),
    funderCount: 1,
    dealCount: 1,
    memberCount: 1,
    pendingInvitationCount: 1,
    verifiedSenderCount: 0,
    enabledIntakeCount: 1,
    connectedDatamerchCount: 0,
  })
  assert.equal(setup.dismissed, true)
  assert.equal(setup.allComplete, true)
  assert.equal(setup.nextStep, null)
  assert.equal(setup.steps.find((step) => step.id === "team")?.complete, true)
  assert.equal(setup.steps.find((step) => step.id === "integrations")?.complete, true)
})

test("buildWorkspaceSetup does not invent a live-ready or diagnostic step", () => {
  const setup = buildWorkspaceSetup({
    brokerageName: "Acme",
    dismissedAt: null,
    funderCount: 0,
    dealCount: 0,
    memberCount: 1,
    pendingInvitationCount: 0,
    verifiedSenderCount: 0,
    enabledIntakeCount: 0,
    connectedDatamerchCount: 0,
  })
  assert.deepEqual(setup.steps.map((step) => step.id), ["company_profile", "funders", "first_deal", "team", "integrations"])
  assert.equal(setup.steps.some((step) => /live-ready|diagnostic/i.test(step.title + step.description)), false)
})

test("getWorkspaceSetup reads only existing workspace, funder, deal, team, and connection rows", async () => {
  const empty = await getWorkspaceSetup(ids.empty)
  assert.equal(empty.steps.find((step) => step.id === "company_profile")?.complete, false)
  assert.equal(empty.nextStep?.id, "company_profile")
  assert.equal(empty.completedCount, 0)

  const ready = await getWorkspaceSetup(ids.workspace)
  assert.equal(ready.allComplete, true)
  assert.equal(ready.dismissed, false)
  assert.equal(ready.steps.find((step) => step.id === "integrations")?.complete, true)
})

test("dismissWorkspaceSetup is idempotent and hides later reads", async () => {
  const first = await dismissWorkspaceSetup({
    authType: "session",
    userId: ids.dismissUser,
    membershipId: ids.dismissMember,
    workspaceId: ids.dismiss,
    role: "admin",
    scopes: [],
    sessionId: "setup-dismiss-session",
  })
  assert.equal(first.dismissed, true)
  assert.ok(first.dismissedAt)
  const second = await dismissWorkspaceSetup({
    authType: "session",
    userId: ids.dismissUser,
    membershipId: ids.dismissMember,
    workspaceId: ids.dismiss,
    role: "admin",
    scopes: [],
    sessionId: "setup-dismiss-session",
  })
  assert.equal(second.dismissedAt, first.dismissedAt)
})

test("GET and POST /api/mca/setup require a workspace session and do not store", async () => {
  const unauth = await GET(new Request("http://localhost/api/mca/setup"))
  assert.equal(unauth.status, 401)

  const empty = await GET(cookieRequest("/api/mca/setup", "setup-empty-token"))
  assert.equal(empty.status, 200)
  assert.equal(empty.headers.get("cache-control"), "no-store")
  const emptyBody = await empty.json() as { completedCount: number; dismissed: boolean; nextStep: { id: string } | null }
  assert.equal(emptyBody.dismissed, false)
  assert.equal(emptyBody.nextStep?.id, "company_profile")

  const ready = await GET(cookieRequest("/api/mca/setup", "setup-admin-token"))
  assert.equal(ready.status, 200)
  const readyBody = await ready.json() as { allComplete: boolean; dismissed: boolean }
  assert.equal(readyBody.allComplete, true)
  assert.equal(readyBody.dismissed, false)

  const dismissed = await POST(cookieRequest("/api/mca/setup", "setup-admin-token", {
    method: "POST",
    body: JSON.stringify({ dismissed: true }),
  }))
  assert.equal(dismissed.status, 200)
  const dismissedBody = await dismissed.json() as { dismissed: boolean }
  assert.equal(dismissedBody.dismissed, true)

  const invalid = await POST(cookieRequest("/api/mca/setup", "setup-admin-token", {
    method: "POST",
    body: JSON.stringify({ dismissed: false }),
  }))
  assert.equal(invalid.status, 400)
})

test("setup checklist and empty-state copy stay on existing next steps", () => {
  const root = resolve(process.cwd())
  const checklist = readFileSync(resolve(root, "src/components/mca/setup/setup-checklist.tsx"), "utf8")
  const copy = readFileSync(resolve(root, "src/lib/mca/setup/contracts.ts"), "utf8")
  const home = readFileSync(resolve(root, "src/components/mca/home/home-empty-state.tsx"), "utf8")
  const pipeline = readFileSync(resolve(root, "src/app/(dashboard)/pipeline/components/pipeline-workspace.tsx"), "utf8")
  const funders = readFileSync(resolve(root, "src/components/mca/funders/funder-directory-panel.tsx"), "utf8")
  assert.match(checklist, /mca-setup-checklist/)
  assert.match(copy, /Hide checklist/)
  assert.match(home, /Next setup step/)
  assert.match(pipeline, /No deals yet/)
  assert.match(pipeline, /Create your first merchant application to open this pipeline/)
  assert.match(funders, /Add your first funder/)
})
