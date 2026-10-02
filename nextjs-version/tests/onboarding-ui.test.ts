import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
function render(component: string, name: string, props: unknown) {
  const script = `const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');let mod;try{mod=require(${JSON.stringify(component)})}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}const requests=[];global.fetch=async (...args)=>{requests.push(args);throw Error('render must not send')};console.log(JSON.stringify({missing:!mod?.[${JSON.stringify(name)}],html:mod?.[${JSON.stringify(name)}]?renderToStaticMarkup(React.createElement(mod[${JSON.stringify(name)}],${JSON.stringify(props)})):'',requests}));`
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '-e', script], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' })) as { missing: boolean; html: string; requests: unknown[] }
}
test('saved business form renders accessible labels and EIN-present replacement without raw EIN', () => {
  const result = render('./src/components/mca/onboarding/business-details-form.tsx', 'BusinessDetailsForm', { initialBasics: { legalName: 'Saved Company', einPresent: true, revision: 2, registered: false } })
  assert.equal(result.missing, false); assert.match(result.html, /Saved Company/); assert.match(result.html, /for="business-legal-name"/); assert.match(result.html, /EIN supplied/); assert.match(result.html, /Replace EIN/); assert.doesNotMatch(result.html, /name="ein"/); assert.deepEqual(result.requests, [])
})
test('dismissed checklist is resumable from getting-started without render-triggered side effects', () => {
  const result = render('./src/components/mca/onboarding/getting-started-checklist.tsx', 'GettingStartedChecklist', { initialSetup: { dismissed: true, dismissedAt: '2026-01-01', steps: [], completedCount: 0, totalCount: 0, allComplete: false, nextStep: null } })
  assert.equal(result.missing, false); assert.match(result.html, /Resume checklist/); assert.deepEqual(result.requests, [])
})
