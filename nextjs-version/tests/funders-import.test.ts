import "./helpers/business-auth"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { createFunder, listFunders } from "../src/lib/mca/funders/directory"
import { listFunderCriteria } from "../src/lib/mca/funders/criteria"
import { commitFunderImport, previewFunderImport } from "../src/lib/mca/funders/import"
import { POST as previewPost } from "../src/app/api/mca/funders/import/preview/route"
import { POST as commitPost } from "../src/app/api/mca/funders/import/commit/route"
import { evaluateFunderScore, type ScoringInputs } from "../src/lib/mca/underwriting/scoring"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "workspace-funder-import",
  otherWorkspace: "workspace-funder-import-other",
  adminUser: "funder-import-admin-user",
  adminMember: "funder-import-admin-member",
  repUser: "funder-import-rep-user",
  repMember: "funder-import-rep-member",
  otherUser: "funder-import-other-user",
  otherMember: "funder-import-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => ({
  workspaceId,
  userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
  membershipId: workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember,
  role,
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: role ? "user" : "api_key",
  correlationId: `corr-import-${workspaceId}-${role ?? "key"}`,
})

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Import Funders"], [ids.otherWorkspace, "Other Import"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "import-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "import-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "import-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("funder-import-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("import-admin-session"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("funder-import-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("import-rep-session"), now, now)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("funders_import")
  Object.assign(process.env, testDatabase.env())
  await seed()
})
after(async () => {
  await closeDatabaseForTests()
  await testDatabase.close()
})

