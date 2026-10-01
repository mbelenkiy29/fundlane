import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { FunnelForm } from '../../../src/components/mca/applications/funnel-form'
import type { ApplicationSession } from '../../../src/lib/mca/applications/contracts'
import { PublicApplication } from '../../../src/components/mca/applications/public-application'
const session = {
 provider:'fundlane',formId:'fundlane',clientName:'Synthetic bakery',employeeName:'Test representative',contactEmail:'merchant@example.test',submitted:false,expiresAt:'2099-01-01T00:00:00Z',step:'legalName',answers:{legalName:'Synthetic bakery'},files:[],requiredStatementMonths:1,
 branding:{accent:'#2563eb',welcomeTitle:'Synthetic branded application',welcomeBody:'Business details and bank statements.',thankYouTitle:'Application received',optionalFields:{driversLicense:true}},
 ...JSON.parse(new URL(location.href).searchParams.get('fixture')||'{}')
}
createRoot(document.getElementById('root')!).render(<main className="min-h-screen bg-muted/30 px-4 py-10"><div className="mx-auto max-w-5xl">{new URL(location.href).searchParams.has('public') ? <PublicApplication token={'a'.repeat(43)} formId="fundlane" provider="fundlane"/> : <FunnelForm token={'a'.repeat(43)} initial={session as ApplicationSession}/>}</div></main>)
