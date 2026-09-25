import { NextResponse } from "next/server"
import { z } from "zod"
import { completeCompanyOnboarding, listSupabaseWorkspaces, setActiveWorkspace, supabaseIdentity } from "@/lib/mca/supabase-auth"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { readJson } from "@/lib/mca/http"
import { billingEnabled, billingTrialDays, createBillingCheckout, isStripeCheckoutTrialConfigured } from "@/lib/mca/billing"
import { getCompanyAccess } from "@/lib/mca/company-access"
import { getDatabase } from "@/lib/mca/db"
import { apiError, AppError } from "@/lib/mca/errors"
export async function GET() {
  try {
    const identity=await supabaseIdentity({ allowPasswordSetup:true })
    if (!identity) return NextResponse.json({ authenticated:false,workspaces:[] },{ headers:{ "Cache-Control":"no-store" } })
    const cardRequiredTrial=isStripeCheckoutTrialConfigured()
    return NextResponse.json({ authenticated:true,passwordSetupRequired:identity.user.app_metadata.mca_migration_pending === true,workspaces:await listSupabaseWorkspaces(identity),companyName:typeof identity.user.user_metadata.companyName === "string" ? identity.user.user_metadata.companyName : "",cardRequiredTrial,...(cardRequiredTrial?{trialDays:billingTrialDays()}:{}) },{ headers:{ "Cache-Control":"no-store" } })
  } catch(error) { return apiError(error) }
}
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const input=await readJson(request,z.union([z.object({ workspaceId:z.uuid() }),z.object({ name:z.string().trim().min(2).max(200), selectedSeats:z.number().int().min(1).max(100000).default(1) })]))
    const identity=await supabaseIdentity()
    if (!identity) throw new AppError(401,"authentication_required","Sign in to continue.")
    const context="workspaceId" in input ? await setActiveWorkspace(identity,input.workspaceId) : await completeCompanyOnboarding(input.name,input.selectedSeats)
    let checkoutUrl: string | undefined
    if (isStripeCheckoutTrialConfigured()) {
      const access = await getCompanyAccess(context.workspaceId)
      if (!access.allowed && ["admin","super_admin"].includes(context.role) && access.reason === "finish_setup") {
        const state = await getDatabase().prepare<{selected_seats:number}>("SELECT selected_seats FROM company_subscription_state WHERE workspace_id=?").get(context.workspaceId)
        checkoutUrl = (await createBillingCheckout(context.workspaceId,state?.selected_seats??("name" in input?input.selectedSeats:1),true)).url
      }
    }
    return NextResponse.json({ workspaceId:context.workspaceId,role:context.role,billingEnabled:billingEnabled(),checkoutUrl })
  } catch(error) { return apiError(error) }
}
