import { parseArgs } from "node:util"
import { randomUUID } from "node:crypto"
import { closeDatabaseForTests } from "../../src/lib/mca/db"
import { recoverWorkspaceDocuments } from "../../src/lib/mca/documents/recovery"

async function main() {
  const { values } = parseArgs({ options: { "workspace-id": { type: "string" }, apply: { type: "boolean", default: false } } })
  const workspaceId = values["workspace-id"]?.trim()
  if (!workspaceId) throw new Error("Provide --workspace-id=ID. Preview is the default; add --apply to recover files.")
  const result = await recoverWorkspaceDocuments({ workspaceId, userId: null, membershipId: null, role: "admin",
    source: "system", managedMembershipIds: [], activeMembershipIds: [], correlationId: `document-recovery-${randomUUID()}` }, values.apply)
  console.log(JSON.stringify({ apply: values.apply, ...result }))
  if (result.failed.length) process.exitCode = 1
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Document recovery failed."); process.exitCode = 1 })
  .finally(() => closeDatabaseForTests())
