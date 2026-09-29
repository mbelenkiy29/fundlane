import assert from "node:assert/strict"
import test from "node:test"

import {
  assertProofGuards,
  runJobRuntimeProof,
  sanitizeEvidence,
  type JobRuntimeProofRunner,
  type ProofClaim,
} from "../scripts/ops/job-runtime-proof"

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
