import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import pg from "pg"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import {
  assertPilotEvidenceGuards,
  buildPilotEvidenceMatrix,
  collectPilotEvidence,
  sanitizePilotEvidence,
  type ReadOnlyQueryExecutor,
} from "../scripts/ops/funder-pilot-evidence"

const localEnv = {
  MCA_FUNDER_PILOT_EVIDENCE_ENABLED: "true",
  MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL: "postgresql://pilot:pilot@127.0.0.1:5432/pilot",
  MCA_FUNDER_PILOT_EVIDENCE_WORKSPACE_ID: "workspace-pilot",
}

const job = {
  workspace_id: "workspace-pilot",
  deal_id: "deal-pilot",
  job_id: "job-pilot",
  funder_id: "funder-pilot",
  route_kind: "email",
  job_state: "sent",
  created_at: "2026-09-29T10:00:00.000Z",
  preflight_ready: true,
  explicitly_approved: true,
  sandbox_adapter: false,
}

const attempt = {
  attempt_id: "attempt-pilot",
  attempt_state: "sent",
  correlation_id: "correlation-pilot",
  external_ref: "receipt-pilot",
  error_code: null,
  created_at: "2026-09-29T10:01:00.000Z",
  sent_at: "2026-09-29T10:02:00.000Z",
  reconciled: false,
  reconciled_at: null,
}

const reply = {
  reply_id: "reply-pilot",
  provider_message_id: "provider-message-pilot",
  reply_state: "matched",
  matched_deal_id: "deal-pilot",
  matched_job_id: "job-pilot",
  created_at: "2026-09-29T11:00:00.000Z",
  updated_at: "2026-09-29T11:05:00.000Z",
  checkpoint_at: "2026-09-29T11:06:00.000Z",
}

const activity = {
  activity_id: "activity-pilot",
  action: "reply_reviewed",
  source: "user",
  from_status: "Submitted",
  to_status: "Underwriting",
  created_at: "2026-09-29T11:07:00.000Z",
}

class FakeExecutor implements ReadOnlyQueryExecutor {
  calls: Array<{ text: string; values: readonly unknown[] }> = []
  constructor(private readonly results: Record<string, unknown>[][]) {}
  async query<T extends object>(text: string, values: readonly unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ text, values })
    return { rows: (this.results.shift() ?? []) as T[] }
  }
}

test("the evidence flag is strict and guards run without querying", () => {
  for (const value of [undefined, "false", "TRUE", "1"]) {
    assert.throws(
      () => assertPilotEvidenceGuards({ env: { ...localEnv, MCA_FUNDER_PILOT_EVIDENCE_ENABLED: value }, argv: ["--job-id", "job-pilot"] }),
      /Set MCA_FUNDER_PILOT_EVIDENCE_ENABLED=true/,
    )
  }
  assert.equal(assertPilotEvidenceGuards({ env: localEnv, argv: ["--job-id", "job-pilot"] }).jobId, "job-pilot")
  assert.equal(assertPilotEvidenceGuards({ env: localEnv, argv: ["--", "--job-id", "job-pilot"] }).jobId, "job-pilot")
})

test("guards reject incomplete, production, remote, and ambiguous targets", () => {
  assert.throws(() => assertPilotEvidenceGuards({ env: { ...localEnv, MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL: "" }, argv: ["--job-id", "job"] }), /Missing MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL/)
  assert.throws(() => assertPilotEvidenceGuards({ env: { ...localEnv, MCA_FUNDER_PILOT_EVIDENCE_WORKSPACE_ID: "" }, argv: ["--job-id", "job"] }), /Missing MCA_FUNDER_PILOT_EVIDENCE_WORKSPACE_ID/)
  for (const argv of [[], ["--job-id"], ["--job-id", "a", "--job-id", "b"], ["--unknown", "job"]]) {
    assert.throws(() => assertPilotEvidenceGuards({ env: localEnv, argv }), /Pass exactly one --job-id/)
  }
  assert.throws(() => assertPilotEvidenceGuards({ env: { ...localEnv, MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL: "postgresql://x@drubsfvhlggmtyiigwxy.supabase.co/db" }, argv: ["--job-id", "job"] }), /production Supabase project/)
  assert.throws(() => assertPilotEvidenceGuards({ env: { ...localEnv, MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL: "postgresql://x@disposable.example/db" }, argv: ["--job-id", "job"] }), /loopback PostgreSQL/)
  assert.equal(assertPilotEvidenceGuards({ env: { ...localEnv, MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL: "postgresql://x@disposable.example/db", MCA_FUNDER_PILOT_EVIDENCE_DATABASE_DISPOSABLE: "true" }, argv: ["--job-id", "job"] }).jobId, "job")
})

