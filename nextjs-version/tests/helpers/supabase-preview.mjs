// Isolated browser-verification server. Never uses the application database.
import { spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { createSupabaseHttpFixture } from "./supabase-http.mjs"
import { hashPassword } from "../../src/lib/mca/crypto.ts"
import { createPostgresTestDatabase } from "./postgres-test-db.mjs"
const db = await createPostgresTestDatabase("supabase_preview")
const fixture = await createSupabaseHttpFixture(db)
const previewPassword = randomBytes(24).toString("base64url")
let user, organization, server, cleaning
async function cleanup() {
  if (cleaning) return cleaning
  cleaning = cleanResources()
  return cleaning
}
async function cleanResources() {
  if (server) server.kill("SIGTERM")
  await fixture.close()
  await db.close()
}
try {
  const email = `mca-preview-${Date.now()}@example.test`
  user = { id: randomUUID() }
  organization = { id: null, name: "MCA verification company" }
  const workspaceId = randomUUID(),
    userId = user.id,
    memberId = randomUUID(),
    now = new Date().toISOString()
  await db.query(
    `INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,clerk_organization_id,created_at,updated_at) VALUES ($1,$2,'America/New_York',5,$3,$4,$5,$6,$7,$7)`,
    [
      workspaceId,
      organization.name,
      JSON.stringify({ reports: true, payments: false, integrations: true }),
      JSON.stringify({
        dashboard: true,
        deals: true,
        users: true,
        reports: true,
        payments: true,
        workspace: true,
        integrations: true,
      }),
      JSON.stringify({
        createDeal: true,
        exportDeals: true,
        inviteUsers: true,
        manageApiKeys: true,
        viewPaymentTable: true,
        viewCompanyFinancials: true,
      }),
      organization.id,
      now,
    ]
  )
  await db.query(
    "INSERT INTO company_subscription_state (workspace_id,legacy_exempt,state_kind,selected_seats,updated_at) VALUES ($1,1,'synthetic',5,$2)",
    [workspaceId, now]
  )
  await db.query(
    "INSERT INTO users (id,email,name,application_identifier,supabase_user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [userId, email, "Preview Owner", `MCA-${userId}`, user.id, now]
  )
  await db.query(
    "INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'admin','active',$4,$4)",
    [memberId, workspaceId, userId, now]
  )
  if (process.env.MCA_TEAM_PREVIEW === "true") {
    await db.query("UPDATE workspaces SET seat_limit=8 WHERE id=$1", [
      workspaceId,
    ])
    for (const [name, role, status, delivery, days] of [
      ["Alex Rivera", "manager", "active", null, 3],
      ["Morgan Chen", "rep", "active", null, 3],
      ["Sam Patel", "rep", "pending", "sent", 3],
      ["Jordan Lee", "rep", "pending", "sent", -1],
      ["Taylor Brooks", "rep", "pending", "failed", 3],
      ["Casey Wells", "rep", "deactivated", null, 3],
    ]) {
      const uid = randomUUID(),
        mid = randomUUID(),
        mail = `${name.toLowerCase().replaceAll(" ", ".")}@example.test`
      await db.query(
        "INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)",
        [uid, mail, name, `MCA-${uid.slice(0, 8)}`, now]
      )
      await db.query(
        "INSERT INTO memberships (id,workspace_id,user_id,role,status,manager_membership_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)",
        [mid, workspaceId, uid, role, status, memberId, now]
      )
      if (status === "pending")
        await db.query(
          "INSERT INTO invitations (id,workspace_id,membership_id,email,token_hash,expires_at,status,delivery_status,delivery_correlation_id,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$10)",
          [
            randomUUID(),
            workspaceId,
            mid,
            mail,
            randomUUID(),
            new Date(Date.now() + days * 86400000).toISOString(),
            delivery,
            randomUUID(),
            userId,
            now,
          ]
        )
    }
  }
  if (process.env.MCA_SUBMISSIONS_PREVIEW === "true") {
    const funderId = randomUUID()
    await db.query(
      "INSERT INTO mca_funders (id,workspace_id,idempotency_key,legal_name,created_at,updated_at) VALUES ($1,$2,$1,'Preview Capital',$3,$3)",
      [funderId, workspaceId, now]
    )
    for (let i = 0; i < 28; i++) {
      const dealId = randomUUID(),
        jobId = randomUUID(),
        timestamp = new Date(Date.now() - i * 3600000).toISOString()
      const state = [
        "sent",
        "failed",
        "queued",
        "preflight_failed",
        "pending_portal",
        "blocked_duplicate",
      ][i % 6]
      await db.query(
        "INSERT INTO deals (id,workspace_id,display_id,legal_name,status,draft_state,missing_required_json,field_sources_json,created_at,updated_at) VALUES ($1,$2,$3,$4,'new_application','partial','[]','{}',$5,$5)",
        [
          dealId,
          workspaceId,
          `MCA-${1000 + i}`,
          ["Harbor Coffee", "Greenwood Auto", "Bright Dental", "Summit Bakery"][
            i % 4
          ] + ` ${i + 1}`,
          timestamp,
        ]
      )
      await db.query(
        "INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at) VALUES ($1,$2,$3,$4,'originator',1,$5)",
        [randomUUID(), workspaceId, dealId, memberId, timestamp]
      )
      if (i === 27) {
        await db.query(
          "INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status) VALUES ($1,$2,$3,'Legacy Capital','sent')",
          [randomUUID(), workspaceId, dealId]
        )
      } else {
        await db.query(
          "INSERT INTO mca_submission_jobs (id,workspace_id,deal_id,funder_id,display_funder_name,route_kind,route_json,state,confirmation_key,attempt_key,deal_version,document_versions_json,package_json,preflight_errors_json,created_at,updated_at) VALUES ($1,$2,$3,$4,'Preview Capital','email','{}',$5,$1,$1,1,'[]','[]','[]',$6,$6)",
          [jobId, workspaceId, dealId, funderId, state, timestamp]
        )
        await db.query(
          "INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status,funder_id,job_id,route_kind) VALUES ($1,$2,$3,'Preview Capital',$4,$5,$6,'email')",
          [
            randomUUID(),
            workspaceId,
            dealId,
            i % 6 === 0 ? "approved" : "queued",
            funderId,
            jobId,
          ]
        )
        if (["sent", "failed"].includes(state))
          await db.query(
            "INSERT INTO mca_submission_attempts (id,workspace_id,job_id,attempt_key,transport,state,correlation_id,created_at) VALUES ($1,$2,$3,$1,'email',$4,$1,$5)",
            [randomUUID(), workspaceId, jobId, state, timestamp]
          )
      }
    }
  }
  if (process.env.MCA_MARKETING_PREVIEW === "true") {
    const { seedMarketingPreview } = await import("../../scripts/marketing/seed-preview.mjs")
    await seedMarketingPreview(db, { workspaceId, memberId, userId })
  }
  await db.query("UPDATE users SET password_hash=$1 WHERE id=$2",[hashPassword(previewPassword),userId])
  await fixture.login(email,previewPassword)
  console.log(`Synthetic preview account: ${email}. Password: ${previewPassword}. URL: http://localhost:3010/sign-in`)
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--port", "3010"],
    {
      env: db.env({
        ...fixture.env,
        NODE_ENV: "development",
        NEXT_DIST_DIR: ".next-supabase-preview",
        MCA_APP_ORIGIN: "http://localhost:3010",
        MCA_DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
      }),
      stdio: "inherit",
    }
  )
  process.once("SIGTERM", async () => {
    await cleanup()
    process.exit(0)
  })
  process.once("SIGINT", async () => {
    await cleanup()
    process.exit(0)
  })
  await new Promise((resolve) => server.once("exit", resolve))
  await cleanup()
} catch {
  await cleanup()
  process.exitCode = 1
  console.error("Preview setup failed; no application data was changed.")
}
