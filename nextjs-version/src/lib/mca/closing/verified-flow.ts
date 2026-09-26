/** Opt-in closing rules while provider activation is being verified. */
export function verifiedClosingFlowEnabled(): boolean {
  return process.env.MCA_CLOSING_VERIFIED_FLOW_ENABLED === "true"
}
