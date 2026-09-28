/** Quote the possible paid increase before inviting, including later acceptance of pending invites. */
export function inviteSeatIncreaseTarget(billing: {
  seatSyncEnabled: boolean
  seatsCountPendingInvites: boolean
  activeSeats: number
  pendingInvitationSeats: number
  billing: null | { subscriptionId: string | null; status: string; seatLimit: number }
}): number | null {
  if (!billing.seatSyncEnabled || billing.billing?.status !== "active" || !billing.billing.subscriptionId) return null
  const target = billing.activeSeats + billing.pendingInvitationSeats + 1
  return target > billing.billing.seatLimit ? target : null
}
