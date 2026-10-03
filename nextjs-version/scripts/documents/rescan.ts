import { parseArgs } from "node:util"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { closeDatabaseForTests } from "../../src/lib/mca/db"
import { rescanBypassedDocuments } from "../../src/lib/mca/documents/rescan"

const USAGE = "Usage: rescan.ts --workspace-id=ID [--ids-file=PATH] [--include-audit] [--backfill-marker] [--apply --confirm-database=HOST/DB]. Preview is the default."

/** One document ID per line; blank lines and lines starting with # are ignored. */
function readIds(path: string): string[] {
  const ids = readFileSync(path, "utf8").split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"))
  const invalid = ids.find(id => !/^[A-Za-z0-9_-]{1,100}$/.test(id))
  if (invalid) throw new Error(`Invalid document ID in ${path}: ${JSON.stringify(invalid.slice(0, 120))}`)
  return [...new Set(ids)]
}

async function main() {
  const { values } = parseArgs({ options: {
    "workspace-id": { type: "string" }, "ids-file": { type: "string" }, "include-audit": { type: "boolean", default: false },
    "backfill-marker": { type: "boolean", default: false }, apply: { type: "boolean", default: false }, "confirm-database": { type: "string" },
  } })
  const workspaceId = values["workspace-id"]?.trim()
  if (!workspaceId) throw new Error(USAGE)
  const ids = values["ids-file"] ? readIds(values["ids-file"]) : undefined
  const result = await rescanBypassedDocuments({ workspaceId, userId: null, membershipId: null, role: "admin", source: "system",
    managedMembershipIds: [], activeMembershipIds: [], correlationId: `document-rescan-${randomUUID()}` }, {
    apply: values.apply, ids, includeAudit: values["include-audit"], backfillMarker: values["backfill-marker"], confirmDatabase: values["confirm-database"]?.trim(),
  })
  console.log(JSON.stringify({ workspaceId, idsFromFile: ids?.length ?? 0, ...result }))
  if (result.failed.length) process.exitCode = 1
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Document rescan failed."); process.exitCode = 1 })
  .finally(() => closeDatabaseForTests())
