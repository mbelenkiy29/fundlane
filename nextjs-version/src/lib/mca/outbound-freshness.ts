import { AppError } from "./errors"

/** A long outage must not silently release old user-approved outbound content. */
export function assertOutboundFresh(authorizedAt: string, now = Date.now()): void {
  const timestamp = Date.parse(authorizedAt)
  if (!Number.isFinite(timestamp) || now - timestamp > 24 * 60 * 60 * 1000) {
    throw new AppError(409, "outbound_review_required", "This queued message is more than 24 hours old. Review current recipients and content, then submit a new request.")
  }
}
