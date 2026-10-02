import * as React from "react"
import { createRoot } from "react-dom/client"
import { MobileNav } from "../../../src/components/marketing/mobile-nav"
import { SignInForm } from "../../../src/app/(auth)/sign-in/sign-in-form"
import { TrialCheckoutStart } from "../../../src/components/marketing/trial-checkout-start"
import { EnrollmentCompletion } from "../../../src/components/mca/onboarding/enrollment-completion"
import CompanyOnboarding from "../../../src/components/mca/auth/company-onboarding"
import { GettingStartedChecklist } from "../../../src/components/mca/onboarding/getting-started-checklist"
import { BusinessDetailsForm } from "../../../src/components/mca/onboarding/business-details-form"
import { HomeWorkspace } from "../../../src/components/mca/home/home-workspace"
import { NewDealProvider } from "../../../src/components/mca/deals/new-deal-provider"
import type { HomeKpis } from "../../../src/lib/mca/home/kpi-contracts"

const kpis: HomeKpis = { timezone: "UTC", asOf: "2026-10-01T00:00:00Z", period: "mtd", pipeline: {count:0,volumeDollars:0,dollarsHidden:false},newDeals:{count:0},renewals:{count:0},funded:{amountCents:0,count:0,dollarsHidden:false},commission:{amountCents:0,count:0,dollarsHidden:false},activeMerchants:{count:0},approvalRate:{numerator:0,denominator:0,rate:null},collectionsToday:{expectedCents:0,receivedCents:0,dollarsHidden:false,source:"accounting_payments"},empty:true,series:{fundedByMonth:[],pipelineByMonth:[],approvalByMonth:[],collectionsByDay:[],revenueBreakdown:[],recentActivity:[],topFunders:[],merchantGrowth:[],industries:[],states:[]} }

const params = new URL(location.href).searchParams
const screen = params.get("screen") ?? "enrollment"
const continuation = { enrollmentId: "11111111-1111-4111-8111-111111111111", destination: "business" as const, generation: 3 }
createRoot(document.getElementById("root")!).render(screen === "dashboard" ? <NewDealProvider><HomeWorkspace firstName="Synthetic" canCreateDeal initialKpis={kpis} initialSetup={{dismissed:true,dismissedAt:"2026-10-01",steps:[],completedCount:0,totalCount:0,allComplete:false,nextStep:null}} {...{progressiveSetup:true,trialEndsAt:"2026-10-15T18:30:00Z"}} /></NewDealProvider> : screen === "legacy" ? <CompanyOnboarding /> : <main style={{ padding: 24, maxWidth: 640, margin: "0 auto" }}>
  {screen === "login" ? <SignInForm magicLinkEnabled /> : screen === "start" ? <TrialCheckoutStart available /> : screen === "mobile" ? <MobileNav showPricing showTrialCta /> : screen === "setup" ? <><GettingStartedChecklist /><BusinessDetailsForm /></> : <EnrollmentCompletion continuation={continuation} supportEmail="support@example.test" />}
</main>)
