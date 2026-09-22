/**
 * Seeds a throwaway workspace + deal for a live SMS/email test of the
 * assistant chat messenger, and records SMS opt-in consent so the panel can
 * send. It links the seeded administrator to an existing Supabase Auth user so
 * the client can sign in and see the test data.
 *
 * Usage (from nextjs-version/):
 *   node --env-file=.env.local --conditions=react-server --import tsx \
 *     scripts/messaging/seed-live-user.ts \
 *     --email you@example.com --phone +14155551234 \
 *     [--deal "Live test merchant"] [--workspace "Live SMS test"] \
 *     [--merchant-email you@example.com] [--admin-name "Live Test Admin"] --yes
 *
 * Requires in .env.local: DATABASE_URL, SUPABASE_URL, SUPABASE_SECRET_KEY,
 * MCA_DATA_ENCRYPTION_KEY. Pass --yes to write; without it the script only
 * prints what it would do. Use a dev database — never your production Supabase.
 */
import { randomUUID } from "node:crypto"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createWorkspaceWithAdmin } from "../../src/lib/mca/workspaces"
import { actorForDeals, createDeal } from "../../src/lib/mca/deals/service"
import { recordSmsConsent } from "../../src/lib/mca/sms/service"
import { closeDatabaseForTests, getDatabase, newId } from "../../src/lib/mca/db"

const args = process.argv.slice(2)
const flags: Record<string, string> = {}
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (!arg.startsWith("--")) continue
  const [name, inline] = arg.slice(2).split("=", 2)
  if (inline !== undefined) flags[name] = inline
  else {
    flags[name] = args[index + 1] ?? "true"
    index += 1
  }
}

function usage(): void {
  console.log(`
Seeds a live-test workspace, deal, and SMS consent for the assistant chat messenger.

  --email <email>            Supabase Auth email of the person signing in (required)
  --phone <E.164 phone>      Mobile number that receives the test texts — becomes the
                             merchant contact on the deal so the panel texts it (required)
  --deal <legal name>        Deal name shown to the assistant       [default: Live test merchant]
  --workspace <name>         New workspace created for the test      [default: Live SMS test]
  --merchant-email <email>   Merchant contact email on the deal      [default: --email]
  --admin-name <name>        Admin display name                      [default: Live Test Admin]
  --yes                      Confirm writes to the connected database

Example:
  node --env-file=.env.local --conditions=react-server --import tsx scripts/messaging/seed-live-user.ts \\
    --email you@example.com --phone +14155551234 --yes
`)
}

function loadDotenvIntoEnv(path: string): void {
  if (!existsSync(path)) return
  const text = readFileSync(path, "utf8")
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
    )
    if (!match || process.env[match[1]] !== undefined) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1)
    process.env[match[1]] = value
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is missing. Fill it in .env.local (see check-env.mjs).`)
  return value
}

async function supabaseUserIdByEmail(
  baseUrl: string,
  serviceKey: string,
  email: string
): Promise<string | undefined> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/auth/v1/admin/users`)
  url.searchParams.set("email", email)
  const response = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  })
  if (!response.ok)
    throw new Error(
      `Supabase admin /users failed (${response.status}) — check SUPABASE_URL and SUPABASE_SECRET_KEY.\n${await response.text()}`
    )
  const data = (await response.json()) as { users: { id: string }[] }
  return data.users[0]?.id
}

