import assert from "node:assert/strict"
import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import test from "node:test"
import pg from "pg"

import {
  assertLocalProofGuards,
  assertProofGuards,
  runLocalJobRuntimeProof,
  runJobRuntimeProof,
  sanitizeEvidence,
  syntheticEicarFile,
  type JobRuntimeProofRunner,
  type ProofClaim,
} from "../scripts/ops/job-runtime-proof"
import { postgresConnection } from "../src/lib/mca/db-connection"

const baseEnv = {
  MCA_OPS_JOB_PROOF_ENABLED: "true",
  MCA_OPS_PROOF_DATABASE_URL: "postgresql://proof.invalid/staging",
  MCA_OPS_PROOF_SUPABASE_URL: "https://staging-ref.supabase.co",
  MCA_OPS_PROOF_SUPABASE_SECRET_KEY: "test-only",
  MCA_OPS_PROOF_WORKSPACE_ID: "workspace-proof",
}

test("proof guards require the exact flag and explicit confirmation", () => {
  assert.throws(() => assertProofGuards({ env: { ...baseEnv, MCA_OPS_JOB_PROOF_ENABLED: "TRUE" }, argv: ["--confirm"] }), /MCA_OPS_JOB_PROOF_ENABLED=true/)
  assert.throws(() => assertProofGuards({ env: baseEnv, argv: [] }), /--confirm/)
  assert.doesNotThrow(() => assertProofGuards({ env: baseEnv, argv: ["--confirm"] }))
})

test("proof guard refuses the production project ref in every proof target value", () => {
  for (const name of Object.keys(baseEnv).filter(name => name.startsWith("MCA_OPS_PROOF_"))) {
    assert.throws(() => assertProofGuards({ env: { ...baseEnv, [name]: `prefix-drubsfvhlggmtyiigwxy-suffix` }, argv: ["--confirm"] }), /production Supabase project/)
  }
})

test("offline proof guards require the exact flag, acknowledgements, and loopback Postgres", () => {
  const localEnv = { MCA_OPS_JOB_PROOF_LOCAL_ENABLED: "true", MCA_TEST_DATABASE_ADMIN_URL: "postgresql://postgres@127.0.0.1:5432/postgres" }
  for (const value of [undefined, "false", "TRUE"]) {
    assert.throws(() => assertLocalProofGuards({ env: { ...localEnv, MCA_OPS_JOB_PROOF_LOCAL_ENABLED: value }, argv: ["--local", "--confirm"] }), /MCA_OPS_JOB_PROOF_LOCAL_ENABLED=true/)
  }
  assert.throws(() => assertLocalProofGuards({ env: localEnv, argv: ["--confirm"] }), /--local/)
  assert.throws(() => assertLocalProofGuards({ env: localEnv, argv: ["--local"] }), /--confirm/)
  assert.throws(() => assertLocalProofGuards({ env: { ...localEnv, MCA_TEST_DATABASE_ADMIN_URL: undefined }, argv: ["--local", "--confirm"] }), /loopback PostgreSQL/)
  assert.throws(() => assertLocalProofGuards({ env: { ...localEnv, MCA_TEST_DATABASE_ADMIN_URL: "postgresql://postgres@db.example.com/postgres", MCA_TEST_DATABASE_DISPOSABLE: "true" }, argv: ["--local", "--confirm"] }), /loopback PostgreSQL/)
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.doesNotThrow(() => assertLocalProofGuards({ env: { ...localEnv, MCA_TEST_DATABASE_ADMIN_URL: `postgresql://postgres@${host}:5432/postgres` }, argv: ["--local", "--confirm"] }))
  }
})

test("proof reclaims the same job, scans 25 MiB, and refuses EICAR with injected I/O", async () => {
  let sequence = 0
  const claims = new Map<string, number>()
  const payloads = new Map<string, { bytes: Uint8Array; filename: string }>()
  const claim = (jobId: string): ProofClaim => {
    const attempts = (claims.get(jobId) ?? 0) + 1
    claims.set(jobId, attempts)
    return { jobId, attempts, claimedAt: `2026-09-29T00:0${attempts}:00.000Z`, leaseExpiresAt: `2026-09-29T00:0${attempts + 1}:00.000Z` }
  }
  const runner: JobRuntimeProofRunner = {
    async enqueuePrivateScan(input) { const jobId = `job-${++sequence}`; payloads.set(jobId, input); return { jobId } },
    async claim(jobId) { return claim(jobId) },
    async reclaim(jobId) { return claim(jobId) },
    async waitUntil() {},
    async scanClaim(value) {
      const payload = payloads.get(value.jobId)!
      return { outcome: payload.filename.includes("eicar") ? "infected" : "clean", durationMs: 12 }
    },
  }
  const evidence = await runJobRuntimeProof(runner, "staging-ref")
  assert.equal(evidence.clean.bytes, 25 * 1024 * 1024)
  assert.equal(evidence.clean.jobId, evidence.clean.reclaimedClaim.jobId)
  assert.equal(evidence.clean.reclaimedClaim.attempts, 2)
  assert.equal(evidence.malware.refused, true)
})

