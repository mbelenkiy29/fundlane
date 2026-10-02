import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const out = resolve(process.env.PLATFORM_BROWSER_OUT || '/tmp/fundlane-onboarding-operator')
const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const emailId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', targetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', providerUserId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const stamp = '2026-10-02T03:00:00.000Z'
const detailFixture = id => ({ enrollmentId: id, revision: 7, claimState: 'unclaimed', recoveryState: 'none', emailGeneration: 1, billingState: 'trialing', trialEndsAt: '2026-10-16T03:00:00.000Z', providerAccountId: 'acct_synthetic', checkoutSessionId: 'cs_synthetic', subscriptionId: 'sub_synthetic', livemode: false, runtime: { runtimeEnabled: true, creationEnabled: false, emailDispatchEnabled: false }, availableActions: ['verify_target', 'approve_identity', 'record_email_evidence', 'reissue_emails'], targetVerification: [{ id: targetId, state: 'verified', provider_user_id: providerUserId, verified_at: stamp }], emails: [{ id: emailId, purpose: 'getting_started', generation: 1, state: 'uncertain', attempts: 1, createdAt: stamp, updatedAt: stamp, ageSeconds: 120, nextAttemptAt: stamp, errorCode: 'acceptance_unknown', provider: 'usesend', providerConfigurationId: 'transport_synthetic', providerIdentityVerified: false, providerMessageId: null, supersededByGeneration: null, canRecordEvidence: true, receipts: [{ id: 'receipt-synthetic', state: 'accepted', providerMessageId: 'message-M1', evidenceType: 'provider_acceptance', occurredAt: stamp, observedAt: stamp }] }] })
const queueFixture = (id, nextCursor = null) => ({ snapshotAt: stamp, nextCursor, runtime: { enabled: true, creationEnabled: false, emailEnabled: false }, items: [{ enrollmentId: id, revision: 7, createdAt: stamp, updatedAt: stamp, workspaceId: null, checkoutState: 'complete', billingState: 'trialing', claimState: 'unclaimed', finalizationState: 'none', recoveryState: 'none', trialEndsAt: '2026-10-16T03:00:00.000Z', activatedAt: stamp, verifiedAt: stamp, nextReconcileAt: stamp, leaseUntil: null, repairState: 'due', hasRepairError: false, emails: [{ purpose: 'getting_started', state: 'uncertain', attempts: 1, hasError: true, nextAttemptAt: stamp }] }] })
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  const file = path === '/app.js' ? 'app.js' : path === '/app.css' ? 'app.css' : 'index.html'
  response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
  response.end(await fs.readFile(resolve(out, file)))
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
const checks = [], errors = [], actions = [], reads = []
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLATFORM_CHROME_PATH })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  await page.clock.install()
  await page.addInitScript(({ strictRead }) => {
    const original = window.fetch
    window.operatorRequests = []
    let detailStarts = 0
    window.fetch = (url, options) => {
      window.operatorRequests.push({ url: String(url), method: options?.method ?? 'GET', cache: options?.cache, credentials: options?.credentials })
      // Hold the abandoned first effect's rejection until its replacement is active.
      if (strictRead && /^\/api\/platform\/onboarding\//.test(String(url)) && (options?.method ?? 'GET') === 'GET' && ++detailStarts === 1) return new Promise((_resolve, reject) => { window.settleAbandonedRead = () => reject(new DOMException('Abandoned synthetic read', 'AbortError')) })
      return original(url, options)
    }
  }, { strictRead: process.env.OPERATOR_STRICT_READ === '1' })
  page.on('pageerror', error => errors.push(error.message))
  const details = { [a]: detailFixture(a), [b]: detailFixture(b) }
  let readStatus = 200, queueStatus = 200, conflict = false, postGate, readGate
  const reply = (route, status, json) => route.fulfill({ status, json, headers: { 'Cache-Control': 'private, no-store' } })
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    assert.equal(url.origin, origin, 'All synthetic API requests stay on loopback')
    if (request.method() === 'GET') reads.push(path + url.search)
    else actions.push({ path, body: request.postDataJSON() })
    if (path === '/api/platform/onboarding') return reply(route, queueStatus, queueStatus === 200 ? queueFixture(url.searchParams.has('cursor') ? b : a, url.searchParams.has('cursor') ? null : 'next-synthetic') : { error: { code: 'synthetic_read_failure', message: 'Synthetic failure' } })
    if (path === '/api/platform/step-up') return reply(route, 200, { verified: true })
    const id = path.split('/').at(-1)
    if (details[id]) {
      if (request.method() === 'GET') {
        const observed = structuredClone(details[id]), status = readStatus
        if (readGate) await readGate
        return reply(route, status, status === 200 ? observed : { error: { code: status === 403 ? 'forbidden' : 'synthetic_read_failure', message: 'Synthetic failure' } })
      }
      if (postGate) await postGate
      details[id].revision++
      if (conflict) return reply(route, 409, { error: { code: 'enrollment_revision_conflict', message: 'Enrollment changed. Inspect it again.' } })
      return reply(route, 200, { success: true })
    }
    return reply(route, 404, { error: { code: 'unexpected_synthetic_route', message: path } })
  })
  const visit = async () => { await page.goto(`${origin}/platform/onboarding`); await page.getByRole('heading', { name: 'Trial enrollments', exact: true }).waitFor() }
  const inspect = id => page.getByRole('button', { name: `Inspect enrollment ${id}`, exact: true }).click()
  const section = page.getByRole('region', { name: 'Enrollment detail' })
  const stepUp = async () => { await page.getByLabel('Authenticator code', { exact: true }).fill('123456'); await page.getByRole('button', { name: 'Verify code', exact: true }).click(); await page.getByText('Step-up verified for this draft.', { exact: true }).waitFor() }
  const reason = () => page.getByLabel('Action reason', { exact: true }).fill('Synthetic independent review reason')
  const purchase = () => page.getByLabel('Purchase evidence reference', { exact: true }).fill('purchase-case-123')
  const refreshDetail = () => page.getByRole('button', { name: 'Refresh detail', exact: true }).click()
  let releaseReplacement
  if (process.env.OPERATOR_STRICT_READ === '1') readGate = new Promise(done => { releaseReplacement = done })
  await visit()
  await inspect(a)
  if (process.env.OPERATOR_STRICT_READ === '1') {
    await page.waitForFunction(() => window.operatorRequests.filter(request => /^\/api\/platform\/onboarding\//.test(request.url)).length === 2)
    checks.push('StrictMode setup-cleanup-setup starts a replacement detail read')
    await page.evaluate(() => window.settleAbandonedRead())
    assert.equal(await page.getByRole('button', { name: 'Refresh detail', exact: true }).isDisabled(), true, 'Old finalization cannot clear replacement loading')
    await page.evaluate(() => { window.dispatchEvent(new Event('mca:platform-refresh')); window.dispatchEvent(new Event('mca:platform-refresh')) })
    assert.equal(await page.evaluate(() => window.operatorRequests.filter(request => /^\/api\/platform\/onboarding\//.test(request.url)).length), 2, 'Late abandoned finalization cannot clear the replacement promise/deduplication latch')
    checks.push('late abandoned rejection preserves replacement loading and duplicate-read ownership')
    readGate = null; releaseReplacement()
    await section.getByText('Revision 7', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Review target verification', exact: true }).click()
    await page.getByLabel('Corrected target email', { exact: true }).fill('strict-draft@example.test')
    await reason(); await purchase()
    checks.push('replacement completes and enables explicit action drafts without a mutation')
    readStatus = 500; await refreshDetail()
    await section.getByRole('alert').filter({ hasText: 'Stale diagnostics' }).waitFor()
    assert.equal(await page.getByLabel('Corrected target email', { exact: true }).inputValue(), 'strict-draft@example.test')
    assert.equal(await page.getByRole('button', { name: 'Submit verify target', exact: true }).isDisabled(), true)
    readStatus = 200; await refreshDetail()
    await section.getByText('Revision 7', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Corrected target email', { exact: true }).inputValue(), 'strict-draft@example.test')
    checks.push('StrictMode same-ID failed/successful reads preserve draft and stale action fencing')
    readStatus = 403; await refreshDetail()
    await section.getByText(/Access denied/).waitFor()
    assert.equal(await page.getByLabel('Corrected target email', { exact: true }).count(), 0)
    assert.equal(await section.getByText('Revision 7', { exact: true }).count(), 0)
    assert.equal(actions.length, 0)
    assert.equal(errors.length, 0, errors.join('\n'))
    checks.push('StrictMode denied read clears diagnostics/private draft; zero POSTs or page errors')
    await fs.writeFile(resolve(out, 'strict-read-report.json'), JSON.stringify({ checks, actions, reads, errors }, null, 2))
    console.log(JSON.stringify({ strictReadChecks: checks.length, actions: actions.length, errors }, null, 2))
  } else {
  await section.getByText('Revision 7', { exact: true }).waitFor()
  checks.push('selected detail reads reviewed sanitized DTO; explicit action controls exist')
  if (process.env.OPERATOR_RED === '1') { console.log(JSON.stringify({ checks }, null, 2)); process.exitCode = 0 }
  else {
    assert.equal(actions.length, 0, 'Reading detail never mutates')
    checks.push('GET-only inspection causes no mutation')
    await section.getByText(/unverified transport configuration/).waitFor()
    await section.getByText(/Receipt: accepted/).waitFor()
    await section.getByText(/Original trial ends: 2026-10-16/).waitFor()
    checks.push('original trial, flags, verified target and generation-specific accepted receipt observations')

    await page.getByRole('button', { name: 'Review target verification', exact: true }).click()
    await page.getByLabel('Corrected target email', { exact: true }).fill('corrected@example.test')
    await reason(); await purchase()
    const verifySubmit = page.getByRole('button', { name: 'Submit verify target', exact: true })
    assert.equal(await verifySubmit.isDisabled(), true, 'Step-up is explicit before submitting')
    await stepUp()
    await verifySubmit.click()
    await page.getByText(/Verify target completed/).waitFor()
    assert.deepEqual(actions.at(-1), { path: `/api/platform/onboarding/${a}`, body: { action: 'verify_target', expectedRevision: 7, reason: 'Synthetic independent review reason', correctedEmail: 'corrected@example.test', purchaseEvidence: 'purchase-case-123' } })
    assert.deepEqual(actions.at(-2), { path: '/api/platform/step-up', body: { code: '123456' } })
    await section.getByText('Revision 8', { exact: true }).waitFor()
    checks.push('verify_target exact body, independent purchase reference and explicit same-session MFA')

    await page.getByRole('button', { name: 'Review identity approval', exact: true }).click()
    await reason(); await purchase()
    assert.equal(await page.getByRole('button', { name: 'Submit approve identity', exact: true }).isDisabled(), true, 'Prior target action step-up cannot approve')
    await stepUp()
    await page.getByRole('button', { name: 'Submit approve identity', exact: true }).click()
    await page.getByText(/Approve identity completed/).waitFor()
    assert.deepEqual(actions.at(-1).body, { action: 'approve_identity', expectedRevision: 8, reason: 'Synthetic independent review reason', verifiedProviderUserId: providerUserId, purchaseEvidence: 'purchase-case-123' })
    checks.push('approval uses the inspected normal-email verified provider identity and a new MFA code')

    await page.getByRole('button', { name: 'Review mail evidence', exact: true }).click()
    const messageInput = page.getByLabel('Provider message ID', { exact: true })
    assert.equal(await messageInput.inputValue(), 'message-M1', 'Durable receipt owns M1 even when projection is null')
    assert.equal(await messageInput.getAttribute('readonly'), '', 'Known message cannot be replaced')
    assert.deepEqual(await page.getByLabel('Evidence outcome', { exact: true }).locator('option').allTextContents(), ['accepted', 'delivered'])
    await page.getByLabel('Evidence outcome', { exact: true }).selectOption('delivered')
    await page.getByLabel('Mail evidence reference', { exact: true }).fill('mail-case-123')
    await reason(); await stepUp()
    let releasePost
    postGate = new Promise(done => { releasePost = done })
    const mailActionCount = actions.length
    const mailSubmit = page.getByRole('button', { name: 'Submit record mail evidence', exact: true })
    await mailSubmit.evaluate(button => { button.click(); button.click() })
    await page.getByRole('button', { name: 'Action pending…', exact: true }).waitFor()
    assert.equal(actions.length, mailActionCount + 1, 'Repeated pending submit creates one POST')
    assert.equal(await page.getByRole('button', { name: 'Next 50', exact: true }).isDisabled(), true)
    const pendingReads = reads.length
    await page.getByRole('button', { name: 'Refresh data', exact: true }).click()
    assert.equal(reads.length, pendingReads, 'Shared refresh does not retarget a pending action')
    postGate = null; releasePost()
    await page.getByText(/Record mail evidence completed/).waitFor()
    assert.deepEqual(actions.at(-1).body, { action: 'record_email_evidence', expectedRevision: 9, reason: 'Synthetic independent review reason', emailId, outcome: 'delivered', evidence: 'mail-case-123', provider: 'usesend', providerConfigurationId: 'transport_synthetic', providerMessageId: 'message-M1' })
    checks.push('exact email/configuration/receipt-owned M1 evidence body; positive history and duplicate pending guards')

    await page.getByRole('button', { name: 'Review service email reissue', exact: true }).click()
    await reason(); await purchase()
    assert.equal(await page.getByRole('button', { name: 'Submit reissue service emails', exact: true }).isDisabled(), true)
    await stepUp()
    await page.getByRole('button', { name: 'Submit reissue service emails', exact: true }).click()
    await page.getByText(/Reissue service emails completed/).waitFor()
    assert.deepEqual(actions.at(-1).body, { action: 'reissue_emails', expectedRevision: 10, reason: 'Synthetic independent review reason', purchaseEvidence: 'purchase-case-123' })
    checks.push('explicit reissue has its own purchase reference, inspected revision and new step-up')

    await page.getByRole('button', { name: 'Review target verification', exact: true }).click()
    await page.getByLabel('Corrected target email', { exact: true }).fill('draft@example.test')
    await reason(); await purchase()
    const mutationsBeforeRefresh = actions.length
    await page.getByLabel('Enrollment ID', { exact: true }).fill('filter-draft')
    const beforeManual = reads.length
    await page.getByRole('button', { name: 'Refresh data', exact: true }).click()
    await page.waitForFunction(count => window.operatorRequests.filter(item => item.method === 'GET').length > count, beforeManual)
    await section.getByText('Revision 11', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Corrected target email', { exact: true }).inputValue(), 'draft@example.test')
    assert.equal(await page.getByLabel('Enrollment ID', { exact: true }).inputValue(), 'filter-draft')
    assert.equal(actions.length, mutationsBeforeRefresh)
    checks.push('manual shared refresh preserves filter/action drafts and inspected revision without mutation')

    readStatus = 500
    await refreshDetail()
    await section.getByRole('alert').filter({ hasText: 'Stale diagnostics' }).waitFor()
    assert.equal(await page.getByLabel('Corrected target email', { exact: true }).inputValue(), 'draft@example.test')
    assert.equal(await page.getByRole('button', { name: 'Submit verify target', exact: true }).isDisabled(), true)
    await section.getByText('Revision 11', { exact: true }).waitFor()
    readStatus = 200; await refreshDetail()
    await page.getByRole('button', { name: 'Verify code', exact: true }).waitFor()
    checks.push('same-ID failed detail read retains marked safe diagnostics/draft and disables actions')

    await stepUp(); conflict = true
    await page.getByRole('button', { name: 'Submit verify target', exact: true }).click()
    await section.getByText(/Action rejected \(enrollment_revision_conflict\)/).waitFor()
    await section.getByText('Revision 12', { exact: true }).waitFor()
    await section.getByText(/This draft is stale/).waitFor()
    assert.equal(await page.getByLabel('Corrected target email', { exact: true }).inputValue(), 'draft@example.test')
    assert.equal(await page.getByRole('button', { name: 'Submit verify target', exact: true }).isDisabled(), true)
    const conflictCount = actions.length
    await refreshDetail(); assert.equal(actions.length, conflictCount)
    conflict = false
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click()
    checks.push('409 rereads current revision, keeps the original draft revision and never resubmits')

    // Frozen mail identity can change without an enrollment revision. It must not retarget a draft.
    await page.getByRole('button', { name: 'Review mail evidence', exact: true }).click()
    details[a].emails[0].providerConfigurationId = 'changed-configuration'
    await refreshDetail(); await section.getByText(/This draft is stale/).waitFor()
    await section.getByText(/Inspected mail .*transport_synthetic/).waitFor()
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click()
    checks.push('mail identity refresh cannot replace the captured configuration or durable message ownership')

    details[a].runtime.runtimeEnabled = false
    await refreshDetail(); await section.getByText(/Runtime disabled: retained diagnostics/).waitFor()
    for (const name of ['Review target verification', 'Review identity approval', 'Review mail evidence', 'Review service email reissue']) assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true)
    checks.push('runtime-off diagnostics stay readable while every mutation control is disabled')
    details[a].runtime.runtimeEnabled = true; await refreshDetail()
    await page.getByRole('button', { name: 'Review target verification', exact: true }).click()
    await page.getByLabel('Corrected target email', { exact: true }).fill('private-draft@example.test')
    readStatus = 403; await refreshDetail()
    await section.getByText(/Access denied/).waitFor()
    assert.equal(await section.getByText('Revision 12', { exact: true }).count(), 0)
    assert.equal(await page.getByLabel('Corrected target email', { exact: true }).count(), 0)
    checks.push('denied detail read discards diagnostics, proof/code and draft instead of retaining stale data')
    readStatus = 200; await refreshDetail()

    queueStatus = 500
    await page.getByRole('button', { name: 'Refresh queue', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Stale snapshot' }).waitFor()
    await section.getByText(/Queue access or freshness changed/).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Review target verification', exact: true }).isDisabled(), true)
    queueStatus = 200; await page.getByRole('button', { name: 'Refresh queue', exact: true }).click()
    await page.getByRole('button', { name: 'Next 50', exact: true }).click()
    await inspect(b); await section.getByText('Revision 7', { exact: true }).waitFor()
    assert.equal(await section.getByText(a, { exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Review target verification', exact: true }).click()
    await page.getByLabel('Corrected target email', { exact: true }).fill('other-enrollment@example.test')
    await page.getByRole('button', { name: 'First page', exact: true }).click()
    assert.equal(await section.count(), 0)
    await inspect(a); await section.getByText('Revision 12', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Corrected target email', { exact: true }).count(), 0)
    await page.getByLabel('Enrollment ID', { exact: true }).fill(a)
    await page.getByLabel('State', { exact: true }).selectOption('mail_uncertain')
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
    assert.equal(await section.count(), 0)
    await inspect(a)
    assert.ok(reads.some(url => url.includes(`enrollmentId=${a}`) && url.includes('state=mail_uncertain') && !url.includes('cursor=')))
    checks.push('queue stale disables recovery; pagination/filter/selected-ID changes discard unrelated detail/drafts')

    // An obsolete selected-ID response must not populate the replacement detail.
    let releaseRead
    readGate = new Promise(done => { releaseRead = done })
    await refreshDetail()
    await page.getByRole('button', { name: 'Next 50', exact: true }).click()
    await inspect(b)
    readGate = null; releaseRead()
    await section.getByText(b, { exact: true }).waitFor()
    await section.getByText('Revision 7', { exact: true }).waitFor()
    assert.equal(await section.getByText(a, { exact: true }).count(), 0)
    checks.push('selected-ID abort suppresses an obsolete detail response')

    const countReads = () => reads.length
    let tick = countReads()
    await page.clock.runFor(30_001)
    await page.waitForFunction(count => window.operatorRequests.filter(item => item.method === 'GET').length > count, tick)
    assert.equal(countReads() - tick, 2, 'One shared tick rereads queue and selected detail once each')
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
    tick = countReads(); await page.clock.runFor(60_001); assert.equal(countReads(), tick)
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
    await page.waitForFunction(count => window.operatorRequests.filter(item => item.method === 'GET').length > count, tick)
    assert.equal(countReads() - tick, 2)
    checks.push('existing single 30-second visible-tab clock refreshes queue/detail; hidden tab pauses; visibility resumes')

    queueStatus = 403
    await page.getByRole('button', { name: 'Refresh queue', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Access denied' }).waitFor()
    assert.equal(await section.count(), 0)
    assert.equal(await page.getByRole('button', { name: `Inspect enrollment ${b}`, exact: true }).count(), 0)
    checks.push('denied queue discards retained rows and selected detail')
    const requests = await page.evaluate(() => window.operatorRequests)
    assert.ok(requests.every(request => request.cache === 'no-store' && request.credentials === 'same-origin'))
    assert.ok(actions.every(action => action.path === '/api/platform/step-up' || action.path === `/api/platform/onboarding/${a}`))
    checks.push('all reads/actions use no-store and same-origin credentials; only reviewed explicit POST endpoints')

    // Light/dark and narrow/wide rendering use the actual page/components, not a copied layout.
    for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      queueStatus = readStatus = 200
      const visual = await context.newPage()
      visual.on('pageerror', error => errors.push(error.message))
      await visual.setViewportSize({ width, height: 1000 })
      await visual.route('**/api/**', route => { const path = new URL(route.request().url()).pathname; return reply(route, 200, path === '/api/platform/onboarding' ? queueFixture(a) : detailFixture(a)) })
      await visual.goto(`${origin}/platform/onboarding?theme=${theme}`)
      await visual.getByRole('button', { name: `Inspect enrollment ${a}`, exact: true }).click()
      await visual.getByRole('region', { name: 'Enrollment detail' }).getByText('Revision 7', { exact: true }).waitFor()
      await visual.getByRole('button', { name: 'Review target verification', exact: true }).click()
      await visual.getByLabel('Corrected target email', { exact: true }).focus()
      assert.equal(await visual.evaluate(() => document.activeElement?.getAttribute('type')), 'email')
      await visual.keyboard.press('Tab')
      assert.equal(await visual.evaluate(() => document.activeElement?.tagName === 'BODY'), false)
      assert.equal(await visual.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `No page overflow at ${width} ${theme}`)
      await visual.screenshot({ path: resolve(out, `${width}-${theme}.png`), fullPage: true })
      await visual.close()
      checks.push(`${width} ${theme}: actual detail/action labels, keyboard focus and no horizontal page overflow`)
    }
    assert.equal(errors.length, 0, errors.join('\n'))
    await fs.writeFile(resolve(out, 'report.json'), JSON.stringify({ checks, actions, reads, errors }, null, 2))
    console.log(JSON.stringify({ checks: checks.length, actions: actions.length, errors }, null, 2))
  }
  }
} catch (error) {
  await fs.writeFile(resolve(out, 'failed-report.json'), JSON.stringify({ checks, actions, reads, errors, failure: String(error) }, null, 2))
  console.log(JSON.stringify({ completedChecks: checks, failure: String(error) }, null, 2))
  throw error
} finally { if (browser) await browser.close(); await new Promise(done => server.close(done)) }
