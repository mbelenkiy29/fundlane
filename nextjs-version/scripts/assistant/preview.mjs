// Synthetic localhost-only fixture; this never bypasses authentication in the application.
import { build } from "esbuild"
import postcss from "postcss"
import tailwind from "@tailwindcss/postcss"
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"

const dir = await mkdtemp(join(tmpdir(), "fundlane-assistant-preview-"))
const port = Number(process.env.ASSISTANT_PREVIEW_PORT ?? 5877)
const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AssistantWorkspace} from '${resolve("src/components/mca/assistant/assistant-workspace.tsx")}';
window.fetch = async (path, init = {}) => {
  const url = new URL(path, location.origin);
  if (url.pathname.endsWith('/credits')) {
    return new Response(JSON.stringify({
      workspaceId: 'ws',
      balance: { allowance: 100, included: 90, purchased: 10, reserved: 0, debt: 0, total: 100, resetAt: '2026-10-01T00:00:00.000Z' },
      canManage: true,
      purchasesAvailable: false,
      ledger: [],
    }), { headers: { 'content-type': 'application/json' } });
  }
  if (url.pathname.endsWith('/conversations') && init.method === 'POST') {
    return new Response(JSON.stringify({ id: 'conv-1', dealId: null, messages: [], run: null, approvals: [] }), { headers: { 'content-type': 'application/json' } });
  }
  if (url.pathname.includes('/conversations')) {
    return new Response(JSON.stringify({ conversations: [{ id: 'conv-history', dealId: null, createdAt: '2026-09-17T12:00:00.000Z', title: 'Pipeline recap' }], nextBefore: null }), { headers: { 'content-type': 'application/json' } });
  }
  if (url.pathname.endsWith('/deals')) {
    const q = url.searchParams.get('q') || '';
    const deals = [{ id: 'deal-acme', legalName: 'Acme Deli', displayId: 'MCA-1001' }, { id: 'deal-harbor', legalName: 'Harbor Coffee', displayId: 'MCA-1002' }]
      .filter((d) => !q || d.legalName.toLowerCase().includes(q.toLowerCase()));
    return new Response(JSON.stringify({ deals }), { headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: { message: 'Unmocked ' + url.pathname } }), { status: 404, headers: { 'content-type': 'application/json' } });
};
createRoot(document.getElementById('root')).render(<AssistantWorkspace />);
`
await build({
  stdin: { contents: entry, loader: "jsx", resolveDir: process.cwd() },
  outfile: join(dir, "app.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  tsconfig: resolve("tsconfig.json"),
  plugins: [{
    name: "preview-next",
    setup(b) {
      b.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }))
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "nav", namespace: "fixture" }))
      b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => {
        if (args.path === "link") {
          return {
            contents: "import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{...props,href},children)}",
            loader: "js",
            resolveDir: process.cwd(),
          }
        }
        return {
          contents: `import React from 'react';
const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
export function useRouter(){return {push(href){history.pushState({},'',href);location.reload()},replace(href){history.replaceState({},'',href)},refresh(){}}}
export function useSearchParams(){return params}
export function usePathname(){return '/assistant'}`,
          loader: "js",
          resolveDir: process.cwd(),
        }
      })
    },
  }],
})
const css = await postcss([tailwind({ base: process.cwd() })]).process(await readFile("src/app/globals.css", "utf8"), { from: resolve("src/app/globals.css") })
await writeFile(join(dir, "app.css"), css.css)
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/app.js" || req.url === "/app.css") {
      res.setHeader("content-type", req.url.endsWith("css") ? "text/css" : "text/javascript")
      res.end(await readFile(join(dir, req.url.slice(1))))
      return
    }
    res.setHeader("content-type", "text/html")
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Assistant verification</title></head><body class="bg-background text-foreground"><main id="root" class="h-dvh"></main><script type="module" src="/app.js"></script></body></html>')
  } catch {
    res.statusCode = 500
    res.end("Preview failed")
  }
})
server.listen(port, "127.0.0.1", () => console.log(`Synthetic assistant preview: http://127.0.0.1:${port}`))
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.close()
  void rm(dir, { recursive: true, force: true }).then(() => process.exit(0))
})
