import { build } from "esbuild"
await build({entryPoints:["scripts/assistant/worker.ts"],outfile:".next/assistant-worker.cjs",bundle:true,platform:"node",format:"cjs",target:"node24",conditions:["react-server"],external:["pg-native"],alias:{"server-only":"./scripts/assistant/server-only.cjs"},logLevel:"warning"})
