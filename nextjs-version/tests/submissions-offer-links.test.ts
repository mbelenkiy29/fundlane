import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { storeDocument } from "../src/lib/mca/documents/service"
import { setDocumentScannerForTests, type DocumentScanner } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests, type DocumentStorage } from "../src/lib/mca/documents/storage"
import { createFunder } from "../src/lib/mca/funders/directory"
import { createSender, testSend } from "../src/lib/mca/senders/service"
import { parseEmailAttemptRef } from "../src/lib/mca/submissions/email-templates"
import { queueSubmissions } from "../src/lib/mca/submissions/queue"
import {
  setReplyMailboxForTests,
  type MailboxMessage,
  type ReplyMailbox,
} from "../src/lib/mca/submissions/replies"
import {
  setReplyOutcomeClassifierForTests,
  type ClassifiedReplyOutcome,
  type ReplyOutcomeClassifier,
  type ReplyOutcomeClassifierInput,
} from "../src/lib/mca/submissions/extract-outcomes"
import {
  OFFER_LINK_MAX_REDIRECTS,
  resolveOfferLink,
  setOfferLinkNetworkForTests,
} from "../src/lib/mca/submissions/offer-links"
import { POST as repliesRun } from "../src/app/api/mca/submissions/replies/run/route"
import { POST as extractPost } from "../src/app/api/mca/submissions/extract/route"
import { GET as linksGet, POST as linksPost } from "../src/app/api/mca/submissions/extract/links/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const SMTP_PASSWORD = "smtp-offer-links-password-never-leak"
const ids = {
  workspace: "workspace-offer-links",
  otherWorkspace: "workspace-offer-links-other",
  adminUser: "links-admin-user",
  adminMember: "links-admin-member",
  repUser: "links-rep-user",
  repMember: "links-rep-member",
  otherUser: "links-other-user",
  otherMember: "links-other-member",
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
const unknownTerm = { value: null, unknown: true }
const classifyCalls: ReplyOutcomeClassifierInput[] = []
const fetchCalls: Array<{ url: string; redirect?: RequestRedirect }> = []
const lookupCalls: string[] = []
const pages = new Map<string, () => Response>()
const originalFetch = globalThis.fetch
let globalFetchCalls = 0

function classified(partial: Partial<ClassifiedReplyOutcome> & Pick<ClassifiedReplyOutcome, "classification" | "summary">): ClassifiedReplyOutcome {
  return {
    confidence: 0.92,
    amount: unknownTerm,
    rate: unknownTerm,
    term: unknownTerm,
    frequency: unknownTerm,
    commission: unknownTerm,
    fees: [],
    offerLink: unknownTerm,
    stipulations: [],
    warnings: [],
    provider: "fixture",
    model: "fixture-v1",
    ...partial,
  }
}

function firstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>"']+/i)
  return match?.[0]?.replace(/[).,]+$/, "")
}

const fixtureClassifier: ReplyOutcomeClassifier = {
  name: "fixture",
  model: "fixture-v1",
  async classify(input) {
    classifyCalls.push(input)
    const hay = `${input.subject}\n${input.body}`
    const lower = hay.toLowerCase()
    const url = firstUrl(hay)
    const offerLink = url ? { value: url, unknown: false, evidence: url } : unknownTerm
    if (lower.includes("ignore previous") || lower.includes("weekly funder newsletter")) {
      return classified({ classification: "unrelated", summary: "Unrelated mailbox noise." })
    }
    if (lower.includes("$25,000") && lower.includes("1.35") && lower.includes("10 months")) {
      return classified({
        classification: "approval",
        summary: "Funder approved with email terms.",
        amount: { value: 25_000, unknown: false, evidence: "$25,000" },
        rate: { value: 1.35, unknown: false, evidence: "1.35" },
        term: { value: 10, unknown: false, evidence: "10 months" },
        offerLink,
      })
    }
    if (lower.includes("$20,000")) {
      return classified({
        classification: "approval",
        summary: "Funder approved with amount only.",
        amount: { value: 20_000, unknown: false, evidence: "$20,000" },
        offerLink,
      })
    }
    if (lower.includes("approved")) {
      return classified({ classification: "approval", summary: "Funder approved via portal link.", offerLink })
    }
    return classified({ classification: "unrelated", summary: "No funder decision found." })
  },
}

