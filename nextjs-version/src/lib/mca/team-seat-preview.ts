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

/** Description of the next invitation under purchased-seat synchronization. */
export function inviteSeatDescription(billing: {activeSeats:number; pendingInvitationSeats:number; seatsCountPendingInvites:boolean; billing:null|{seatLimit:number;status:string}; state?:null|{pending_seats:number|null}}): string {
  if (billing.billing?.status!=="active") return "Send an invitation to join your company. One seat is reserved until they join."
  const purchased=billing.billing?.seatLimit??0
  const used=billing.activeSeats+(billing.seatsCountPendingInvites?billing.pendingInvitationSeats:0)
  const ceiling=billing.state?.pending_seats??purchased
  if (used<purchased && used<ceiling) return `Send an invitation to join your company. They'll use one of your unused seats (${used} of ${purchased} in use).`
  if (used>=ceiling && ceiling<purchased) return `The scheduled reduction allows ${ceiling} seats. Change or cancel it in Plans & Billing before adding another licensed member.`
  return `All ${purchased} seats are in use. A seat is added when ${billing.seatsCountPendingInvites?"this invitation is sent":"they accept"}.`
}