test("collection uses only parameterized workspace-and-job SELECTs and fails closed", async () => {
  const executor = new FakeExecutor([[job], [attempt], [reply], [activity]])
  const collected = await collectPilotEvidence(executor, { workspaceId: "workspace-pilot", jobId: "job-pilot" })
  assert.equal(collected.reply?.reply_id, "reply-pilot")
  assert.equal(executor.calls.length, 4)
  for (const call of executor.calls) {
    assert.match(call.text.trim(), /^SELECT/)
    assert.match(call.text, /j\.workspace_id = \$1 AND j\.id = \$2/)
    assert.deepEqual(call.values, ["workspace-pilot", "job-pilot"])
    assert.doesNotMatch(call.text, /package_json(?!(::jsonb))|route_json|body_cipher|from_address|subject|credential_cipher|display_funder_name/)
  }
  const missing = new FakeExecutor([[]])
  await assert.rejects(collectPilotEvidence(missing, { workspaceId: "wrong-workspace", jobId: "job-pilot" }), /not found in the selected workspace/)
  assert.equal(missing.calls.length, 1)
})

test("collector queries the migrated PostgreSQL schema in a read-only transaction", async () => {
  const database = await createPostgresTestDatabase("pilot_evidence")
  const client = new pg.Client({ connectionString: database.databaseUrl })
  const now = "2026-09-29T10:00:00.000Z"
  const workspaceId = "pilot-workspace"
  const dealId = "pilot-deal"
  const funderId = "pilot-funder"
  const runId = "pilot-run"
  try {
    await database.query(`INSERT INTO workspaces
      (id,name,feature_flags,page_visibility,created_at,updated_at)
      VALUES ($1,'Synthetic Pilot','{}','{}',$2,$2)`, [workspaceId, now])
    await database.query(`INSERT INTO deals
      (id,workspace_id,display_id,status,draft_state,missing_required_json,field_sources_json,created_at,updated_at)
      VALUES ($1,$2,'PILOT-1','submitted','submission_ready','[]','{}',$3,$3)`, [dealId, workspaceId, now])
    await database.query(`INSERT INTO mca_funders
      (id,workspace_id,idempotency_key,legal_name,routes,created_at,updated_at)
      VALUES ($1,$2,'pilot-funder-key','Synthetic Funder','[]',$3,$3)`, [funderId, workspaceId, now])
    await database.query(`INSERT INTO mca_email_senders
      (id,workspace_id,provider,purpose,from_name,from_address,state,created_at,updated_at)
      VALUES ('pilot-sender',$1,'smtp','submission','Synthetic Sender','sender@example.test','verified',$2,$2)`, [workspaceId, now])
    await database.query(`INSERT INTO mca_review_approvals
      (id,workspace_id,deal_id,run_id,snapshot_id,selected_funder_ids,created_at)
      VALUES ('pilot-approval',$1,$2,$3,'pilot-snapshot',$4,$5)`, [workspaceId, dealId, runId, JSON.stringify([funderId]), now])
    for (const [jobId, suffix] of [["pilot-job-with-reply", "one"], ["pilot-job-without-reply", "two"]]) {
      await database.query(`INSERT INTO mca_submission_jobs
        (id,workspace_id,deal_id,funder_id,display_funder_name,route_kind,route_json,state,
         confirmation_key,attempt_key,analysis_run_id,deal_version,document_versions_json,
         package_json,preflight_errors_json,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'Synthetic Funder','email','{}','sent',$5,$6,$7,1,'[]','{}','[]',$8,$8)`,
      [jobId, workspaceId, dealId, funderId, `confirm-${suffix}`, `attempt-${suffix}`, runId, now])
      await database.query(`INSERT INTO mca_submission_attempts
        (id,workspace_id,job_id,attempt_key,transport,state,correlation_id,external_ref,created_at,sent_at)
        VALUES ($1,$2,$3,$4,'email','sent',$5,$6,$7,$7)`,
      [`attempt-row-${suffix}`, workspaceId, jobId, `attempt-${suffix}`, `correlation-${suffix}`,
        JSON.stringify({ messageId: `receipt-${suffix}` }), now])
    }
    await database.query(`INSERT INTO mca_funder_replies
      (id,workspace_id,sender_id,provider_message_id,from_address,matched_deal_id,matched_job_id,
       match_evidence,state,created_at,updated_at)
      VALUES ('pilot-reply',$1,'pilot-sender','provider-message-pilot','funder@example.test',$2,
        'pilot-job-with-reply','{}','matched',$3,$3)`, [workspaceId, dealId, now])
    await database.query(`INSERT INTO deal_activity
      (id,workspace_id,deal_id,action,source,summary,record_version,correlation_id,created_at)
      VALUES ('pilot-activity',$1,$2,'reply_reviewed','user','Synthetic review',1,'activity-correlation',$3)`,
    [workspaceId, dealId, now])

    await client.connect()
    await client.query("BEGIN READ ONLY")
    const withReply = sanitizePilotEvidence(buildPilotEvidenceMatrix(
      await collectPilotEvidence(client, { workspaceId, jobId: "pilot-job-with-reply" }),
    ))
    assert.deepEqual(withReply.rows.map(row => row.status),
      ["present", "present", "present", "present", "not_applicable", "present", "present", "present"])
    assert.equal(withReply.rows[3]?.references.externalReference, "receipt-one")
    assert.equal(withReply.rows[5]?.references.providerMessageId, "provider-message-pilot")
    const withoutReply = sanitizePilotEvidence(buildPilotEvidenceMatrix(
      await collectPilotEvidence(client, { workspaceId, jobId: "pilot-job-without-reply" }),
    ))
    assert.deepEqual(withoutReply.rows.map(row => row.status),
      ["present", "present", "present", "present", "not_applicable", "missing", "missing", "present"])
    const cliMatrix = JSON.parse(execFileSync(process.execPath,
      ["--conditions=react-server", "--import", "tsx", "scripts/ops/funder-pilot-evidence.ts", "--job-id", "pilot-job-with-reply"],
      { cwd: process.cwd(), encoding: "utf8", env: {
        ...process.env,
        MCA_FUNDER_PILOT_EVIDENCE_ENABLED: "true",
        MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL: database.databaseUrl,
        MCA_FUNDER_PILOT_EVIDENCE_WORKSPACE_ID: workspaceId,
      } },
    )) as ReturnType<typeof buildPilotEvidenceMatrix>
    assert.deepEqual(cliMatrix, withReply)
    await client.query("COMMIT")
  } finally {
    await client.query("ROLLBACK").catch(() => undefined)
    await client.end().catch(() => undefined)
    await database.close()
  }
})

