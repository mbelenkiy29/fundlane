import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

for (const stopCode of [0, 1]) test(`local acceptance stops attempted startup and ${stopCode === 0 ? "cleans after shutdown" : "retains data on uncertain shutdown"}`, async () => {
  const tools = await mkdtemp(join(tmpdir(), "t0-pg-tools-"))
  const calls = join(tools, "calls")
  let root
  try {
    for (const tool of ["initdb", "pg_dump", "pg_restore", "psql"]) await writeFile(join(tools, tool), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    await writeFile(join(tools, "pg_ctl"), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$*" in
  *start*) exit 1 ;;
  *stop*) exit ${stopCode} ;;
esac
`, { mode: 0o700 })
    const result = spawnSync("bash", ["scripts/ops/local-acceptance.sh"], { env: { PATH: process.env.PATH, T0_POSTGRES_BIN: tools, T0_POSTGRES_PORT: "56439" }, encoding: "utf8" })
    assert.equal(result.status, 1)
    const recorded = await readFile(calls, "utf8")
    const dataDirectory = recorded.match(/-D (\S+)/)[1]
    root = dirname(dataDirectory)
    assert.match(recorded, /-m fast -w stop/, "Unsuccessful startup must still stop its own cluster")
    assert.equal(await stat(root).then(() => true, () => false), stopCode !== 0)
  } finally { if (root) await rm(root, { recursive: true, force: true }); await rm(tools, { recursive: true, force: true }) }
})
