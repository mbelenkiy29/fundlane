import { build } from "esbuild"
await build({entryPoints:["scripts/workers/run.ts"],outfile:".next/document-worker.cjs",bundle:true,platform:"node",format:"cjs",target:"node24",conditions:["react-server"],external:["pg-native"],alias:{"server-only":"./scripts/assistant/server-only.cjs"},logLevel:"warning"})