test("complete email-first evidence is deterministic, complete, and never live verified", async () => {
  const executor = new FakeExecutor([[job], [attempt], [reply, { ...reply, reply_id: "older-replay" }], [activity]])
  const evidence = await collectPilotEvidence(executor, { workspaceId: "workspace-pilot", jobId: "job-pilot" })
  const matrix = sanitizePilotEvidence(buildPilotEvidenceMatrix(evidence))
  assert.equal(matrix.providerReadiness, "untested")
  assert.equal(matrix.disclaimer, "Offline synthetic evidence is not live provider acceptance.")
  assert.equal(matrix.rows.length, 8)
  assert.deepEqual(matrix.rows.map(row => row.status), ["present", "present", "present", "present", "not_applicable", "present", "present", "present"])
  assert.equal(matrix.rows[5]?.references.replyId, "reply-pilot")
  assert.equal(JSON.stringify(matrix), JSON.stringify(sanitizePilotEvidence(buildPilotEvidenceMatrix(evidence))))

  const sandbox = buildPilotEvidenceMatrix({ ...evidence, job: { ...job, route_kind: "api", sandbox_adapter: true } })
  assert.equal(sandbox.providerReadiness, "sandbox verified")
})

test("an ambiguous send without reconciliation remains missing, not not-sent", () => {
  const matrix = buildPilotEvidenceMatrix({
    job: { ...job, job_state: "failed" },
    attempt: { ...attempt, attempt_state: "failed", external_ref: null, error_code: "delivery_uncertain", reconciled: false },
  })
  const receipt = matrix.rows.find(row => row.label === "Relay or provider receipt")
  const reconciliation = matrix.rows.find(row => row.label === "Unknown outcome reconciliation")
  assert.equal(receipt?.status, "missing")
  assert.equal(reconciliation?.status, "missing")
  assert.match(reconciliation?.note ?? "", /must not be treated as not sent/)
})

test("sanitizer emits only bounded opaque evidence and excludes seeded canaries", () => {
  const canaries = ["canary@example.test", "SECRET BODY", "token-canary", "credential-canary", "route-canary", "package-canary", "postgresql://database-canary", "Merchant Canary", "document-canary.pdf"]
  const matrix = buildPilotEvidenceMatrix({ job, attempt, reply, activity }) as ReturnType<typeof buildPilotEvidenceMatrix> & Record<string, unknown>
  matrix.unsafe = canaries.join(" ")
  matrix.rows[0]!.references = {
    ...matrix.rows[0]!.references,
    unknown: canaries.join(" "),
    jobId: `${"a".repeat(140)}\u0000SECRET BODY`,
  }
  const output = JSON.stringify(sanitizePilotEvidence(matrix))
  for (const canary of canaries) assert.doesNotMatch(output, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.equal(sanitizePilotEvidence(matrix).rows[0]?.references.jobId.length, 128)
  assert.match(output, /correlation-pilot/)
  assert.match(output, /provider-message-pilot/)
  assert.match(output, /2026-09-29T11:06:00.000Z/)
})
