import { build } from "esbuild"
await build({
  entryPoints: ["scripts/operations/edge-entry.ts"],
  outfile: "supabase/functions/platform-monitor/index.js",
  bundle: true,
  external: ["npm:*"],
  format: "esm",
  platform: "neutral",
  target: "es2022",
})
