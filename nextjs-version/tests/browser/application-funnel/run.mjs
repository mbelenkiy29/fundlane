import fs from 'node:fs/promises'
// Use an already installed Playwright runtime; this harness adds no app dependency.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({
  ...(process.env.T12_CHROME_PATH ? { executablePath: process.env.T12_CHROME_PATH } : {}),
  headless: true,
})
try {
  const page = await browser.newPage()
  const code = await fs.readFile('tests/browser/application-funnel/scenarios.js', 'utf8')
  await new Function('page', 'Buffer', 'return (async()=>{' + code + '})()')(page, Buffer)
} finally { await browser.close() }
