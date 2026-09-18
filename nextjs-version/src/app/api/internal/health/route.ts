import { withTransaction } from "@/lib/mca/db"
import { requireMonitor } from "@/lib/mca/operations/access"
import { safeIdentifier } from "@/lib/mca/operations/contracts"
export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  try {
    requireMonitor(request)
  } catch {
    return new Response(null, { status: 401 })
  }
  const started = performance.now()
  try {
    // Bound the actual application pool query, not a separate privileged database connection.
    await withTransaction(async (db) => {
      await db.query("SET LOCAL statement_timeout='2000ms'")
      await db.query("SELECT 1")
    })
    return Response.json(
      {
        databaseOk: true,
        databaseMs: Math.round(performance.now() - started),
        deployment: safeIdentifier(process.env.VERCEL_DEPLOYMENT_ID),
      },
      { headers: { "cache-control": "no-store" } }
    )
  } catch {
    return Response.json(
      {
        databaseOk: false,
        databaseMs: null,
        deployment: safeIdentifier(process.env.VERCEL_DEPLOYMENT_ID),
      },
      { status: 503, headers: { "cache-control": "no-store" } }
    )
  }
}
