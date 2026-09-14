import { build } from "esbuild"
await build({
  entryPoints: ["scripts/messaging/worker.ts"],
  outfile: ".next/messaging-worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  conditions: ["react-server"],
  external: ["pg-native"],
  alias: { "server-only": "./scripts/assistant/server-only.cjs" },
  logLevel: "warning",
})
