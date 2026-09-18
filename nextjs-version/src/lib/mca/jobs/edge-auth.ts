import { timingSafeEqual } from "node:crypto"
import { AppError } from "../errors"

/** Supabase publishable/anon keys deliberately cannot authorize scheduled workers. */
export function requireWorkerCredential(request: Request, expected = process.env.MCA_EDGE_WORKER_TOKEN): void {
  if (!expected || Buffer.byteLength(expected) < 32) throw new AppError(503, "worker_unconfigured", "The worker credential is not configured.")
  if (request.method !== "POST") throw new AppError(405, "method_not_allowed", "Use POST.")
  const authorization = request.headers.get("authorization") ?? ""
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : ""
  const a = Buffer.from(supplied), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, "worker_unauthorized", "Invalid worker credential.")
}
