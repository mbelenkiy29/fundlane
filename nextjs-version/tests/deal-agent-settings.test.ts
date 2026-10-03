import assert from "node:assert/strict"
import { after, before, mock, test } from "node:test"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import type { AuthContext, WorkspaceSettings } from "../src/lib/mca/types"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { interactionSetup, runClient } from "./helpers/public-entry-render"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const previousEnv = { ...process.env }
let context: AuthContext

// Only the authentication boundary is replaced; the real route, workspace service and database run.
mock.module(new URL("../src/lib/mca/auth.ts", import.meta.url).href, { namedExports: {
  assertTrustedMutation: () => {},
  requireWorkspaceAccess: async () => context,
  requireMembershipAccess: async (_request: Request, roles: string[]) => {
    assert.deepEqual(roles, ["admin", "super_admin"])
    return context
  },
} })

before(async () => {
  database = await createPostgresTestDatabase("deal_agent_settings")
  process.env.DATABASE_URL = database.databaseUrl
  delete process.env.MCA_DEAL_AGENT_ENABLED
})

after(async () => {
  await closeDatabaseForTests()
  await database.close()
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
  Object.assign(process.env, previousEnv)
})

let seq = 0
async function seedWorkspace(featureFlags: Record<string, boolean>): Promise<string> {
  const id = `da-settings-ws-${++seq}`
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,'America/New_York',5,?,'{}','{}',?,?)`).run(id, `Deal agent settings ${seq}`, JSON.stringify(featureFlags), now, now)
  context = { authType: "session", userId: null, membershipId: null, workspaceId: id, role: "super_admin", scopes: [], sessionId: null }
  return id
}

async function withAgentEnv<T>(value: string | undefined, callback: () => Promise<T>): Promise<T> {
  const previous = process.env.MCA_DEAL_AGENT_ENABLED
  if (value === undefined) delete process.env.MCA_DEAL_AGENT_ENABLED
  else process.env.MCA_DEAL_AGENT_ENABLED = value
  try { return await callback() } finally {
    if (previous === undefined) delete process.env.MCA_DEAL_AGENT_ENABLED
    else process.env.MCA_DEAL_AGENT_ENABLED = previous
  }
}

async function getSettings(): Promise<WorkspaceSettings> {
  const { GET } = await import("../src/app/api/workspace/route")
  const response = await GET(new Request("http://localhost/api/workspace"))
  assert.equal(response.status, 200)
  return response.json()
}

async function storedFlags(workspaceId: string) {
  const row = await getDatabase().prepare<{ feature_flags: string }>("SELECT feature_flags FROM workspaces WHERE id = ?").get(workspaceId)
  return JSON.parse(row!.feature_flags)
}

test("settings API marks the Deal Agent setting unavailable unless MCA_DEAL_AGENT_ENABLED is exactly true", async () => {
  await seedWorkspace({ dealAgent: true })
  for (const value of [undefined, "", "false", "1", "TRUE"]) {
    const settings = await withAgentEnv(value, getSettings)
    assert.deepEqual(settings.featureAvailability, { dealAgent: { available: false } }, `env=${String(value)}`)
    assert.equal(settings.featureFlags.dealAgent, true, "the stored per-company setting is still reported")
  }
})

test("settings API marks the Deal Agent setting available when MCA_DEAL_AGENT_ENABLED is true", async () => {
  await seedWorkspace({})
  const settings = await withAgentEnv("true", getSettings)
  assert.deepEqual(settings.featureAvailability, { dealAgent: { available: true } })
  assert.equal(settings.featureFlags.dealAgent, false)
})

test("settings PATCH keeps the stored dealAgent flag, ignores client-sent availability, and recomputes it", async () => {
  const workspaceId = await seedWorkspace({ dealAgent: true })
  const { PATCH } = await import("../src/app/api/workspace/route")
  const patch = (body: unknown) => PATCH(new Request("http://localhost/api/workspace", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }))
  // Flag off: the page sends back the whole settings object, including a (forged) availability value.
  const current = await withAgentEnv(undefined, getSettings)
  const off = await withAgentEnv(undefined, async () => patch({ ...current, brokerageName: "Renamed brokerage", featureAvailability: { dealAgent: { available: true } } }))
  assert.equal(off.status, 200)
  const offBody = await off.json() as WorkspaceSettings
  assert.equal(offBody.brokerageName, "Renamed brokerage")
  assert.deepEqual(offBody.featureAvailability, { dealAgent: { available: false } })
  assert.equal(offBody.featureFlags.dealAgent, true)
  assert.equal((await storedFlags(workspaceId)).dealAgent, true)
  assert.equal("featureAvailability" in (await storedFlags(workspaceId)), false)
  // Flag on: the existing toggle behavior is unchanged.
  const on = await withAgentEnv("true", async () => patch({ featureFlags: { dealAgent: false } }))
  assert.equal(on.status, 200)
  const onBody = await on.json() as WorkspaceSettings
  assert.deepEqual(onBody.featureAvailability, { dealAgent: { available: true } })
  assert.equal(onBody.featureFlags.dealAgent, false)
  assert.equal((await storedFlags(workspaceId)).dealAgent, false)
})

function renderSettingsPage(available: boolean): { markup: string; patchBody: Record<string, unknown> | null } {
  const settings = {
    workspaceId: "ws-render", brokerageName: "Render Brokerage", logoUrl: null, timezone: "America/New_York", seatLimit: 5, seatLimitManaged: false,
    featureFlags: { reports: true, payments: true, integrations: true, dealAgent: true },
    featureAvailability: { dealAgent: { available } },
    pageVisibility: { dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true },
    actionVisibility: { createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true },
    require2fa: false, updatedAt: "2026-10-02T00:00:00.000Z",
  }
  return runClient(`${interactionSetup}
    dispatcher.useCallback = (callback) => callback;
    const settings = ${JSON.stringify(settings)};
    response = async (path) => path === "/api/workspace" ? settings : { permissions: { canManageWorkspace: true } };
    const { default: WorkspaceSettingsPage } = require("./src/app/(dashboard)/settings/page.tsx");
    (async () => {
      render(WorkspaceSettingsPage);
      for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
      const view = render(WorkspaceSettingsPage);
      await submit(view.tree);
      const patch = calls.find(call => call.input);
      console.log(JSON.stringify({ markup: view.markup, patchBody: patch ? patch.input : null }));
    })().catch(error => { console.error(error); process.exitCode = 1 });
  `)
}

test("Settings page hides the Deal Agent switch when the setting is unavailable", () => {
  const { markup, patchBody } = renderSettingsPage(false)
  assert.match(markup, /aria-label="Reports visibility"/, "the Features card rendered")
  assert.doesNotMatch(markup, /aria-label="Deal Agent visibility"/)
  assert.doesNotMatch(markup, />Deal Agent</)
  // Hiding the switch does not drop or change the stored per-company value on save.
  assert.equal((patchBody?.featureFlags as Record<string, boolean>)?.dealAgent, true)
})

test("Settings page shows the Deal Agent switch when the setting is available", () => {
  const { markup } = renderSettingsPage(true)
  assert.match(markup, /aria-label="Reports visibility"/)
  assert.match(markup, /aria-label="Deal Agent visibility"/)
  assert.match(markup, /Proposes document requests, lender matches and submission drafts for broker approval/)
})