function fixtureMailbox(messages: MailboxMessage[]): ReplyMailbox {
  return {
    async listMessages() {
      return { messages, nextCursor: messages.at(-1)?.providerMessageId ?? "empty" }
    },
  }
}

function htmlPage(body: string, status = 200) {
  return () => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })
}

function jsonPage(body: unknown, status = 200) {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function redirectPage(location: string) {
  return () => new Response(null, { status: 302, headers: { location } })
}

function installNetwork() {
  setOfferLinkNetworkForTests({
    lookupImpl: async (hostname) => {
      lookupCalls.push(hostname)
      if (hostname === "private.example.test") return [{ address: "10.0.0.1", family: 4 }]
      if (hostname === "link-local.example.test") return [{ address: "169.254.10.10", family: 4 }]
      return [{ address: "203.0.113.10", family: 4 }]
    },
    fetchImpl: async (input, init) => {
      const url = String(input)
      fetchCalls.push({ url, redirect: init?.redirect })
      const factory = pages.get(url)
      if (!factory) throw new Error(`unexpected offer-link fetch: ${url}`)
      return factory()
    },
  })
}

let senderId = ""
let funderId = ""
let dealCounter = 0

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, workspace: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Offer Links Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "links-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "links-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "links-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("links-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("links-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("links-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("links-intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("links-read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("links-write-key", "write-secret", ["deals:write"], ids.workspace)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("submissions_offer_links")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_DOCUMENT_AI_PROVIDER
  delete process.env.OPENAI_API_KEY
  delete process.env.MCA_DOCUMENT_AI_MODEL
  globalThis.fetch = (async () => {
    globalFetchCalls += 1
    throw new Error("network disabled in MIC-128 tests")
  }) as typeof fetch
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  setReplyOutcomeClassifierForTests(fixtureClassifier)
  await seed()
  const sender = await createSender(actor(), {
    provider: "smtp",
    purpose: "submission",
    fromName: "Broker Desk",
    fromAddress: "broker@example.test",
    signature: "Best,\nBroker Desk",
    isDefault: true,
    smtp: { host: "smtp.example.test", port: 587, username: "broker", password: SMTP_PASSWORD },
  })
  senderId = sender.id
  await testSend(actor(), sender.id, { to: "ops@example.test" })
  funderId = (await createFunder(actor(), {
    idempotencyKey: "offer-links-alpha-funder",
    legalName: "Alpha Capital LLC",
    nickname: "Alpha",
    domains: ["alpha-links.example.test"],
    routes: [{ kind: "email", label: "Alpha inbox", destination: "submissions@alpha-links.example.test", documentExceptions: [], active: true }],
  })).funder.id
})

beforeEach(() => {
  classifyCalls.length = 0
  fetchCalls.length = 0
  lookupCalls.length = 0
  pages.clear()
  setReplyOutcomeClassifierForTests(fixtureClassifier)
  setDocumentScannerForTests(scanner)
  installNetwork()
})

after(async () => {
  globalThis.fetch = originalFetch
  setOfferLinkNetworkForTests()
  setReplyOutcomeClassifierForTests()
  setReplyMailboxForTests()
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

function assertNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(SMTP_PASSWORD), false)
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
  assert.equal(text.includes("body_cipher"), false)
}

async function seedDeal(name: string) {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `links-deal-${dealCounter}`,
    legalName: name,
    requestedAmount: 80_000,
    assignments: [
      { membershipId: ids.repMember, kind: "originator", isPrimary: true },
      { membershipId: ids.adminMember, kind: "closer", isPrimary: true },
    ],
  })).deal
  await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `links-doc-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  })
  return deal
}

async function sendTo(dealId: string) {
  const queued = await queueSubmissions({
    actor: actor(),
    dealId,
    funderIds: [funderId],
    confirmationKey: `links-send-${dealId}`,
  })
  assert.equal(queued.jobs[0]?.state, "sent")
  const attempt = await getDatabase().prepare<{ external_ref: string | null }>(
    "SELECT external_ref FROM mca_submission_attempts WHERE job_id = ?",
  ).get(queued.jobs[0]!.jobId)
  const ref = parseEmailAttemptRef(attempt?.external_ref)
  assert.ok(ref?.messageId)
  return { jobId: queued.jobs[0]!.jobId, ref }
}

async function ingest(messages: MailboxMessage[]) {
  setReplyMailboxForTests(fixtureMailbox(messages))
  const run = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ senderId, enabled: true }),
  }))
  assert.equal(run.status, 200)
  return await run.json() as { ingested: Array<{ id: string; providerMessageId: string; state: string }> }
}

async function persistExtract(replyId: string) {
  const extracted = await extractPost(cookieRequest("/api/mca/submissions/extract", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ replyId }),
  }))
  assert.equal(extracted.status, 200)
  return await extracted.json() as { offer?: { id: string; amount: number | null; termsUnknown: boolean; source: string; offerLink?: string | null }; termsUnknown?: boolean }
}

type LinkBody = {
  state: string
  replyId: string
  replayed: boolean
  fetched: boolean
  skipped: boolean
  blocked: boolean
  inaccessible: boolean
  reason?: string
  message?: string
  offer?: {
    id: string
    status: string
    amount: number | null
    rate: number | null
    term: number | null
    offerLink: string | null
    source: string
    termsUnknown: boolean
    requiresReview: boolean
    created: boolean
  }
}

test("MIC-128: private-network and non-https URLs are rejected before fetch", async () => {
  assert.equal(OFFER_LINK_MAX_REDIRECTS, 3)
  const loopback = await resolveOfferLink({ url: "http://127.0.0.1/secret-portal" })
  assert.equal(loopback.blocked, true)
  assert.equal(loopback.fetched, false)
  assert.equal(loopback.skipped, false)
  assert.equal(loopback.terms.amount, null)
  assert.match(loopback.message, /rejected before fetch|HTTPS/i)

  const httpsLoopback = await resolveOfferLink({ url: "https://127.0.0.1/secret-portal" })
  assert.equal(httpsLoopback.blocked, true)
  assert.equal(httpsLoopback.fetched, false)
  assert.equal(httpsLoopback.reason, "private_network")

  const metadata = await resolveOfferLink({ url: "https://169.254.169.254/latest/meta-data/" })
  assert.equal(metadata.blocked, true)
  assert.equal(metadata.fetched, false)

  const metadataHost = await resolveOfferLink({ url: "https://metadata.google.internal/computeMetadata/v1/" })
  assert.equal(metadataHost.blocked, true)
  assert.equal(metadataHost.fetched, false)

  const ipv6 = await resolveOfferLink({ url: "https://[::1]/" })
  assert.equal(ipv6.blocked, true)
  assert.equal(ipv6.fetched, false)

  const ula = await resolveOfferLink({ url: "https://[fd00::1]/" })
  assert.equal(ula.blocked, true)
  assert.equal(ula.fetched, false)

  const insecure = await resolveOfferLink({ url: "http://offers.example.test/portal" })
  assert.equal(insecure.blocked, true)
  assert.equal(insecure.fetched, false)
  assert.equal(insecure.reason, "insecure_scheme")

  const privateDns = await resolveOfferLink({ url: "https://private.example.test/portal" })
  assert.equal(privateDns.blocked, true)
  assert.equal(privateDns.fetched, false)
  assert.equal(lookupCalls.includes("private.example.test"), true)

  pages.set("https://offers.example.test/to-loopback", redirectPage("http://127.0.0.1/internal"))
  const redirected = await resolveOfferLink({ url: "https://offers.example.test/to-loopback" })
  assert.equal(redirected.blocked, true)
  assert.equal(fetchCalls.some((item) => item.url === "https://offers.example.test/to-loopback"), true)
  assert.equal(fetchCalls.some((item) => item.url.includes("127.0.0.1")), false)
  assert.equal(fetchCalls.every((item) => item.redirect === "manual"), true)

  pages.set("https://offers.example.test/r1", redirectPage("https://offers.example.test/r2"))
  pages.set("https://offers.example.test/r2", redirectPage("https://offers.example.test/r3"))
  pages.set("https://offers.example.test/r3", redirectPage("https://offers.example.test/r4"))
  pages.set("https://offers.example.test/r4", redirectPage("https://offers.example.test/r5"))
  const tooMany = await resolveOfferLink({ url: "https://offers.example.test/r1" })
  assert.equal(tooMany.inaccessible, true)
  assert.equal(tooMany.terms.amount, null)
  assert.equal(fetchCalls.some((item) => item.url === "https://offers.example.test/r5"), false)

  assert.equal(fetchCalls.some((item) => item.url.includes("127.0.0.1")), false)
  assert.equal(lookupCalls.includes("127.0.0.1"), false)
  assert.equal(globalFetchCalls, 0)

  const deal = await seedDeal("Loopback Portal LLC")
  await sendTo(deal.id)
  const ingested = await ingest([{
    providerMessageId: "alpha-loopback-link",
    threadId: "thread-loopback-link",
    from: "uw@alpha-links.example.test",
    subject: `Application approved for ${deal.displayId}`,
    body: "Your application is approved. View the offer: http://127.0.0.1/secret-portal",
  }])
  const replyId = ingested.ingested.find((item) => item.providerMessageId === "alpha-loopback-link")?.id
  assert.ok(replyId)
  const extracted = await persistExtract(replyId)
  assert.equal(extracted.offer?.amount, null)
  fetchCalls.length = 0
  lookupCalls.length = 0
  const blocked = await linksPost(cookieRequest("/api/mca/submissions/extract/links", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ replyId }),
  }))
  assert.equal(blocked.status, 200)
  const blockedBody = await blocked.json() as LinkBody
  assert.equal(blockedBody.state, "blocked")
  assert.equal(blockedBody.fetched, false)
  assert.equal(blockedBody.blocked, true)
  assert.equal(blockedBody.offer?.amount, null)
  assert.equal(JSON.stringify(blockedBody).includes("25000"), false)
  assert.equal(fetchCalls.length, 0)
  assertNoSecret(blockedBody)
})

test("MIC-128: email terms skip fetch; inaccessible portal is manual-review; retries keep the offer id", async () => {
  const skipDeal = await seedDeal("Email Terms First LLC")
  await sendTo(skipDeal.id)
  const skipIngested = await ingest([{
    providerMessageId: "alpha-email-terms",
    threadId: "thread-email-terms",
    from: "uw@alpha-links.example.test",
    subject: `Application approved for ${skipDeal.displayId}`,
    body: "Your application is approved for $25,000 at factor 1.35 for 10 months. Portal: https://offers.example.test/skip-fetch",
  }])
  const skipReplyId = skipIngested.ingested.find((item) => item.providerMessageId === "alpha-email-terms")?.id
  assert.ok(skipReplyId)
  const skipExtract = await persistExtract(skipReplyId)
  assert.equal(skipExtract.offer?.amount, 25_000)
  const skipOfferId = skipExtract.offer!.id
  fetchCalls.length = 0
  const skipped = await linksPost(cookieRequest("/api/mca/submissions/extract/links", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ replyId: skipReplyId }),
  }))
  assert.equal(skipped.status, 200)
  const skippedBody = await skipped.json() as LinkBody
  assert.equal(skippedBody.state, "skipped")
  assert.equal(skippedBody.fetched, false)
  assert.equal(skippedBody.skipped, true)
  assert.equal(skippedBody.offer?.id, skipOfferId)
  assert.equal(skippedBody.offer?.amount, 25_000)
  assert.equal(skippedBody.offer?.source, "email")
  assert.equal(fetchCalls.length, 0)

  const skipAgain = await linksPost(cookieRequest("/api/mca/submissions/extract/links", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ replyId: skipReplyId }),
  }))
  const skipAgainBody = await skipAgain.json() as LinkBody
  assert.equal(skipAgainBody.replayed, true)
  assert.equal(skipAgainBody.offer?.id, skipOfferId)
  assert.equal(fetchCalls.length, 0)

  pages.set("https://offers.example.test/login-wall", htmlPage(`<!doctype html><html><body>
    <h1>Sign in</h1>
    <form action="/login"><input type="password" name="password"><button>Sign in</button></form>
    <p>Approved amount $9,999,999 at factor 1.01 for 6 months.</p>
  </body></html>`))
  const closedDeal = await seedDeal("Inaccessible Portal LLC")
  await sendTo(closedDeal.id)
  const closedIngested = await ingest([{
    providerMessageId: "alpha-login-wall",
    threadId: "thread-login-wall",
    from: "uw@alpha-links.example.test",
    subject: `Application approved for ${closedDeal.displayId}`,
    body: "Your application is approved. View the offer: https://offers.example.test/login-wall",
  }])
  const closedReplyId = closedIngested.ingested.find((item) => item.providerMessageId === "alpha-login-wall")?.id
  assert.ok(closedReplyId)
  const closedExtract = await persistExtract(closedReplyId)
  assert.equal(closedExtract.offer?.amount, null)
  assert.equal(closedExtract.offer?.termsUnknown, true)
  const closedOfferId = closedExtract.offer!.id
  fetchCalls.length = 0
  const incomplete = await linksPost(cookieRequest("/api/mca/submissions/extract/links", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ replyId: closedReplyId }),
  }))
  assert.equal(incomplete.status, 200)
  const incompleteBody = await incomplete.json() as LinkBody
  assert.equal(incompleteBody.state, "incomplete")
  assert.equal(incompleteBody.fetched, true)
  assert.equal(incompleteBody.inaccessible, true)
  assert.equal(incompleteBody.offer?.id, closedOfferId)
  assert.equal(incompleteBody.offer?.created, false)
  assert.equal(incompleteBody.offer?.amount, null)
  assert.equal(incompleteBody.offer?.rate, null)
  assert.equal(incompleteBody.offer?.term, null)
  assert.equal(incompleteBody.offer?.termsUnknown, true)
  assert.equal(incompleteBody.offer?.requiresReview, true)
  assert.equal(incompleteBody.offer?.status, "received")
  assert.equal(incompleteBody.offer?.source, "link")
  assert.equal(incompleteBody.offer?.offerLink, "https://offers.example.test/login-wall")
  assert.equal(JSON.stringify(incompleteBody).includes("9999999"), false)
  assert.equal(JSON.stringify(incompleteBody).includes("25000"), false)
  assert.match(incompleteBody.message ?? "", /manual review|sign-in|unknown/i)
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0]?.redirect, "manual")
  const storedClosed = await getDatabase().prepare<{ amount: number | null; terms_unknown: number | string; offer_link: string | null; source: string | null }>(
    "SELECT amount, terms_unknown, offer_link, source FROM deal_offers WHERE id = ?",
  ).get(closedOfferId)
  assert.equal(storedClosed?.amount, null)
  assert.equal(Number(storedClosed?.terms_unknown), 1)
  assert.equal(storedClosed?.offer_link, "https://offers.example.test/login-wall")
  assert.equal(storedClosed?.source, "link")

  const closedReplay = await linksPost(cookieRequest("/api/mca/submissions/extract/links", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ replyId: closedReplyId }),
  }))
  const closedReplayBody = await closedReplay.json() as LinkBody
  assert.equal(closedReplayBody.replayed, true)
  assert.equal(closedReplayBody.offer?.id, closedOfferId)
  assert.equal(closedReplayBody.offer?.amount, null)
  const offerCount = await getDatabase().prepare<{ count: number }>(
    "SELECT count(*)::int AS count FROM deal_offers WHERE deal_id = ?",
  ).get(closedDeal.id)
  assert.equal(offerCount?.count, 1)

  pages.set("https://offers.example.test/offers/abc", htmlPage(`<!doctype html><html><body>
    <h1>Your MCA offer</h1>
    <p data-amount="25000" data-rate="1.35" data-term="10">Amount: $25,000. Factor: 1.35. Term: 10 months. Frequency: daily.</p>
  </body></html>`))
  const successDeal = await seedDeal("Readable Portal LLC")
  await sendTo(successDeal.id)
  const successIngested = await ingest([{
    providerMessageId: "alpha-portal-success",
    threadId: "thread-portal-success",
    from: "uw@alpha-links.example.test",
    subject: `Application approved for ${successDeal.displayId}`,
    body: "Your application is approved. View the offer: https://offers.example.test/offers/abc",
  }])
  const successReplyId = successIngested.ingested.find((item) => item.providerMessageId === "alpha-portal-success")?.id
  assert.ok(successReplyId)
  const successExtract = await persistExtract(successReplyId)
  const successOfferId = successExtract.offer!.id
  fetchCalls.length = 0
  const success = await linksPost(cookieRequest("/api/mca/submissions/extract/links", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ replyId: successReplyId }),
  }))
  const successBody = await success.json() as LinkBody
  assert.equal(successBody.state, "success")
  assert.equal(successBody.fetched, true)
  assert.equal(successBody.offer?.id, successOfferId)
  assert.equal(successBody.offer?.amount, 25_000)
  assert.equal(successBody.offer?.rate, 1.35)
  assert.equal(successBody.offer?.term, 10)
  assert.equal(successBody.offer?.termsUnknown, false)
  assert.equal(successBody.offer?.source, "link")
  assert.equal(successBody.offer?.status, "presented")
  assert.equal(successBody.offer?.offerLink, "https://offers.example.test/offers/abc")
  const successReplay = await linksPost(cookieRequest("/api/mca/submissions/extract/links", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ replyId: successReplyId }),
  }))
  const successReplayBody = await successReplay.json() as LinkBody
  assert.equal(successReplayBody.replayed, true)
  assert.equal(successReplayBody.fetched, false)
  assert.equal(successReplayBody.offer?.id, successOfferId)
  assert.equal(successReplayBody.offer?.amount, 25_000)

  pages.set("https://offers.example.test/portal-merge", htmlPage(`<!doctype html><html><body>
    <p>Amount: $25,000. Factor: 1.49. Term: 12 months.</p>
  </body></html>`))
  const mergeDeal = await seedDeal("Email Amount Preferred LLC")
  await sendTo(mergeDeal.id)
  const mergeIngested = await ingest([{
    providerMessageId: "alpha-portal-merge",
    threadId: "thread-portal-merge",
    from: "uw@alpha-links.example.test",
    subject: `Application approved for ${mergeDeal.displayId}`,
    body: "Your application is approved for $20,000. View the offer: https://offers.example.test/portal-merge",
  }])
  const mergeReplyId = mergeIngested.ingested.find((item) => item.providerMessageId === "alpha-portal-merge")?.id
  assert.ok(mergeReplyId)
  await persistExtract(mergeReplyId)
  const merged = await linksPost(cookieRequest("/api/mca/submissions/extract/links", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ replyId: mergeReplyId }),
  }))
  const mergedBody = await merged.json() as LinkBody
  assert.equal(mergedBody.state, "success")
  assert.equal(mergedBody.offer?.amount, 20_000)
  assert.equal(mergedBody.offer?.rate, 1.49)
  assert.equal(mergedBody.offer?.term, 12)

  pages.set("https://offers.example.test/offers.json", jsonPage({ amount: 18_000, rate: 1.22, term: 8, frequency: "weekly" }))
  const jsonTerms = await resolveOfferLink({ url: "https://offers.example.test/offers.json" })
  assert.equal(jsonTerms.fetched, true)
  assert.equal(jsonTerms.terms.amount, 18_000)
  assert.equal(jsonTerms.terms.rate, 1.22)
  assert.equal(jsonTerms.terms.term, 8)
  assert.equal(jsonTerms.termsUnknown, false)
  assert.equal(globalFetchCalls, 0)
  assertNoSecret(successBody)
  assertNoSecret(incompleteBody)
})

test("MIC-128: API states and permissions match the UI; secrets omitted", async () => {
  const deal = await seedDeal("Offer Link ACL LLC")
  await sendTo(deal.id)
  const ingested = await ingest([{
    providerMessageId: "alpha-acl-link",
    threadId: "thread-acl-link",
    from: "uw@alpha-links.example.test",
    subject: `Application approved for ${deal.displayId}`,
    body: "Your application is approved. View the offer: https://offers.example.test/acl",
  }])
  const replyId = ingested.ingested.find((item) => item.providerMessageId === "alpha-acl-link")?.id
  assert.ok(replyId)

  const missingBoth = await linksGet(cookieRequest("/api/mca/submissions/extract/links", "admin-session-token"))
  assert.equal(missingBoth.status, 422)
  const missingReply = await linksPost(cookieRequest("/api/mca/submissions/extract/links", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({}),
  }))
  assert.equal(missingReply.status, 422)
  const badJson = await linksPost(cookieRequest("/api/mca/submissions/extract/links", "admin-session-token", {
    method: "POST",
    body: "{",
  }))
  assert.equal(badJson.status, 400)

  const beforeExtract = await linksGet(cookieRequest(`/api/mca/submissions/extract/links?replyId=${replyId}`, "admin-session-token"))
  assert.equal(beforeExtract.status, 200)
  const beforeExtractBody = await beforeExtract.json() as LinkBody
  assert.equal(beforeExtractBody.state, "empty")
  assert.match(beforeExtractBody.message ?? "", /Extract the funder reply/)

  await persistExtract(replyId)
  const pending = await linksGet(cookieRequest(`/api/mca/submissions/extract/links?replyId=${replyId}`, "admin-session-token"))
  const pendingBody = await pending.json() as LinkBody
  assert.equal(pendingBody.state, "empty")
  assert.match(pendingBody.message ?? "", /not been fetched/)

  const emptyList = await linksGet(cookieRequest(`/api/mca/submissions/extract/links?dealId=${deal.id}`, "admin-session-token"))
  assert.equal(emptyList.status, 200)
  const emptyListBody = await emptyList.json() as { state: string; message?: string; extractions: LinkBody[] }
  assert.equal(emptyListBody.state, "empty")
  assert.match(emptyListBody.message ?? "", /No offer-link extractions/)

  pages.set("https://offers.example.test/acl", () => new Response("Sign in required $9,999,999", { status: 401, headers: { "content-type": "text/plain" } }))
  const intakeGet = await linksGet(bearerRequest(`/api/mca/submissions/extract/links?replyId=${replyId}`, "intake-secret"))
  assert.equal(intakeGet.status, 403)
  const intakePost = await linksPost(bearerRequest("/api/mca/submissions/extract/links", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ replyId }),
  }))
  assert.equal(intakePost.status, 403)

  const readGet = await linksGet(bearerRequest(`/api/mca/submissions/extract/links?replyId=${replyId}`, "read-secret"))
  assert.equal(readGet.status, 200)
  assertNoSecret(await readGet.json())
  const readPost = await linksPost(bearerRequest("/api/mca/submissions/extract/links", "read-secret", {
    method: "POST",
    body: JSON.stringify({ replyId }),
  }))
  assert.equal(readPost.status, 403)

  const writePost = await linksPost(bearerRequest("/api/mca/submissions/extract/links", "write-secret", {
    method: "POST",
    body: JSON.stringify({ replyId }),
  }))
  assert.equal(writePost.status, 200)
  const writeBody = await writePost.json() as LinkBody
  assert.equal(writeBody.state, "incomplete")
  assert.equal(writeBody.offer?.amount, null)
  assert.equal(JSON.stringify(writeBody).includes("9999999"), false)
  assertNoSecret(writeBody)

  const listed = await linksGet(cookieRequest(`/api/mca/submissions/extract/links?dealId=${deal.id}`, "admin-session-token"))
  const listedBody = await listed.json() as { state: string; extractions: LinkBody[] }
  assert.equal(listedBody.state, "ready")
  assert.equal(listedBody.extractions.some((item) => item.replyId === replyId && item.state === "incomplete"), true)

  const cross = await linksGet(cookieRequest(`/api/mca/submissions/extract/links?dealId=${deal.id}`, "other-session-token"))
  assert.equal(cross.status, 404)
  assert.equal(globalFetchCalls, 0)
})
