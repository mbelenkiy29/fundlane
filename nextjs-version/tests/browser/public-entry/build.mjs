import esbuild from "esbuild"
import postcss from "postcss"
import tailwind from "@tailwindcss/postcss"
import fs from "node:fs/promises"
const output = "/tmp/task6-public-entry-browser"
await fs.mkdir(output, { recursive: true })
await esbuild.build({ entryPoints: ["tests/browser/public-entry/entry.tsx"], outfile: `${output}/app.js`, bundle: true, jsx: "automatic", alias: { "@": "./src", "next/navigation": "./tests/browser/public-entry/navigation.ts" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" } })
const css = await fs.readFile("src/app/globals.css", "utf8")
const result = await postcss([tailwind()]).process(css, { from: "src/app/globals.css" })
const marketing = await fs.readFile("src/components/marketing/marketing.css", "utf8")
await fs.writeFile(`${output}/app.css`, `${result.css}\n${marketing}`)
await fs.writeFile(`${output}/index.html`, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>')
