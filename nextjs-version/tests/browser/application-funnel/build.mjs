import esbuild from 'esbuild'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import fs from 'node:fs/promises'
await fs.mkdir('output/playwright/t12',{recursive:true})
await esbuild.build({ entryPoints:['tests/browser/application-funnel/entry.tsx'], outfile:'output/playwright/t12/app.js', bundle:true, jsx:'automatic', alias:{'@':'./src'}, define:{'process.env.NODE_ENV':'"development"'} })
const css=await fs.readFile('src/app/globals.css','utf8')
const result=await postcss([tailwind()]).process(css,{from:'src/app/globals.css'})
await fs.writeFile('output/playwright/t12/app.css',result.css)
await fs.writeFile('output/playwright/t12/index.html','<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="app.js"></script></body></html>')
