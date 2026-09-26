export function signupMode(): "open" | "invite_only" {
  return process.env.MCA_SIGNUP_MODE === "invite_only" ? "invite_only" : "open"
}

export function migratedAccountNoticeEnabled(): boolean {
  return process.env.MCA_SHOW_MIGRATED_ACCOUNT_NOTICE !== "false"
}
