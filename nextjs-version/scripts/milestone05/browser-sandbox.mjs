// Run with: node --conditions=react-server --import tsx scripts/milestone05/browser-sandbox.mjs
// Creates only disposable verification data. Stop with SIGINT/SIGTERM to clean up.
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPostgresTestDatabase } from "../../tests/helpers/postgres-test-db.mjs"
import { hashPassword } from "../../src/lib/mca/crypto.ts"

const port = Number(process.env.MCA_VERIFICATION_PORT ?? 5841)
const origin = `http://127.0.0.1:${port}`
const fixture = await createPostgresTestDatabase("milestone05_browser")
const storage = await mkdtemp(join(tmpdir(), "mca-milestone05-browser-"))
const dist = ".next-milestone05-browser"
let server
let closing = false
async function cleanup() {
  if (closing) return
  closing = true
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3000))])
    if (server.exitCode === null) server.kill("SIGKILL")
  }
  await fixture.close()
  await rm(storage, { recursive: true, force: true })
  await rm(dist, { recursive: true, force: true })
  console.log("Browser verification database and local artifacts removed.")
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void cleanup().then(() => process.exit(0)) })

try {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: fixture.env({
      NODE_ENV: "development", NEXT_DIST_DIR: dist, MCA_APP_ORIGIN: origin,
      MCA_DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"), MCA_DOCUMENT_STORAGE_PATH: storage,
      MCA_BOOTSTRAP_WORKSPACE_NAME: "Milestone 5 Verification", MCA_BOOTSTRAP_ADMIN_EMAIL: "milestone5@example.test",
      MCA_BOOTSTRAP_ADMIN_PASSWORD: "Synthetic Verification 5!",
      MCA_EMAIL_WEBHOOK_URL: "", MCA_MERCHANT_EMAIL_WEBHOOK_URL: "", MCA_MERCHANT_SMS_WEBHOOK_URL: "", MCA_CLOSING_EMAIL_WEBHOOK_URL: "",
    }), stdio: ["ignore", "inherit", "inherit"],
  })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error("Verification server exited during startup.")
    try { await fetch(`${origin}/api/auth/session`); ready = true; break } catch { await new Promise((resolve) => setTimeout(resolve, 300)) }
  }
  if (!ready) throw new Error("Verification server did not become ready.")
  const login = await fetch(`${origin}/api/auth/sign-in`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email: "milestone5@example.test", password: "Synthetic Verification 5!" }) })
  if (!login.ok) throw new Error(`Synthetic sign-in failed: ${login.status}`)
  const cookie = login.headers.get("set-cookie")?.split(";")[0]
  const session = await login.json()
  await fixture.query("UPDATE workspaces SET feature_flags = $1 WHERE id = $2", [JSON.stringify({ reports: true, payments: true, integrations: true }), session.membership.workspaceId])
  const timestamp = new Date().toISOString()
  await fixture.query(`INSERT INTO users (id,email,password_hash,name,application_identifier,created_at,updated_at)
    VALUES ('milestone05-rep-user','rep-milestone5@example.test',$1,'Verification Representative','M5-REP',$2,$2)`, [hashPassword("Synthetic Verification 5!"), timestamp])
  await fixture.query(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at)
    VALUES ('milestone05-rep-member',$1,'milestone05-rep-user','rep','active',$2,$2)`, [session.membership.workspaceId, timestamp])
  for (const [key, name] of [["harbor", "Harbor Coffee LLC"], ["cedar", "Cedar Auto Repair LLC"]]) {
    const created = await fetch(`${origin}/api/mca/deals`, { method: "POST", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify({
      idempotencyKey: `milestone05-${key}`, legalName: name, contactName: "Avery Morgan", contactEmail: `${key}@example.test`, contactPhone: "+12125550123", requestedAmount: 40000,
    }) })
    if (!created.ok) throw new Error(`Synthetic deal setup failed: ${created.status}`)
  }
  console.log(`Browser sandbox ready: ${origin}/sign-in (synthetic account milestone5@example.test).`)
  server.once("exit", () => { if (!closing) void cleanup().then(() => process.exit(1)) })
} catch (error) {
  await cleanup()
  throw error
}
