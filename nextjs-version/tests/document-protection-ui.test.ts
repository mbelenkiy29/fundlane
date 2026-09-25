import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

function renderMarkup(source: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", source], {
    encoding: "utf8",
    cwd: process.cwd(),
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test("Connections settings mounts document protection", () => {
  const html = renderMarkup(`
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const ConnectionSettings = require('./src/app/(dashboard)/settings/connections/page.tsx').default;
    console.log(renderToStaticMarkup(React.createElement(ConnectionSettings)));
  `)
  assert.match(html, /Document protection/)
  assert.match(html, /Stamp outgoing bank statements/)
})

test("Document protection panel exposes the workspace toggle while loading settings", () => {
  const html = renderMarkup(`
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { DocumentProtectionPanel } = require('./src/components/mca/submissions/document-protection-panel.tsx');
    console.log(renderToStaticMarkup(React.createElement(DocumentProtectionPanel)));
  `)
  assert.match(html, /Document protection/)
  assert.match(html, /Loading document protection/)
})

test("Rep preview button names the statement and destination funder", () => {
  const html = renderMarkup(`
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { StampedCopyPreviewButton, stampedCopyPreviewLabel } = require('./src/components/mca/submissions/selection-panel.tsx');
    console.log(stampedCopyPreviewLabel('January statement.pdf', 'Harbor'));
    console.log(renderToStaticMarkup(React.createElement(StampedCopyPreviewButton, {
      filename: 'January statement.pdf',
      funderName: 'Harbor',
      onClick: () => {},
    })));
  `)
  assert.match(html, /Preview stamped copy of January statement\.pdf for Harbor/)
  assert.match(html, />Preview stamped copy</)
})
