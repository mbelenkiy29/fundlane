import { pathToFileURL } from "node:url"

const PRODUCTION_PROJECT_REF = "drubsfvhlggmtyiigwxy"
const MAX_PRIVATE_FILE_BYTES = 25 * 1024 * 1024
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"

export interface ProofClaim {
  jobId: string
  attempts: number
  claimedAt: string
  leaseExpiresAt: string
}

export interface ProofScanResult {
  outcome: "clean" | "infected" | "error"
  durationMs: number
}

export interface JobRuntimeProofRunner {
  enqueuePrivateScan(input: { bytes: Uint8Array; filename: string }): Promise<{ jobId: string }>
  claim(jobId: string): Promise<ProofClaim>
  reclaim(jobId: string): Promise<ProofClaim>
  waitUntil(isoTimestamp: string): Promise<void>
  scanClaim(claim: ProofClaim): Promise<ProofScanResult>
}

export interface ProofEvidence {
  targetProjectRef: string
  clean: { jobId: string; bytes: number; firstClaim: ProofClaim; reclaimedClaim: ProofClaim; scan: ProofScanResult }
  malware: { jobId: string; bytes: number; claim: ProofClaim; scan: ProofScanResult; refused: boolean }
}

export function assertProofGuards(input: { env: Readonly<Record<string, string | undefined>>; argv: readonly string[] }): void {
  if (input.env.MCA_OPS_JOB_PROOF_ENABLED !== "true") throw new Error("Set MCA_OPS_JOB_PROOF_ENABLED=true to run the staging proof.")
  if (!input.argv.includes("--confirm")) throw new Error("Pass --confirm to acknowledge the staging-only proof.")
  const required = ["MCA_OPS_PROOF_DATABASE_URL", "MCA_OPS_PROOF_SUPABASE_URL", "MCA_OPS_PROOF_SUPABASE_SECRET_KEY", "MCA_OPS_PROOF_WORKSPACE_ID"] as const
  for (const name of required) if (!input.env[name]) throw new Error(`Missing ${name}.`)
  const target = Object.entries(input.env)
    .filter(([name]) => name.startsWith("MCA_OPS_PROOF_"))
    .map(([, value]) => value ?? "")
    .join("\n")
  if (target.toLowerCase().includes(PRODUCTION_PROJECT_REF)) throw new Error("Refusing to run against the production Supabase project.")
}

export function syntheticPrivateFile(): Uint8Array {
  const bytes = new Uint8Array(MAX_PRIVATE_FILE_BYTES)
  bytes.set(Buffer.from("%PDF-1.7\n% synthetic staging proof; contains no customer data\n"))
  return bytes
}

export function syntheticEicarFile(): Uint8Array { return Buffer.from(EICAR, "ascii") }

function safeIso(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error("The proof runner returned an invalid timestamp.")
  return new Date(timestamp).toISOString()
}

function safeClaim(claim: ProofClaim): ProofClaim {
  return { jobId: String(claim.jobId), attempts: Number(claim.attempts), claimedAt: safeIso(claim.claimedAt), leaseExpiresAt: safeIso(claim.leaseExpiresAt) }
}

export function sanitizeEvidence(evidence: ProofEvidence): ProofEvidence {
  return {
    targetProjectRef: evidence.targetProjectRef.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64),
    clean: { jobId: String(evidence.clean.jobId), bytes: Number(evidence.clean.bytes), firstClaim: safeClaim(evidence.clean.firstClaim), reclaimedClaim: safeClaim(evidence.clean.reclaimedClaim), scan: { outcome: evidence.clean.scan.outcome, durationMs: Number(evidence.clean.scan.durationMs) } },
    malware: { jobId: String(evidence.malware.jobId), bytes: Number(evidence.malware.bytes), claim: safeClaim(evidence.malware.claim), scan: { outcome: evidence.malware.scan.outcome, durationMs: Number(evidence.malware.scan.durationMs) }, refused: Boolean(evidence.malware.refused) },
  }
}

export async function runJobRuntimeProof(runner: JobRuntimeProofRunner, projectRef: string): Promise<ProofEvidence> {
  const cleanBytes = syntheticPrivateFile()
  const malwareBytes = syntheticEicarFile()
  const clean = await runner.enqueuePrivateScan({ bytes: cleanBytes, filename: "synthetic-25mib.pdf" })
  const firstClaim = await runner.claim(clean.jobId)
  // Deliberately do not heartbeat or finish this claim: this models a killed worker.
  await runner.waitUntil(firstClaim.leaseExpiresAt)
  const reclaimedClaim = await runner.reclaim(clean.jobId)
  if (reclaimedClaim.jobId !== clean.jobId || reclaimedClaim.attempts <= firstClaim.attempts) throw new Error("The killed claim was not reclaimed with the same job ID.")
  const cleanScan = await runner.scanClaim(reclaimedClaim)
  const malware = await runner.enqueuePrivateScan({ bytes: malwareBytes, filename: "eicar.com.txt" })
  const malwareClaim = await runner.claim(malware.jobId)
  const malwareScan = await runner.scanClaim(malwareClaim)
  if (cleanScan.outcome !== "clean") throw new Error("The 25 MiB synthetic file did not scan clean.")
  if (malwareScan.outcome !== "infected") throw new Error("The EICAR test file was not refused as malware.")
  return sanitizeEvidence({
    targetProjectRef: projectRef,
    clean: { jobId: clean.jobId, bytes: cleanBytes.byteLength, firstClaim, reclaimedClaim, scan: cleanScan },
    malware: { jobId: malware.jobId, bytes: malwareBytes.byteLength, claim: malwareClaim, scan: malwareScan, refused: true },
  })
}

