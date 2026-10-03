import esbuild from 'esbuild'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
const out = process.env.PLATFORM_BROWSER_OUT || 'output/playwright/platform-redesign'
const fixtures = resolve('tests/browser/platform/fixtures.mjs')
await fs.mkdir(out, { recursive: true })
await esbuild.build({ entryPoints: [process.env.PLATFORM_BROWSER_ENTRY || 'tests/browser/platform/entry.tsx'], outfile: `${out}/app.js`, bundle: true, jsx: 'automatic', alias: { '@': './src' }, define: { 'process.env.NODE_ENV': '"development"', 'process.env.NEXT_PUBLIC_SENTRY_DSN': '""' }, plugins: [{
  name: 'synthetic-platform-services',
  setup(build) {
    build.onResolve({ filter: /^(@sentry\/nextjs|next\/(navigation|link)|@\/lib\/(mca\/(errors|platform-console|platform-page-access|platform-audit|roadmap-admin|jobs\/document-runtime)|marketing\/(demo-storage|launch-switches)))$/ }, args => ({ path: args.path, namespace: 'synthetic' }))
    build.onLoad({ filter: /.*/, namespace: 'synthetic' }, args => {
      if (args.path === 'next/navigation') return { contents: `const router={refresh(){globalThis.platformServerReads=(globalThis.platformServerReads??0)+1}}; export const usePathname=()=>location.pathname; export const useRouter=()=>router; export const notFound=()=>{throw new Error('Not found')}`, loader: 'js', resolveDir: process.cwd() }
      // Sentry stays inert in the synthetic preview, as it does without a DSN.
      if (args.path === '@sentry/nextjs') return { contents: `const noop=()=>{}; export const getClient=()=>undefined; export const getFeedback=()=>undefined; export const addIntegration=noop; export const captureException=noop; export const setUser=noop; export const setTags=noop; export const setContext=noop; export const replayIntegration=noop; export const feedbackIntegration=noop`, loader: 'js', resolveDir: process.cwd() }
      if (args.path === 'next/link') return { contents: `import React from ${JSON.stringify(resolve('node_modules/react/index.js'))}; export default React.forwardRef(function Link({href,children,...props},ref){return React.createElement('a',{...props,href,ref},children)})`, loader: 'js', resolveDir: process.cwd() }
      return { contents: `export * from ${JSON.stringify(fixtures)}`, loader: 'js', resolveDir: process.cwd() }
    })
  },
}] })
const css = await fs.readFile('src/app/globals.css', 'utf8')
const result = await postcss([tailwind()]).process(css, { from: 'src/app/globals.css' })
const componentCss = await fs.readFile(`${out}/app.css`, 'utf8')
await fs.writeFile(`${out}/app.css`, result.css + componentCss)
await fs.writeFile(`${out}/index.html`, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Platform synthetic preview</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>')
