import "server-only"
import { timingSafeEqual } from "node:crypto"
import { AppError } from "../errors"
export function requireMonitor(request: Request) {
  const secret = process.env.MCA_MONITOR_TOKEN
  const actual = request.headers.get("authorization") ?? ""
  const expected = `Bearer ${secret}`
  if (
    !secret ||
    secret.length < 32 ||
    actual.length !== expected.length ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
    throw new AppError(
      401,
      "authentication_required",
      "Monitor authentication required."
    )
}