async function createHostedRunner(env: NodeJS.ProcessEnv): Promise<JobRuntimeProofRunner> {
  process.env.DATABASE_URL = env.MCA_OPS_PROOF_DATABASE_URL
  process.env.SUPABASE_URL = env.MCA_OPS_PROOF_SUPABASE_URL
  process.env.SUPABASE_SECRET_KEY = env.MCA_OPS_PROOF_SUPABASE_SECRET_KEY
  process.env.MCA_DOCUMENT_STORAGE_PROVIDER = "supabase"
  const [{ enqueueBackgroundJob, claimBackgroundJob, completeBackgroundJob, failBackgroundJob }, { getDatabase, newId }, { quarantineBucket, storageClient }, { documentScanner }] = await Promise.all([
    import("../../src/lib/mca/jobs/queue"), import("../../src/lib/mca/db"), import("../../src/lib/mca/documents/storage"), import("../../src/lib/mca/documents/scanner"),
  ])
  const workspaceId = env.MCA_OPS_PROOF_WORKSPACE_ID!
  const objects = new Map<string, { key: string; filename: string }>()
  const actor = { workspaceId, userId: null, membershipId: null, role: "admin" as const, managedMembershipIds: [], activeMembershipIds: [], source: "system" as const, correlationId: newId() }
  async function claimExpected(jobId: string): Promise<ProofClaim> {
    const job = await claimBackgroundJob(["assistant_scan"])
    if (!job || job.id !== jobId) throw new Error("The staging queue claimed a different job; use an isolated proof workspace/queue.")
    const row = await getDatabase().prepare<{ lease_expires_at: string; updated_at: string }>("SELECT lease_expires_at,updated_at FROM mca_background_jobs WHERE id=?").get(job.id)
    if (!row) throw new Error("The claimed proof job disappeared.")
    return { jobId: job.id, attempts: job.attempts, claimedAt: row.updated_at, leaseExpiresAt: row.lease_expires_at }
  }
  return {
    async enqueuePrivateScan({ bytes, filename }) {
      const key = `${workspaceId}/scans/ops-proof-${newId()}`
      const uploaded = await storageClient().storage.from(quarantineBucket()).upload(key, bytes, { upsert: false, contentType: "application/octet-stream" })
      if (uploaded.error) throw new Error("The synthetic private file could not be uploaded.")
      const job = await enqueueBackgroundJob({ actor, kind: "assistant_scan", resourceId: key, idempotencyKey: `ops-proof:${key}`, payload: { filename } })
      objects.set(job.id, { key, filename })
      return { jobId: job.id }
    },
    claim: claimExpected,
    reclaim: claimExpected,
    async waitUntil(timestamp) {
      const remaining = Date.parse(timestamp) - Date.now() + 1_000
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
    },
    async scanClaim(claim) {
      const started = Date.now(), object = objects.get(claim.jobId)
      if (!object) throw new Error("Missing synthetic object metadata.")
      const row = await getDatabase().prepare<Record<string, unknown>>("SELECT * FROM mca_background_jobs WHERE id=? AND state='running'").get(claim.jobId)
      if (!row) throw new Error("The proof claim is no longer running.")
      const job = row as never
      try {
        const downloaded = await storageClient().storage.from(quarantineBucket()).download(object.key)
        if (downloaded.error || !downloaded.data) throw new Error("The synthetic private file could not be downloaded.")
        const result = await documentScanner().scan(new Uint8Array(await downloaded.data.arrayBuffer()), object.filename)
        if (result.status === "clean") await completeBackgroundJob(job, result)
        else await failBackgroundJob(job, new Error(result.status === "infected" ? "proof_malware_refused" : "proof_scan_error"))
        return { outcome: result.status === "unavailable" ? "error" : result.status, durationMs: Date.now() - started }
      } finally {
        await storageClient().storage.from(quarantineBucket()).remove([object.key])
      }
    },
  }
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  assertProofGuards({ env, argv })
  const projectRef = new URL(env.MCA_OPS_PROOF_SUPABASE_URL!).hostname.split(".")[0]
  const evidence = await runJobRuntimeProof(await createHostedRunner(env), projectRef)
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Job runtime proof failed."}\n`)
  process.exitCode = 1
})