test("sanitized evidence emits only the allowlisted report fields", () => {
  const claim = { jobId: "job-1", attempts: 2, claimedAt: "2026-09-29T00:00:00Z", leaseExpiresAt: "2026-09-29T00:10:00Z", secret: "do-not-print" }
  const evidence = sanitizeEvidence({
    targetProjectRef: "stage.ref/?token=secret",
    clean: { jobId: "job-1", bytes: 1, firstClaim: claim, reclaimedClaim: claim, scan: { outcome: "clean", durationMs: 1 } },
    malware: { jobId: "job-2", bytes: 2, claim, scan: { outcome: "infected", durationMs: 2 }, refused: true },
    databaseUrl: "postgresql://secret" ,
  } as never)
  const serialized = JSON.stringify(evidence)
  assert.equal(serialized.includes("do-not-print"), false)
  assert.equal(serialized.includes("postgresql://"), false)
  assert.equal(evidence.targetProjectRef, "stagereftokensecret")
})

test("offline proof uses disposable Postgres and filesystem while preserving the evidence contract", { skip: !process.env.MCA_TEST_DATABASE_ADMIN_URL }, async () => {
  const adminUrl = process.env.MCA_TEST_DATABASE_ADMIN_URL!
  const admin = new pg.Client(postgresConnection(adminUrl))
  const proofDatabases = async () => {
    await admin.connect()
    const result = await admin.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE 'fundlane_test_job_runtime_proof_%' ORDER BY datname")
    return result.rows.map(row => row.datname)
  }
  const proofDirectories = async () => (await readdir(tmpdir())).filter(name => name.startsWith("fundlane-job-runtime-proof-")).sort()
  const databasesBefore = await proofDatabases()
  const directoriesBefore = await proofDirectories()
  let evidence
  try {
    evidence = await runLocalJobRuntimeProof()
  } finally {
    await admin.end()
  }

  assert.equal(evidence.targetProjectRef, "local-loopback")
  assert.equal(evidence.clean.jobId, evidence.clean.firstClaim.jobId)
  assert.equal(evidence.clean.jobId, evidence.clean.reclaimedClaim.jobId)
  assert.equal(evidence.clean.firstClaim.attempts, 1)
  assert.equal(evidence.clean.reclaimedClaim.attempts, 2)
  assert.equal(evidence.clean.bytes, 25 * 1024 * 1024)
  assert.equal(evidence.clean.scan.outcome, "clean")
  assert.equal(evidence.malware.bytes, syntheticEicarFile().byteLength)
  assert.equal(evidence.malware.scan.outcome, "infected")
  assert.equal(evidence.malware.refused, true)

  const shape = (value: unknown): unknown => Array.isArray(value) ? value.map(shape) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, shape(nested)]))
    : typeof value
  const hostedContract = sanitizeEvidence({
    targetProjectRef: "hosted",
    clean: { jobId: "one", bytes: 1, firstClaim: evidence.clean.firstClaim, reclaimedClaim: evidence.clean.reclaimedClaim, scan: { outcome: "clean", durationMs: 1 } },
    malware: { jobId: "two", bytes: 2, claim: evidence.malware.claim, scan: { outcome: "infected", durationMs: 1 }, refused: true },
  })
  assert.deepEqual(shape(evidence), shape(hostedContract))
  const serialized = JSON.stringify(evidence)
  for (const forbidden of [adminUrl, tmpdir(), "synthetic-25mib.pdf", "eicar.com.txt", Buffer.from(syntheticEicarFile()).toString("ascii"), "password", "credential"]) {
    assert.equal(serialized.includes(forbidden), false, `evidence must omit ${forbidden}`)
  }

  const verificationAdmin = new pg.Client(postgresConnection(adminUrl))
  await verificationAdmin.connect()
  try {
    const databasesAfter = (await verificationAdmin.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE 'fundlane_test_job_runtime_proof_%' ORDER BY datname")).rows.map(row => row.datname)
    assert.deepEqual(databasesAfter, databasesBefore)
  } finally {
    await verificationAdmin.end()
  }
  assert.deepEqual(await proofDirectories(), directoriesBefore)
})