function cookieRequest(path: string, token: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      cookie: `mca_session=${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function matchingInputs(fico: number): ScoringInputs {
  return {
    dealId: "deal-bulk-import",
    dealVersion: 1,
    state: "NY",
    entity: "llc",
    defaultFlag: false,
    tibMonths: 80,
    fico,
    requestedAmount: 50_000,
    termMonths: 12,
    monthlyRevenue: 20_000,
    revenueUnknown: false,
    averageDailyBalance: 8_000,
    adbUnknown: false,
    nsfCount: 0,
    nsfUnknown: false,
    negativeDays: 0,
    negativeUnknown: false,
    depositCount: 12,
    depositUnknown: false,
    worstMonthNsf: 0,
    positionCount: 0,
    proposedPositionCount: 0,
    availableMonthlyRevenue: 20_000,
    availableUnknown: false,
  }
}

test("admin previews CSV and JSON, then saves reviewed funders with matching criteria", async () => {
  const csv = [
    "legalName,website,domains,products,active,contactName,contactEmail,criteria",
    'Harbor Advance,https://harbor.example,harbor.example,MCA,true,Ada Desk,ada@harbor.example,"[{""field"":""fico"",""operator"":""min"",""unit"":""fico"",""value"":650,""unspecified"":false}]"',
    "River Capital,https://river.example,river.example,MCA,true,Beau Desk,beau@river.example,",
  ].join("\n")
  const csvPreview = await previewFunderImport(actor(), { filename: "funders.csv", text: csv })
  assert.equal(csvPreview.summary.ready, 2)
  assert.equal(csvPreview.rows.every((row) => row.included), true)

  const jsonPreview = await previewFunderImport(actor(), {
    funders: [
      {
        legalName: "Summit Funding LLC",
        domains: ["summit.example"],
        products: ["MCA"],
        contacts: [{ name: "Cara", email: "cara@summit.example" }],
        criteria: [{ field: "fico", operator: "min", unit: "fico", value: 700, unspecified: false }],
      },
      {
        legalName: "Plainfield Capital",
        website: "https://plainfield.example",
      },
    ],
  })
  assert.equal(jsonPreview.summary.ready, 2)
  const committed = await commitFunderImport(actor(), {
    idempotencyKey: "import-ready-batch",
    rows: jsonPreview.rows,
  })
  assert.equal(committed.created.length, 2)
  assert.equal(committed.criteriaPublished, 1)
  const listed = await listFunders(actor())
  const summit = listed.find((item) => item.legalName === "Summit Funding LLC")
  assert.ok(summit)
  const criteria = await listFunderCriteria(actor(), summit.id)
  assert.equal(criteria.rules[0]?.value, 700)
  const blocked = await evaluateFunderScore(actor(), matchingInputs(680), summit, criteria.rules)
  assert.equal(blocked.eligible, false)
  const allowed = await evaluateFunderScore(actor(), matchingInputs(720), summit, criteria.rules)
  assert.equal(allowed.eligible, true)

  const replay = await commitFunderImport(actor(), {
    idempotencyKey: "import-ready-batch",
    rows: jsonPreview.rows,
  })
  assert.equal(replay.created.length, 0)
  assert.equal(replay.replayed.length, 2)
})

test("duplicate legal names and domains are excluded and cannot be forced through commit", async () => {
  await createFunder(actor(), {
    idempotencyKey: "existing-north",
    legalName: "North Shore Capital",
    domains: ["northshore.example"],
  })
  const preview = await previewFunderImport(actor(), {
    funders: [
      { legalName: "north shore capital", website: "https://other.example" },
      { legalName: "Different Name LLC", domains: ["northshore.example"] },
      { legalName: "Twin One LLC" },
      { legalName: "Twin One LLC" },
      { legalName: "Valid Import LLC", domains: ["valid-import.example"] },
    ],
  })
  assert.equal(preview.rows[0]?.status, "duplicate")
  assert.equal(preview.rows[0]?.duplicate?.match, "legal_name")
  assert.equal(preview.rows[0]?.included, false)
  assert.equal(preview.rows[1]?.status, "duplicate")
  assert.equal(preview.rows[1]?.duplicate?.match, "domain")
  assert.equal(preview.rows[2]?.status, "ready")
  assert.equal(preview.rows[3]?.status, "duplicate")
  assert.equal(preview.rows[3]?.duplicate?.match, "batch")
  assert.equal(preview.rows[4]?.status, "ready")

  await assert.rejects(
    () => commitFunderImport(actor(), {
      idempotencyKey: "import-forced-duplicate",
      rows: preview.rows.map((row) => ({ ...row, included: true })),
    }),
    (error: { status?: number; code?: string }) => error.status === 422 && error.code === "funder_import_review_required",
  )

  const saved = await commitFunderImport(actor(), {
    idempotencyKey: "import-ready-only",
    rows: preview.rows,
  })
  assert.equal(saved.created.length, 2)
  assert.equal(saved.created.some((item) => item.legalName === "Valid Import LLC"), true)
  assert.equal(saved.created.some((item) => item.legalName === "Twin One LLC"), true)
})

test("invalid rows stay out of the saved set and HTTP enforces admin plus workspace isolation", async () => {
  const preview = await previewFunderImport(actor(), {
    funders: [
      { legalName: "" },
      { legalName: "Reviewed Capital LLC", contacts: [{ email: "not-an-email" }] },
      { legalName: "Clean Import LLC" },
    ],
  })
  assert.equal(preview.rows[0]?.status, "invalid")
  assert.equal(preview.rows[1]?.status, "invalid")
  assert.equal(preview.rows[2]?.status, "ready")

  const httpPreview = await previewPost(cookieRequest("/api/mca/funders/import/preview", "import-admin-session", {
    method: "POST",
    body: JSON.stringify({ funders: [{ legalName: "HTTP Import LLC" }] }),
  }))
  assert.equal(httpPreview.status, 200)
  const body = await httpPreview.json() as { rows: Array<{ key: string; draft: { legalName: string }; included: boolean }> }
  const httpCommit = await commitPost(cookieRequest("/api/mca/funders/import/commit", "import-admin-session", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: "http-import", rows: body.rows }),
  }))
  assert.equal(httpCommit.status, 201)

  const repPreview = await previewPost(cookieRequest("/api/mca/funders/import/preview", "import-rep-session", {
    method: "POST",
    body: JSON.stringify({ funders: [{ legalName: "Rep Import LLC" }] }),
  }))
  assert.equal(repPreview.status, 403)

  const remote = await previewFunderImport(actor(ids.otherWorkspace), {
    funders: [{ legalName: "HTTP Import LLC" }],
  })
  assert.equal(remote.rows[0]?.status, "ready")
})
