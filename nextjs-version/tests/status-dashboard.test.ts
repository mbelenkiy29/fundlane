import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

// Use the project's server-rendering pattern; isolate client React from react-server.
function runDashboard(script: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { StatusDashboard } = require('./src/components/mca/operations/status-dashboard.tsx');
    const now = new Date().toISOString();
    const status = {
      asOf: now, startedAt: now, window: '24h', stale: false,
      latest: { checked_at: now, website_ok: true, database_ok: true, website_ms: 17, database_ms: 23, deployment: null,
        metrics: { queued: 0, running: 0, failed: 0, retrying: 0, billingRetrying: 0, expired: 0, oldestSeconds: 0,
          emailQueued: 0, emailAccepted: 0, emailFailed: 0, emailBlocked: 0, emailUnknown: 0, reconnect: 0,
          recentEmailFailures: 0, recentErrors: 0, documentWorkerHeartbeatAgeSeconds: 1, documentFailed: 0, scannerUnavailable: 0 } },
      observedAvailability: 1, samples: 1, errors: 0, companies: 1, newCompanies: 0, activeUsers: 0,
      invitations: 0, submitted: 0, health: [], usage: [], incidents: [],
      jobKinds: [{ kind: 'document_scan', queued: 0, running: 0, failures: 2, oldestPendingAt: null, oldestPendingSeconds: null, lastSuccessAt: null }],
      emailRuntime: { queued: 0, oldestQueuedSeconds: null, expiredSenders: 0, revokedSenders: 0, syncFailures: 0,
        staleSyncs: 0, lastCompletedAt: now, lastStartedAt: now },
    };
    const render = preview => renderToStaticMarkup(React.createElement(StatusDashboard, { preview }));
    ${script}
  `], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as string[]
}

function section(html: string, heading: string) {
  return html.split("<section").find(part => part.includes(`>${heading}</h2>`)) ?? ""
}

test("stale health makes sampled response times and queue counts unavailable", () => {
  const [html] = runDashboard("console.log(JSON.stringify([render({ ...status, stale: true })]));")
  assert.match(html, /<strong>Unavailable<\/strong>/)
  for (const heading of ["Website response", "Database response", "Background jobs", "Email delivery"]) {
    assert.match(section(html, heading), /Unavailable/)
  }
  assert.doesNotMatch(section(html, "Website response"), /17 ms/)
  assert.doesNotMatch(section(html, "Database response"), /23 ms/)
  assert.doesNotMatch(section(html, "Background jobs"), />0<|>0 min</)
  assert.match(section(html, "Jobs by kind"), /document_scan/)
})

test("missing health or queue metrics is explicitly unavailable, never healthy", () => {
  const pages = runDashboard(`console.log(JSON.stringify([
    render({ ...status, latest: null, stale: true }),
    render({ ...status, latest: { ...status.latest, metrics: null } })
  ]));`)
  for (const html of pages) {
    assert.match(html, /<strong>Unavailable<\/strong>/)
    assert.match(section(html, "Background jobs"), /Unavailable/)
  }
})

test("failed refresh discards a previously successful status and error history", () => {
  const [before, after] = runDashboard(`
    // Drive this component's hooks without a browser; nested UI renders with real React.
    const original = { useState: React.useState, useEffect: React.useEffect, useCallback: React.useCallback, useRef: React.useRef };
    const state = []; let cursor = 0;
    function tree() {
      cursor = 0;
      React.useState = initial => { const i = cursor++; if (!(i in state)) state[i] = initial;
        return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; };
      React.useEffect = () => {};
      React.useCallback = fn => fn;
      React.useRef = initial => { const i=cursor++; if (!(i in state)) state[i]={current:initial}; return state[i]; };
      try { return StatusDashboard({}); } finally { Object.assign(React, original); }
    }
    function refresh(node) {
      if (!node || typeof node !== 'object') return;
      if (node.props?.children === 'Refresh') return node.props.onClick;
      for (const child of React.Children.toArray(node.props?.children)) {
        const found = refresh(child); if (found) return found;
      }
    }
    (async () => {
      global.fetch = async url => Response.json(String(url).includes('/errors?')
        ? { errors: [{ id: 'global-error', occurred_at: now, component: 'api', code: 'internal_error', route: '/api/deals/*', correlation_id: 'trace-global', deployment: null }], next: 'global-error' }
        : status);
      refresh(tree())(); await new Promise(resolve => setImmediate(resolve));
      const before = renderToStaticMarkup(tree());
      global.fetch = async () => { throw new Error('offline'); };
      refresh(tree())(); await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify([before, renderToStaticMarkup(tree())]));
    })();
  `)
  assert.match(before, /<strong>Healthy<\/strong>/)
  assert.match(before, /trace-global/)
  assert.match(before, /document_scan/)
  assert.match(after, /<strong>Unavailable<\/strong>/)
  assert.doesNotMatch(after, /document_scan|trace-global|Last completed tick|17 ms|23 ms|Load older errors/)
  assert.match(section(after, "Open incidents and alert delivery"), /Unavailable/)
  assert.match(section(after, "Recent errors"), /Error history unavailable/)
})


test("initial status does not claim an empty error history and labels global scope", () => {
  const [html] = runDashboard("console.log(JSON.stringify([renderToStaticMarkup(React.createElement(StatusDashboard))]));")
  assert.match(section(html, "Recent errors"), /Error history unavailable/)
  assert.match(section(html, "Recent errors"), /company attribution unavailable/)
})


test("missing response measurements are unavailable without a fabricated unit", () => {
  const [html] = runDashboard("console.log(JSON.stringify([render({ ...status, latest: { ...status.latest, website_ms: null, database_ms: null } })]));")
  for (const heading of ["Website response", "Database response"]) {
    assert.match(section(html, heading), />Unavailable</)
    assert.doesNotMatch(section(html, heading), /Unavailable ms/)
  }
})
