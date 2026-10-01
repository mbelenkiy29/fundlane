const base = {provider:'fundlane',formId:'fundlane',clientName:'Synthetic bakery',employeeName:'Test representative',contactEmail:'merchant@example.test',submitted:false,expiresAt:'2099-01-01T00:00:00Z',step:'legalName',answers:{legalName:'Synthetic bakery'},files:[],requiredStatementMonths:1,branding:{accent:'#2563eb',welcomeTitle:'Synthetic branded application',welcomeBody:'Business details and bank statements.',thankYouTitle:'Application received',optionalFields:{driversLicense:true}}};
let saved = JSON.parse(JSON.stringify(base)), saves=0, submits=0, failSave=false, failLoad=false, failUpload=false;
const readyFile={id:'synthetic-ready',category:'statement',filename:'statement.pdf',processingState:'ready',byteLength:20,createdAt:'2026-01-01'};
const blockedFile={...readyFile,id:'blocked',filename:'x'.repeat(160)+'.pdf',processingState:'quarantined'};
await page.route('**/api/applications/**',async route=>{
 const req=route.request(), url=new URL(req.url());
 if(url.pathname.endsWith('/track')) return route.fulfill({json:{}});
 if(url.pathname.endsWith('/submit')) {submits++;return route.fulfill({json:{...saved,submitted:true}})}
 if(url.pathname.endsWith('/files')) {saved.files.push(failUpload?blockedFile:readyFile);return route.fulfill({status:failUpload?422:200,json:failUpload?{error:{message:'Upload a different document.'}}:saved})}
 if(req.method()==='GET') return route.fulfill({status:failLoad?410:200,json:failLoad?{error:{message:'This application link is no longer active.'}}:saved});
 saves++;
 if(failSave) return route.fulfill({status:503,json:{error:{message:'Synthetic save failed.'}}});
 const body=req.postDataJSON(); saved={...saved,step:body.step,answers:body.answers};return route.fulfill({json:saved});
});
const open=async fixture=>{saved={...JSON.parse(JSON.stringify(base)),...fixture};await page.goto('http://127.0.0.1:55413/?fixture='+encodeURIComponent(JSON.stringify(fixture||{})))};
const assert= (test, message)=>{if(!test) throw new Error(message)};
for(const width of [390,768]){
 await page.setViewportSize({width,height:900});
 await open({});await page.getByLabel('Legal business name').fill('Saved synthetic bakery');await page.getByRole('button',{name:'Save and exit',exact:true}).click();
 await page.getByRole('heading',{name:'Your progress is saved'}).waitFor();assert(saved.answers.legalName==='Saved synthetic bakery','Save did not persist partial answers');
 await page.getByRole('button',{name:'Resume application',exact:true}).click();assert(await page.getByLabel('Legal business name').inputValue()==='Saved synthetic bakery','Local resume lost answers');
 await page.goto('http://127.0.0.1:55413/?public');await page.getByLabel('Legal business name').waitFor();assert(await page.getByLabel('Legal business name').inputValue()==='Saved synthetic bakery','Fresh session resume lost answers');
 await page.screenshot({path:'output/playwright/t12/resume-'+width+'.png',fullPage:true});
 // Visibility lifecycle must not launch an unsequenced write.
 await page.getByLabel('Legal business name').fill('Unsaved newer name');const before=saves;await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pagehide'))});await page.waitForTimeout(100);assert(saves===before,'Unsequenced lifecycle write can overwrite a newer draft');
 await open({step:'owners',answers:{owners:[{firstName:'Ada',lastName:'Chen',ownershipPercent:0},{firstName:'Bob',lastName:'Smith',ownershipPercent:100}]}});
 await page.getByLabel('Ownership %').first().fill('');await page.getByLabel('Ownership %').first().pressSequentially('33.3');assert(await page.getByLabel('Ownership %').first().inputValue()==='33.3','Decimal lost');await page.getByRole('button',{name:'Remove owner 2'}).click();assert(await page.getByLabel('First name').count()===1,'Owner removal failed');
 await open({step:'monthlyRevenue',answers:{monthlyRevenue:1}});await page.getByLabel('Monthly deposits').fill('');await page.getByLabel('Monthly deposits').pressSequentially('123.45');assert(await page.getByLabel('Monthly deposits').inputValue()==='123.45','Money decimal lost');
 await open({step:'review',files:[readyFile],answers:{legalName:'Synthetic bakery'}});failSave=true;const sent=submits;await page.getByRole('button',{name:'Submit application',exact:true}).click();await page.getByRole('alert').waitFor();assert(submits===sent,'Failed save still submitted');assert((await page.getByRole('alert').innerText()).includes('Synthetic save failed'),'Save error hidden');failSave=false;
 await open({step:'statements',files:[blockedFile]});await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('alert').waitFor();assert((await page.getByRole('status').first().innerText()).includes('0 of 1'),'Blocked file counted');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile overflow for long file name');await page.screenshot({path:'output/playwright/t12/quarantine-'+width+'.png',fullPage:true});
 await open({step:'review',files:[readyFile,blockedFile]});assert(await page.getByRole('button',{name:'Submit application',exact:true}).isDisabled(),'Quarantined file enabled submit');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile review overflow');
 await open({step:'statements',answers:{legalName:'Unsaved local name'}});saved.answers={legalName:'Old server name'};failUpload=true;await page.locator('input[type=file]').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 synthetic')});await page.getByRole('alert').waitFor();assert((await page.getByRole('alert').innerText()).includes('contact your representative'),'Blocked upload guidance misleading');assert(await page.getByText(blockedFile.filename,{exact:false}).count()>0,'Persisted quarantine omitted');failUpload=false;
 await page.getByRole('button',{name:'Save and exit',exact:true}).click();await page.getByRole('heading',{name:'Your progress is saved'}).waitFor();assert(saved.answers.legalName==='Unsaved local name','Upload erased unsaved draft');
 failLoad=true;await page.goto('http://127.0.0.1:55413/?public');await page.getByRole('alert').waitFor();assert(await page.getByRole('button',{name:'Start application',exact:true}).count()===0,'Inactive session offered fresh start');failLoad=false;
}
console.log('T12 browser scenarios PASS at 390 and 768: save/resume, lifecycle write suppression, decimals, owners, failed save, quarantine, upload draft preservation, inactive load and overflow.');
