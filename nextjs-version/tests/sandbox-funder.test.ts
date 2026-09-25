import "./helpers/business-auth"
import test, { after, afterEach, before } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { PDFDocument } from "pdf-lib"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { storeDocument } from "../src/lib/mca/documents/service"
import { setDocumentScannerForTests, type DocumentScanner } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests, type DocumentStorage } from "../src/lib/mca/documents/storage"
import { createFunder, listFunders, updateFunder } from "../src/lib/mca/funders/directory"
import { getOffers } from "../src/lib/mca/offers/service"
import {
  SANDBOX_DOMAIN,
  SANDBOX_FUNDER_IDEMPOTENCY_KEY,
  SANDBOX_LEGAL_NAME,
  SANDBOX_NICKNAME,
  SANDBOX_PRODUCT,
  SANDBOX_ROUTE_DESTINATION,
} from "../src/lib/mca/sandbox/labels"
import { getSandboxFunderStatus, setSandboxFunderEnabled } from "../src/lib/mca/sandbox/service"
import { getSampleStatementPdf, listSampleStatementCatalog } from "../src/lib/mca/sandbox/statements"
import { queueSubmissions, setSubmissionCompletenessForTests } from "../src/lib/mca/submissions/queue"
import { GET as sandboxGet, POST as sandboxPost } from "../src/app/api/mca/sandbox/route"
import { GET as statementGet } from "../src/app/api/mca/sandbox/statements/[id]/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let fetchCalls = 0
const originalFetch = globalThis.fetch

const ids = {
  workspace: "workspace-sandbox",
  otherWorkspace: "workspace-sandbox-other",
  adminUser: "sandbox-admin-user",
  adminMember: "sandbox-admin-member",
  repUser: "sandbox-rep-user",
  repMember: "sandbox-rep-member",
  otherUser: "sandbox-other-user",
  otherMember: "sandbox-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => ({
  workspaceId,
  userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
  membershipId: workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember,
  role,
  managedMembershipIds: [],
  activeMembershipIds: [workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember],
  source: role ? "user" : "api_key",
  correlationId: `corr-${workspaceId}-${role ?? "key"}`,
})

const memory = new Map<string, Uint8Array>()
const storage: DocumentStorage = {
  name: "test-memory",
  async putImmutable(key, bytes) {
    if (memory.has(key)) throw new Error("duplicate storage key")
    memory.set(key, new Uint8Array(bytes))
  },
  async get(key) {
    const value = memory.get(key)
    if (!value) throw new Error("missing storage key")
    return new Uint8Array(value)
  },
}
const scanner: DocumentScanner = {
  name: "fixture-clean",
  async scan() {
    return { status: "clean", provider: "fixture-clean", evidence: { engineVerified: true } }
  },
}

const minimalPdf = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"))
let dealCounter = 0

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Sandbox Test"], [ids.otherWorkspace, "Other Sandbox Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "sandbox-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "sandbox-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "sandbox-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("sandbox-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("sandbox-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("sandbox-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("sandbox_funder")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  setSubmissionCompletenessForTests(true)
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1
    throw new Error(`sandbox test blocked outbound fetch: ${String(args[0])}`)
  }) as typeof fetch
  await seed()
})

afterEach(() => {
  fetchCalls = 0
  setSubmissionCompletenessForTests(true)
})

