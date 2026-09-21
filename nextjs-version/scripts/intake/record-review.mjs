// Real application components with controlled API fixtures; no external deliveries.
// MCA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/intake/record-review.mjs
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {build} from 'esbuild'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

const output = 'output/playwright/application-review'
await mkdir(output,{recursive:true})
const {chromium}=await import(process.env.MCA_PLAYWRIGHT_MODULE || 'playwright')
const bundle=await build({stdin:{contents:`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ApplicationReviewWorkspace} from './src/components/mca/intake/application-review';
import {CreditNotificationBell} from './src/components/mca/assistant/notification-bell';
createRoot(document.getElementById('root')).render(<>
<header style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'16px 32px',borderBottom:'1px solid #ddd'}}><strong>Fundlane · application review</strong><span style={{fontSize:12,color:'#666'}}>Recorded test · synthetic data</span><CreditNotificationBell canManage={true}/></header>
{location.pathname.startsWith('/intake/') ? <ApplicationReviewWorkspace intakeId="test"/> : <main style={{padding:64}}><h1 style={{fontSize:28,fontWeight:600}}>Applications</h1><p style={{marginTop:16,color:'#666'}}>Your application notifications appear in the bell above.</p></main>}</>);
`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},plugins:[{name:'test-navigation',setup(b){b.onResolve({filter:/^next\/navigation$/},()=>({path:'navigation',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const useRouter=()=>({push:(url)=>location.assign(url)});'}))}}]})
const css=await postcss([tailwind()]).process(await readFile('src/app/globals.css','utf8'),{from:'src/app/globals.css'})
const server=createServer((req,res)=>{
 res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':req.url==='/app.css'?'text/css':'text/html')
 res.end(req.url==='/app.js'?bundle.outputFiles[0].text:req.url==='/app.css'?css.css:'<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="--font-inter:Arial,sans-serif"><div id="root"></div><script src="/app.js"></script></body></html>')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({channel:process.env.MCA_BROWSER_CHANNEL || 'chrome',headless:true})
const context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:output,size:{width:1440,height:1000}}})
await context.tracing.start({screenshots:true,snapshots:true,sources:true})
const page=await context.newPage()
const errors=[]
page.on('pageerror',error=>errors.push(error.message))
let arrived=false,read=false,sends=0,prepares=0
const now=new Date().toISOString()
const documents=['Unsigned application.pdf','June statement.pdf','July statement.pdf','August statement.pdf'].map((name,i)=>({id:`doc${i}`,displayFilename:name,originalFilename:name,category:i?'statement':'application',processingState:'clean'}))
const review={intakeId:'test',dealId:'deal',merchantName:'Harbor Café',receivedAt:now,provider:'native',originalAnswersAvailable:true,
 answers:[{key:'legalName',label:'Business name',value:'Harbor Café LLC'},{key:'purpose',label:'What will the funding be used for?',value:'Second espresso machine and outdoor seating'},{key:'requestedAmount',label:'Requested funding',value:'$50,000'},{key:'monthlyRevenue',label:'Reported monthly revenue',value:'$42,000'},{key:'ein',label:'Business tax identifier',value:'••••'}],documents,
 progress:{state:'running',stages:{deal:{state:'complete'},documents:{state:'complete'},underwriting:{state:'running'},matches:{state:'queued'}}},
 summary:{reportedMonthlyRevenue:42000,statementMonthlyRevenue:null,industry:'Restaurant / café',requestedAmount:50000,warnings:[],missing:[],stale:false,analyzedAt:null},
 candidates:[],canPrepare:false,canRetry:false,jobs:[]}
const candidates=[{id:'email',name:'Demo Capital',rank:1,score:94,grade:'A',eligible:true,reasons:['Revenue and time in business meet requirements.','No negative-balance days in reviewed statements.']},{id:'portal',name:'Demo Funding Portal',rank:2,score:87,grade:'B',eligible:true,reasons:['Requested amount fits this lender’s range.','Manual portal completion required.']}]
await context.route('**/api/**',async route=>{
 const url=route.request().url();let body=review
 if(url.endsWith('/intake/notifications')) {
  if(route.request().method()==='POST') read=true
  body={unread:arrived&&!read?1:0,notifications:arrived?[{id:'notice',intakeId:'test',merchantName:review.merchantName,state:review.progress.state,createdAt:now,readAt:read?now:null}]:[]}
 } else if(url.endsWith('/assistant/notifications')) body={unread:0,notifications:[{id:'credit',workspaceId:'demo',kind:'low',userName:'Demo representative',companyName:'Demo company',total:12,resetAt:now,userId:'rep',readAt:now,emailState:'sent'}]}
 else if(url.endsWith('/preview')) {prepares++;assert.deepEqual(route.request().postDataJSON().funderIds,['email','portal']);body={id:'preview',expiresAt:new Date(Date.now()+600000).toISOString(),destinations:candidates.map(c=>({funderId:c.id,name:c.name,method:c.id==='email'?'email':'manual_portal',destination:c.id==='email'?'controlled-lender@example.test':'https://portal.example.test',documents:documents.map(d=>({id:d.id,filename:d.displayFilename})),...(c.id==='email'?{email:{from:'rep@example.test',to:['controlled-lender@example.test'],cc:[],replyTo:'rep@example.test',subject:'Harbor Café LLC — $50,000 funding request',body:'Please review Harbor Café LLC for $50,000 in funding.\nStatement-derived monthly revenue: $40,850.\nAttached: unsigned application and three bank statements.'}}:{}),errors:[]}))}}
 else if(url.endsWith('/send')) {sends++;assert.equal(route.request().postDataJSON().previewId,'preview');review.jobs=[{jobId:'email-job',displayFunderName:'Demo Capital',state:'sent'},{jobId:'portal-job',displayFunderName:'Demo Funding Portal',state:'pending_portal'}];body={ok:true,jobs:review.jobs.map((j,i)=>({...j,funderId:candidates[i].id}))}}
 return route.fulfill({json:body})
})
const chapters=[]
const started=Date.now()
async function pause(label,ms=2500){chapters.push({seconds:Math.round((Date.now()-started)/1000),label});await page.waitForTimeout(ms)}
try {
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.getByRole('button',{name:'Notifications',exact:true}).waitFor()
 await pause('Applications before receipt')
 arrived=true
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
 await page.getByRole('button',{name:'Notifications, 1 unread'}).waitFor()
 await pause('New application unread badge')
 await page.getByRole('button',{name:'Notifications, 1 unread'}).click()
 await page.getByText('Application received — Harbor Café',{exact:true}).waitFor()
 await page.screenshot({path:`${output}/notification.png`,animations:"disabled"})
 await pause('Notification pop-up; existing credit alert preserved',4000)
 await page.getByRole('link',{name:'Review application'}).click()
 await page.getByRole('heading',{name:'Harbor Café',exact:true}).waitFor()
 assert.equal(read,true)
 await page.getByText('Processing',{exact:true}).waitFor()
 await pause('Application opens; statement analysis in progress',3500)
 review.progress={state:'ready_for_review',stages:Object.fromEntries(['deal','documents','underwriting','matches'].map(k=>[k,{state:'complete'}]))}
 review.summary.statementMonthlyRevenue=40850;review.summary.analyzedAt=now;review.candidates=candidates;review.canPrepare=true
 await page.getByRole('button',{name:'Refresh',exact:true}).click()
 await page.getByText('Ready for review',{exact:true}).waitFor()
 assert.equal(await page.getByRole('checkbox').count(),2)
 assert.equal(await page.getByRole('checkbox').first().isChecked(),false)
 assert.equal(await page.getByRole('button',{name:/Prepare/}).isDisabled(),true)
 await page.screenshot({path:`${output}/review.png`,fullPage:true})
 await pause('Original answers, multiple statements, distinct reported and derived revenue',5000)
 await page.getByRole('checkbox').nth(0).check();await page.getByRole('checkbox').nth(1).check()
 await pause('Representative selects lenders')
 await page.getByRole('button',{name:/Prepare/}).click()
 await page.getByRole('heading',{name:'Submission preview'}).waitFor()
 assert.equal(sends,0);assert.equal(prepares,1)
 await page.getByRole('heading',{name:'Submission preview'}).scrollIntoViewIfNeeded()
 await page.screenshot({path:`${output}/preview.png`,fullPage:true})
 await pause('Preview destinations, exact attachments and email; nothing sent',6000)
 await page.getByRole('button',{name:'Send approved submissions'}).scrollIntoViewIfNeeded()
 await pause('Explicit Send is required',3000)
 await page.getByRole('button',{name:'Send approved submissions'}).click()
 await page.getByRole('heading',{name:'Submission status'}).waitFor()
 await page.getByRole('heading',{name:'Submission status'}).scrollIntoViewIfNeeded()
 await page.getByRole('link',{name:'Complete portal submission in deal'}).waitFor()
 assert.equal(sends,1)
 await page.screenshot({path:`${output}/results.png`,fullPage:true})
 await pause('Per-lender results; portal still requires manual completion',5000)
 await page.evaluate(()=>window.scrollTo(0,0))
 await page.getByRole('button',{name:'Notifications',exact:true}).click()
 await page.getByText('Application received — Harbor Café',{exact:true}).waitFor()
 assert.equal(await page.getByText('Application received — Harbor Café',{exact:true}).count(),1)
 await pause('Same notification updated and marked read',4000)
 await page.keyboard.press('Escape')
 await page.setViewportSize({width:390,height:844})
 await page.screenshot({path:`${output}/mobile.png`,fullPage:true})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 await pause('Mobile layout stacks the review columns',3000)
 await page.getByText('AI analysis summary',{exact:true}).scrollIntoViewIfNeeded()
 await pause('Mobile analysis and lender controls',3000)
 assert.deepEqual(errors,[])
 await writeFile(`${output}/chapters.json`,JSON.stringify(chapters,null,2))
 await writeFile(`${output}/browser-results.json`,JSON.stringify({passed:true,prepares,sends,read,consoleErrors:errors,scope:'Real review and notification components; synthetic API responses. Database integration tests run separately.'},null,2))
 console.log('PASS: notification arrival/pop-up/read/status, processing, review, unchecked lenders, preview without send, explicit send, manual portal, mobile layout.')
} finally {
 await context.tracing.stop({path:`${output}/trace.zip`})
 await context.close()
 await page.video().saveAs(`${output}/walkthrough.webm`)
 await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
}