async function main(): Promise<number> {
  if (flags.help !== undefined || flags.email === "true") {
    usage()
    return 0
  }
  const email = flags.email
  const phone = flags.phone
  if (!email || !phone) {
    usage()
    return 1
  }
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    console.error(`Phone must be E.164 (e.g. +14155551234), got "${phone}".`)
    return 1
  }
  const dealName = flags.deal ?? "Live test merchant"
  const workspaceName = flags.workspace ?? "Live SMS test"
  const merchantEmail = flags["merchant-email"] ?? email
  const adminName = flags["admin-name"] ?? "Live Test Admin"

  // Env may come from `--env-file` (runbook) or from a local `.env.local`.
  loadDotenvIntoEnv(join(process.cwd(), ".env.local"))
  const databaseUrl = required("DATABASE_URL")
  const supabaseUrl = required("SUPABASE_URL")
  const supabaseKey = required("SUPABASE_SECRET_KEY")
  required("MCA_DATA_ENCRYPTION_KEY")

  const host = new URL(databaseUrl).host
  console.log("\n⚠  This will WRITE to the database at:", host)
  console.log("   • Create workspace:", workspaceName)
  console.log(`   • Create deal "${dealName}" with contact mobile ${phone}`)
  console.log(`   • Record SMS opt-in consent for ${phone} on that deal`)
  console.log(`   • Link the admin account to Supabase Auth email ${email}`)
  console.log(
    "   Run against a dev database, never production Supabase. Pass --yes to continue."
  )
  if (flags.yes !== "true") return 1

  console.log("\nResolving Supabase Auth identity…")
  const authId = await supabaseUserIdByEmail(supabaseUrl, supabaseKey, email)
  if (!authId) {
    console.log(
      `No Supabase Auth user found for ${email}. Sign in once on the app, or create the user in the Supabase dashboard, then re-run.`
    )
    return 1
  }

  console.log("Creating workspace + administrator…")
  const data = await createWorkspaceWithAdmin({
    workspaceName,
    adminName,
    adminEmail: email,
    password: randomUUID(),
    role: "admin",
  })
  const admin = {
    ...data,
    authType: "session",
    role: "admin",
    sessionId: randomUUID(),
    scopes: [],
  }

  const existing = await getDatabase()
    .prepare("SELECT supabase_user_id FROM users WHERE id=?")
    .get(data.userId)
  if (existing?.supabase_user_id === authId) {
    console.log("Admin already linked to the Supabase identity.")
  } else if (existing && existing.supabase_user_id) {
    console.log(
      "⚠ The admin account is already linked to another Supabase identity; leaving it as-is."
    )
  } else {
    await getDatabase()
      .prepare("UPDATE users SET supabase_user_id=? WHERE id=?")
      .run(authId, data.userId)
    console.log("Linked admin account to Supabase identity.")
  }

  console.log("Creating the test deal…")
  const actor = await actorForDeals(admin)
  const { deal } = await createDeal(actor, {
    idempotencyKey: newId(),
    legalName: dealName,
    contactPhone: phone,
    contactEmail: merchantEmail,
    assignments: [
      { membershipId: data.membershipId, kind: "originator", isPrimary: true },
    ],
  })

  console.log("Recording SMS opt-in consent…")
  await recordSmsConsent(actor, {
    dealId: deal.id,
    recipient: phone,
    state: "opted_in",
    evidence: `Live test opt-in recorded by seed-live-user (${new Date().toISOString()})`,
    idempotencyKey: newId(),
  })

  console.log(`
Done. Test data is ready.
  Workspace : ${workspaceName} (id ${data.workspaceId})
  Deal      : ${dealName} (${deal.displayId}, id ${deal.id})
  Text      : merchant contact = ${phone} (consent recorded)
  Email     : merchant contact = ${merchantEmail}

Next steps
  1. Sign in with ${email} and switch to the "${workspaceName}" workspace.
  2. Open /deals?deal=${encodeURIComponent(
    deal.id
  )} and press the Assistant button (or open /assistant). The panel
     shows SMS + Email tabs with the thread list, consent, and composer.
  3. Ask the assistant to draft a text or email to the merchant, then use the
     draft card → "Review in messenger" → Preview → Send.
  4. To actually SEND a test text, configure MCA_SMS_PROVIDER=twilio plus
     MCA_SMS_TWILIO_ACCOUNTS_JSON and MCA_SMS_PUBLIC_BASE_URL, restart the app,
     and assign a Twilio number to this workspace in the SMS inbox.
  5. For email, connect a Google/Microsoft sender in the email inbox first.
  See docs/messaging-live-test.md for the full runbook.`)
  return 0
}

void main()
  .then((code) => closeDatabaseForTests().then(() => process.exit(code)))
  .catch((error: unknown) => {
    console.error("\nSeed failed:", error instanceof Error ? error.message : error)
    return closeDatabaseForTests()
      .catch(() => undefined)
      .then(() => process.exit(1))
  })