after(async () => {
  globalThis.fetch = originalFetch
  setSubmissionCompletenessForTests()
  setDocumentStorageForTests()
  setDocumentScannerForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

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

async function readyDeal(legalName: string, workspaceId = ids.workspace) {
  dealCounter += 1
  const current = actor(workspaceId)
  const deal = (await createDeal(current, {
    idempotencyKey: `sandbox-deal-${workspaceId}-${dealCounter}`,
    legalName,
  })).deal
  await storeDocument(current, {
    dealId: deal.id,
    idempotencyKey: `sandbox-doc-${workspaceId}-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  })
  return deal
}

test("sandbox funder enable is workspace-scoped, labeled, and isolated", async () => {
  const enabled = await setSandboxFunderEnabled(actor(), true)
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.funder?.legalName, SANDBOX_LEGAL_NAME)
  assert.equal(enabled.funder?.nickname, SANDBOX_NICKNAME)
  assert.equal(enabled.funder?.sandbox, true)
  assert.equal(enabled.funder?.domains.includes(SANDBOX_DOMAIN), true)
  assert.equal(enabled.funder?.routes[0]?.destination, SANDBOX_ROUTE_DESTINATION)
  assert.equal(enabled.funder?.routes[0]?.kind, "api")
  assert.match(enabled.warning, /never emails/i)

  const local = await listFunders(actor())
  assert.equal(local.some((funder) => funder.id === enabled.funder?.id), true)
  const foreign = await listFunders(actor(ids.otherWorkspace))
  assert.equal(foreign.some((funder) => funder.id === enabled.funder?.id), false)
  assert.equal((await getSandboxFunderStatus(actor(ids.otherWorkspace))).enabled, false)

  const other = await setSandboxFunderEnabled(actor(ids.otherWorkspace), true)
  assert.equal(other.enabled, true)
  assert.notEqual(other.funder?.id, enabled.funder?.id)
  assert.equal(other.funder?.workspaceId, ids.otherWorkspace)
})

test("regular create/update cannot impersonate or relabel the sandbox funder", async () => {
  await setSandboxFunderEnabled(actor(), true)
  await assert.rejects(
    () => createFunder(actor(), {
      idempotencyKey: SANDBOX_FUNDER_IDEMPOTENCY_KEY,
      legalName: "Looks Real Capital",
      routes: [{ kind: "email", label: "Subs", destination: "subs@real.example", documentExceptions: [], active: true }],
    }),
    (error: { status?: number }) => error.status === 422,
  )
  await assert.rejects(
    () => createFunder(actor(), {
      idempotencyKey: "copycat-sandbox",
      legalName: "Copycat Capital",
      routes: [{ kind: "api", label: "API", destination: SANDBOX_ROUTE_DESTINATION, documentExceptions: [], active: true }],
    }),
    (error: { status?: number }) => error.status === 422,
  )
  const status = await getSandboxFunderStatus(actor())
  assert.ok(status.funder)
  await assert.rejects(
    () => updateFunder(actor(), status.funder!.id, { legalName: "Everyday Advance LLC" }),
    (error: { status?: number }) => error.status === 422,
  )
  await assert.rejects(
    () => updateFunder(actor(), status.funder!.id, {
      routes: [
        { kind: "api", label: "Sandbox", destination: SANDBOX_ROUTE_DESTINATION, documentExceptions: [], active: true },
        { kind: "email", label: "Live", destination: "subs@example.test", documentExceptions: [], active: true },
      ],
    }),
    (error: { status?: number }) => error.status === 422,
  )
  await assert.rejects(
    () => createFunder(actor(), {
      idempotencyKey: "named-like-sandbox",
      legalName: "[SANDBOX] Everyday Advance LLC",
      routes: [{ kind: "email", label: "Subs", destination: "subs@example.test", documentExceptions: [], active: true }],
    }),
    (error: { status?: number }) => error.status === 422,
  )
  const legacy = await createFunder(actor(), {
    idempotencyKey: "legacy-sandboxish-name",
    legalName: "Legacy Merchant Capital",
    nickname: "Legacy",
    website: "https://legacy.example.test",
    contacts: [{ name: "Pat", email: "pat@legacy.example.test" }],
    routes: [{ kind: "email", label: "Subs", destination: "subs@legacy.example.test", documentExceptions: [], active: true }],
  })
  await getDatabase().prepare("UPDATE mca_funders SET legal_name = ?, nickname = ? WHERE workspace_id = ? AND id = ?")
    .run("Legacy [SANDBOX] Merchant Capital", "Legacy [SANDBOX]", ids.workspace, legacy.funder.id)
  const savedLegacy = await updateFunder(actor(), legacy.funder.id, {
    legalName: "Legacy [SANDBOX] Merchant Capital",
    nickname: "Legacy [SANDBOX]",
    website: "https://legacy-updated.example.test",
  })
  assert.equal(savedLegacy.website, "https://legacy-updated.example.test")
  assert.equal(savedLegacy.legalName, "Legacy [SANDBOX] Merchant Capital")

  const sandboxSaved = await updateFunder(actor(), status.funder!.id, {
    website: "https://sandbox.fundlane.invalid/docs",
    contacts: [{ name: "Sandbox desk", email: "sandbox@fundlane.invalid" }],
    products: [SANDBOX_PRODUCT, "Demo extra product"],
  })
  assert.equal(sandboxSaved.website, "https://sandbox.fundlane.invalid/docs")
  assert.equal(sandboxSaved.contacts[0]?.email, "sandbox@fundlane.invalid")
  assert.equal(sandboxSaved.products.includes("Demo extra product"), true)
  assert.equal(sandboxSaved.routes.length, 1)
  assert.equal(sandboxSaved.routes[0]?.destination, SANDBOX_ROUTE_DESTINATION)

  const disabled = await setSandboxFunderEnabled(actor(), false)
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.funder?.website, "https://sandbox.fundlane.invalid/docs")
  assert.equal(disabled.funder?.contacts[0]?.email, "sandbox@fundlane.invalid")
  assert.equal(disabled.funder?.products.includes("Demo extra product"), true)
  const reenabled = await setSandboxFunderEnabled(actor(), true)
  assert.equal(reenabled.enabled, true)
  assert.equal(reenabled.funder?.website, "https://sandbox.fundlane.invalid/docs")
  assert.equal(reenabled.funder?.contacts[0]?.email, "sandbox@fundlane.invalid")
  assert.equal(reenabled.funder?.products.includes("Demo extra product"), true)
  assert.equal(reenabled.funder?.legalName, SANDBOX_LEGAL_NAME)
  assert.equal(reenabled.funder?.routes[0]?.destination, SANDBOX_ROUTE_DESTINATION)
})

test("sandbox submission returns a synthetic offer and never touches the network", async () => {
  const sandbox = await setSandboxFunderEnabled(actor(), true)
  const deal = await readyDeal("QA Test Pizza LLC")
  const queued = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [sandbox.funder!.id],
    confirmationKey: `sandbox-offer-${deal.id}`,
  })
  assert.equal(queued.jobs[0]?.state, "sent")
  assert.equal(fetchCalls, 0)
  const offers = await getOffers(actor(), deal.id)
  assert.equal(offers.length, 1)
  assert.equal(offers[0]?.funderName, SANDBOX_LEGAL_NAME)
  assert.equal(offers[0]?.funderId, sandbox.funder?.id)
  assert.equal(offers[0]?.source, "manual")
  assert.equal(offers[0]?.revisions[0]?.amountCents, 5_000_000)
  assert.match(offers[0]?.revisions[0]?.stipulations?.[0] ?? "", /SYNTHETIC SANDBOX OFFER/)
})

test("sandbox decline path stays in-workspace and creates no offer", async () => {
  const sandbox = await setSandboxFunderEnabled(actor(), true)
  const deal = await readyDeal(`Decline Path ${SANDBOX_NICKNAME} SANDBOX-DECLINE LLC`)
  const queued = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [sandbox.funder!.id],
    confirmationKey: `sandbox-decline-${deal.id}`,
  })
  assert.equal(queued.jobs[0]?.state, "declined")
  assert.match(queued.jobs[0]?.reason ?? "", /Synthetic decline/)
  assert.equal(fetchCalls, 0)
  assert.equal((await getOffers(actor(), deal.id)).length, 0)
})

test("disabled sandbox funder cannot be selected and other workspaces cannot submit to it", async () => {
  const sandbox = await setSandboxFunderEnabled(actor(), true)
  await setSandboxFunderEnabled(actor(), false)
  assert.equal((await getSandboxFunderStatus(actor())).enabled, false)
  const deal = await readyDeal("After Disable Pizza LLC")
  const queued = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [sandbox.funder!.id],
    confirmationKey: `sandbox-disabled-${deal.id}`,
  })
  assert.equal(queued.jobs[0]?.state, "preflight_failed")

  const foreignDeal = await readyDeal("Foreign Pizza LLC", ids.otherWorkspace)
  const foreignQueued = await queueSubmissions({
    actor: actor(ids.otherWorkspace),
    dealId: foreignDeal.id,
    funderIds: [sandbox.funder!.id],
    confirmationKey: `sandbox-foreign-${foreignDeal.id}`,
  })
  assert.equal(foreignQueued.jobs[0]?.state, "preflight_failed")
})

test("sample bank statements are labeled synthetic PDFs", async () => {
  const catalog = listSampleStatementCatalog()
  assert.equal(catalog.length, 6)
  assert.equal(catalog.every((item) => item.synthetic && item.filename.includes("SYNTHETIC")), true)
  const pizza = catalog.find((item) => item.merchantId === "qa-pizza")
  assert.ok(pizza)
  const { statement, bytes } = await getSampleStatementPdf(pizza.id)
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString("ascii"), "%PDF-")
  const parsed = await PDFDocument.load(bytes)
  assert.match(parsed.getTitle() ?? "", /SYNTHETIC SAMPLE/)
  assert.match(parsed.getSubject() ?? "", /Not a real account/)
  assert.match(statement.merchantName, /QA Test Pizza LLC/)
  assert.equal(createHash("sha256").update(bytes).digest("hex").length, 64)
})

test("sandbox HTTP enable, isolation, and statement download stay on the session workspace", async () => {
  const invalid = await sandboxPost(cookieRequest("/api/mca/sandbox", "admin-session-token", {
    method: "POST",
    body: "null",
  }))
  assert.equal(invalid.status, 422)

  const forbidden = await sandboxPost(cookieRequest("/api/mca/sandbox", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ enabled: true }),
  }))
  assert.equal(forbidden.status, 403)

  const enabled = await sandboxPost(cookieRequest("/api/mca/sandbox", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ enabled: true }),
  }))
  assert.equal(enabled.status, 200)
  const body = await enabled.json() as { enabled: boolean; funder: { id: string; workspaceId: string; legalName: string } }
  assert.equal(body.enabled, true)
  assert.equal(body.funder.workspaceId, ids.workspace)
  assert.equal(body.funder.legalName, SANDBOX_LEGAL_NAME)

  const other = await sandboxGet(cookieRequest("/api/mca/sandbox", "other-session-token"))
  assert.equal(other.status, 200)
  const otherBody = await other.json() as { funder: { id: string; workspaceId: string } | null }
  if (otherBody.funder) {
    assert.notEqual(otherBody.funder.id, body.funder.id)
    assert.equal(otherBody.funder.workspaceId, ids.otherWorkspace)
  }

  const catalog = listSampleStatementCatalog()
  const downloaded = await statementGet(cookieRequest(`/api/mca/sandbox/statements/${catalog[0]!.id}`, "admin-session-token"), {
    params: Promise.resolve({ id: catalog[0]!.id }),
  })
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get("content-type"), "application/pdf")
  assert.equal(downloaded.headers.get("x-fundlane-synthetic"), "1")
  const bytes = new Uint8Array(await downloaded.arrayBuffer())
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString("ascii"), "%PDF-")
})
