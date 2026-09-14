import { spawnSync } from "node:child_process"
const expected = "drubsfvhlggmtyiigwxy"
if (process.argv[2] !== `--expected-project-ref=${expected}`)
  throw new Error("Explicit Fundlane project reference required.")
for (const [cmd, args] of [
  ["node", ["scripts/operations/build-monitor.mjs"]],
  [
    "supabase",
    [
      "functions",
      "deploy",
      "platform-monitor",
      "--project-ref",
      expected,
      "--no-verify-jwt",
        "--use-api",
    ],
  ],
]) {
  const result = spawnSync(cmd, args, { stdio: "inherit" })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log("Function deployed. Schedules and alerts were not enabled.")
