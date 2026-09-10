// Repeatable development catalog + least-privilege role setup. Never targets production.
import { spawnSync } from "node:child_process"
const target = ["--app", "app_3J6N3t7eRGSb3u1BO7wUTIEsxyx", "--instance", "dev"]
const apply = process.argv.includes("--apply")
function cli(args) {
  const r = spawnSync("pnpm", ["dlx", "clerk@latest", ...args, ...target], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(r.stderr || "Clerk setup failed")
  return r.stdout
}
function mutate(args) { cli([...args, "--dry-run"]); if (apply) return cli([...args, "--yes"]) }
mutate(["config", "patch", "--file", "scripts/clerk/billing-development.json"])
mutate(["config", "patch", "--json", JSON.stringify({ organization_settings: { max_allowed_memberships: 1 } })])
const roles = JSON.parse(cli(["api", "/organization_roles"])).data
const permissions = JSON.parse(cli(["api", "/organization_permissions"])).data
for (const [key, name, desired] of [["org:mca_billing_admin", "MCA Billing Admin", ["org:sys_billing:read", "org:sys_billing:manage"]], ["org:mca_employee", "MCA Employee", []]]) {
  let role = roles.find(r => r.key === key)
  if (!role) {
    const result = mutate(["api", "/organization_roles", "-X", "POST", "-d", JSON.stringify({ key, name, description: "MCA controls application access and team membership." })])
    if (!result) continue
    role = JSON.parse(result)
  }
  for (const permission of permissions) {
    const has = role.permissions.some(p => p.key === permission.key)
    const needs = desired.includes(permission.key)
    if (has !== needs) mutate(["api", `/organization_roles/${role.id}/permissions/${permission.id}`, "-X", needs ? "POST" : "DELETE"])
  }
}
// Default provider memberships also must not expose billing through hosted Clerk surfaces.
const member = roles.find(r => r.key === "org:member")
for (const permission of member?.permissions ?? []) if (permission.key.startsWith("org:sys_billing:")) mutate(["api", `/organization_roles/${member.id}/permissions/${permission.id}`, "-X", "DELETE"])
console.log(apply ? "Development catalog and billing roles reconciled." : "Dry-run complete; no settings changed.")
console.log("The CLI config schema does not expose seat-based plan caps. Verify Starter Test = 5 and Team Test = 20, per-seat fees off, in Clerk Dashboard after initial setup.")
