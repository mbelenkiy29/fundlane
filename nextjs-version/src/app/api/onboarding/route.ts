import { NextResponse } from "next/server"
import { z } from "zod"
import { completeCompanyOnboarding, listSupabaseWorkspaces, setActiveWorkspace, supabaseIdentity } from "@/lib/mca/supabase-auth"
import { getTotpAccessState } from "@/lib/mca/totp-service"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { readJson } from "@/lib/mca/http"
import { billingEnabled, billingTrialDays, createOnboardingCheckoutUrl, isStripeCheckoutTrialConfigured } from "@/lib/mca/billing"
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
    const checkoutUrl = await createOnboardingCheckoutUrl(context.workspaceId,context.role,"name" in input?input.selectedSeats:1)
    const totp=context.userId ? await getTotpAccessState({ userId:context.userId, sessionId:identity.sessionId, workspaceId:context.workspaceId }) : null
    return NextResponse.json({ workspaceId:context.workspaceId,role:context.role,billingEnabled:billingEnabled(),checkoutUrl,totpEnrollmentRequired:totp?.enrollmentRequired===true,totpChallengeRequired:totp?.challengeRequired===true })
  } catch(error) { return apiError(error) }
}
