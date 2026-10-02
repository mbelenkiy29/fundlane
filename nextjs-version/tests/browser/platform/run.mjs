import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import * as fixtures from './fixtures.mjs'

// Use an installed browser runtime; no application dependency or hosted environment.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const out = resolve('output/playwright/platform-redesign')
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  const file = path === '/app.js' ? 'app.js' : path === '/app.css' ? 'app.css' : 'index.html'
  response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
  response.end(await fs.readFile(resolve(out, file)))
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ headless: true, ...(process.env.PLATFORM_CHROME_PATH ? { executablePath: process.env.PLATFORM_CHROME_PATH } : {}) })
const errors = [], checks = [], actions = []
try {
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme })
    const page = await context.newPage()
    let queueFailure = false
    const reads = new Map()
    let roadmap = structuredClone(fixtures.roadmap)
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname
      assert.equal(url.origin, origin, 'Synthetic browser must stay local')
      if (request.method() === 'GET') reads.set(path, (reads.get(path) ?? 0) + 1)
      if (request.method() !== 'GET') actions.push({ path, body: request.postDataJSON() })
      if (path === '/api/platform/queues') {
        if (queueFailure) return route.fulfill({ status: 500, json: { error: { message: 'Synthetic queue failure' } } })
        const row = url.searchParams.get('kind') === 'sms' ? fixtures.queueSms : fixtures.queueCompany
        return route.fulfill({ json: { items: [{ ...row, ...(url.searchParams.has('cursor') ? { workspaceId: 'company-b', name: 'Synthetic Brokerage B', companyName: 'Synthetic Brokerage B' } : {}) }], nextCursor: url.searchParams.has('cursor') ? null : 'synthetic-next' } })
      }
      if (path === '/api/admin/status') return route.fulfill({ json: fixtures.status })
      if (path === '/api/admin/status/errors') return route.fulfill({ json: { errors: [], next: null } })
      if (path === '/api/mca/sms/operator' && request.method() === 'GET') {
        const fixture = new URL(page.url()).searchParams.get('fixture')
        if (fixture === 'sms-error') return route.fulfill({ status: 500, json: { error: { message: 'Synthetic SMS reviews unavailable' } } })
        return route.fulfill({ json: { companies: fixture === 'sms-empty' ? [] : [fixtures.smsCompany] } })
      }
      if (path.startsWith('/api/platform/roadmap')) {
        if (request.method() === 'GET') return route.fulfill({ json: roadmap })
        if (url.searchParams.get('action') === 'publish') roadmap = roadmap.map(item => ({ ...item, published: true }))
        return route.fulfill({ json: {} })
      }
      return route.fulfill({ json: {} })
    })
    const visit = async path => {
      await page.goto(`${origin}${path}${path.includes('?') ? '&' : '?'}theme=${theme}`)
      await page.locator('main').waitFor()
      await page.waitForFunction(theme => document.documentElement.classList.contains(theme), theme)
    }
    const screens = ['/platform', '/platform/companies', '/platform/companies/company-a', '/platform/payments', '/platform/monitoring', '/platform/sms', '/platform/sms?view=review', '/platform/audit', '/platform/audit?tab=super-admin', '/platform/demo-requests', '/platform/roadmap']
    for (const path of screens) {
      await visit(path)
      await page.locator('main h1').waitFor()
      if (path.includes('/monitoring')) await page.getByText('Healthy', { exact: true }).waitFor()
      if (['/platform', '/platform/companies/company-a', '/platform/sms'].includes(path)) await page.getByText(/Database snapshot/).first().waitFor()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Overflow: ${width} ${theme} ${path}`)
      assert.equal(await page.locator('main h1').count(), 1, path)
      if (width === 1440 && path === '/platform/companies/company-a') assert.equal(await page.locator('nav[aria-label="Platform"] a[href="/platform/companies"]').getAttribute('data-active'), 'true')
      const file = `${width}-${theme}-${path.replaceAll('/', '-').replaceAll('?', '-').replaceAll('=', '-')}.png`
      await page.screenshot({ path: resolve(out, file), fullPage: true })
      checks.push(`${width} ${theme} ${path}`)
    }
    await visit('/platform')
    if (width === 390) {
      await page.getByRole('button', { name: 'Toggle Sidebar' }).click()
      const drawer = page.getByRole('dialog')
      await drawer.getByRole('link', { name: 'Companies', exact: true }).click()
      await page.getByRole('heading', { name: 'Companies', exact: true }).waitFor()
      assert.equal(await drawer.count(), 0, 'Navigation closes the mobile drawer')
      await page.getByRole('button', { name: 'Toggle Sidebar' }).click()
      const currentLink = drawer.getByRole('link', { name: 'Companies', exact: true })
      await currentLink.evaluate(link => link.addEventListener('click', event => event.preventDefault(), { once: true }))
      await currentLink.click()
      await drawer.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Toggle Sidebar' }).click()
    } else {
      await page.keyboard.press('Control+b')
      assert.equal(await page.locator('[data-slot="sidebar"][data-state]').getAttribute('data-state'), 'collapsed')
      await page.keyboard.press('Control+b')
    }
    await page.getByRole('button', { name: /Super admin operator@example.test/ }).click()
    await page.getByRole('menuitem', { name: 'Account security', exact: true }).waitFor()
    assert.equal(await page.getByRole('menuitem', { name: 'Workspace settings' }).count(), 0)
    assert.equal(await page.getByRole('menuitem', { name: 'Switch company' }).count(), 0)
    await page.keyboard.press('Escape')
    await visit('/platform?roadmap=off')
    if (width === 390) await page.getByRole('button', { name: 'Toggle Sidebar' }).click()
    assert.equal(await page.getByRole('link', { name: 'Roadmap', exact: true }).count(), 0)
    await visit('/platform/companies/company-a')
    assert.equal(await page.getByRole('button', { name: 'Pause company access' }).isDisabled(), true)
    await page.getByLabel('Audit reason for any action below (required)').fill('Synthetic operator review')
    await page.getByRole('button', { name: 'Pause company access' }).click()
    await page.getByRole('status').filter({ hasText: 'Company updated' }).waitFor()
    await page.getByRole('button', { name: 'Resend…', exact: true }).click()
    await page.getByRole('dialog', { name: 'Resend delivered billing notice?' }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(actions.some(action => action.body?.action === 'notification_resend'), false, 'Cancelling does not resend')
    await visit('/platform/companies?offset=50&q=Synthetic')
    await page.getByRole('link', { name: 'Previous', exact: true }).click()
    assert.equal(new URL(page.url()).searchParams.get('q'), 'Synthetic')
    assert.equal(new URL(page.url()).searchParams.get('offset'), '0')
    await page.getByLabel('Search', { exact: true }).fill('no-match')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByText('No matching companies.', { exact: true }).waitFor()
    await visit('/platform')
    await page.getByText(/Database snapshot/).first().waitFor()
    await page.getByRole('button', { name: 'Next 50' }).click()
    await page.getByRole('link', { name: 'Synthetic Brokerage B', exact: true }).waitFor()
    queueFailure = true
    await page.getByRole('button', { name: 'Refresh queue' }).click()
    await page.getByRole('alert').filter({ hasText: 'Stale snapshot' }).waitFor()
    queueFailure = false
    await visit('/platform/audit?tab=super-admin')
    assert.equal(await page.getByRole('button', { name: 'Export CSV' }).isDisabled(), true)
    await page.getByRole('textbox', { name: 'Authenticator code' }).fill('123456')
    await page.getByRole('button', { name: 'Verify for export' }).click()
    await page.getByText('Authenticator verified for a short period.').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Export CSV' }).isDisabled(), false)
    await page.getByLabel('Actor', { exact: true }).fill('operator@example.test')
    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'super-admin')
    assert.equal(new URL(page.url()).searchParams.get('actor'), 'operator@example.test')
    await visit('/platform/sms?view=review')
    await page.getByRole('textbox', { name: 'Authenticator code' }).fill('123456')
    await page.getByRole('button', { name: 'Verify code' }).click()
    await page.getByText('Authenticator verified for this session.').waitFor()
    await page.getByLabel('Reason / evidence reference').fill('Synthetic consent evidence reviewed')
    await page.getByRole('button', { name: 'Save decision and limits' }).click()
    await page.getByText('Review saved.', { exact: true }).waitFor()
    await visit('/platform/sms?view=review&fixture=sms-empty')
    await page.getByText('No companies available for review.', { exact: true }).waitFor()
    await visit('/platform/sms?view=review&fixture=sms-error')
    await page.getByRole('alert').filter({ hasText: 'Synthetic SMS reviews unavailable' }).waitFor()
    assert.equal(await page.getByText('No companies available for review.', { exact: true }).count(), 0)
    await visit('/platform/roadmap')
    if (width === 1440 && theme === 'light') {
      await page.clock.install()
      const title = page.getByLabel('Title', { exact: true }).nth(1)
      await title.fill('Unfinished operator edit')
      const before = reads.get('/api/platform/roadmap') ?? 0
      const timed = page.waitForResponse(response => response.url().endsWith('/api/platform/roadmap'))
      await page.clock.runFor(30_001)
      await timed
      await page.waitForFunction(() => globalThis.platformServerReads > 0)
      assert.ok((reads.get('/api/platform/roadmap') ?? 0) > before, '30s timer refreshes client queues')
      assert.equal(await title.inputValue(), 'Unfinished operator edit', 'Refresh preserves drafts')
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
      const hidden = reads.get('/api/platform/roadmap')
      await page.clock.runFor(60_001)
      assert.equal(reads.get('/api/platform/roadmap'), hidden, 'Hidden tabs do not poll')
      const returning = page.waitForResponse(response => response.url().endsWith('/api/platform/roadmap'))
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
      await returning
      assert.equal(await title.inputValue(), 'Unfinished operator edit')
      const manual = page.waitForResponse(response => response.url().endsWith('/api/platform/roadmap'))
      await page.getByRole('button', { name: 'Refresh data', exact: true }).click()
      await manual
      assert.equal(await title.inputValue(), 'Unfinished operator edit')
      await page.clock.resume()
    }
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await page.getByRole('button', { name: 'Unpublish', exact: true }).waitFor()
    for (const fixture of ['loading', 'error']) {
      await visit(`/platform?fixture=${fixture}`)
      await page.getByRole(fixture === 'loading' ? 'status' : 'alert').waitFor()
      await page.screenshot({ path: resolve(out, `${width}-${theme}-${fixture}.png`), fullPage: true })
    }
    await visit('/platform')
    await page.keyboard.press('Tab')
    assert.ok(await page.evaluate(() => document.activeElement !== document.body), 'Keyboard can reach controls')
    await page.getByRole('button', { name: `Switch to ${theme === 'light' ? 'dark' : 'light'} mode` }).click()
    await page.waitForFunction(theme => document.documentElement.classList.contains(theme), theme === 'light' ? 'dark' : 'light')
    await context.close()
  }
  assert.deepEqual(errors, [], 'No browser runtime errors')
  assert.ok(actions.some(action => action.body?.action === 'access' && action.body?.reason === 'Synthetic operator review'))
  assert.ok(actions.some(action => action.path === '/api/platform/step-up' && action.body?.code === '123456'))
  await fs.writeFile(resolve(out, 'report.json'), JSON.stringify({ checks, errors, actionChecks: actions.length }, null, 2))
  console.log(`Passed ${checks.length} screen reviews plus navigation, filters, pagination, step-up, action and state checks.`)
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)) }
