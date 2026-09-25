// Run from nextjs-version: node scripts/verification/table-layout.mjs
// Open the printed URL, then run the layout check on the long/short/empty/wide tables
// and the assistant Markdown numeric column. The template task table was removed.
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { build } from "esbuild"
import postcss from "postcss"
import tailwind from "@tailwindcss/postcss"

const js = await build({ entryPoints: ["tests/fixtures/table-layout.tsx"], bundle: true, write: false, format: "esm", define: { "process.env.NODE_ENV": '"development"' } })
const css = await postcss([tailwind()]).process(await readFile("src/app/globals.css", "utf8"), { from: "src/app/globals.css" })
const marketing = await readFile("src/components/marketing/marketing.css", "utf8")
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : "text/html")
  res.end(req.url === "/fixture.js" ? js.outputFiles[0].text : `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Table layout regression</title><style>${css.css}\n${marketing}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`)
})
server.listen(3044, "127.0.0.1", () => console.log("Table verification: http://127.0.0.1:3044"))
