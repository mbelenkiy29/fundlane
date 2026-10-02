import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { supabaseIdentity, listSupabaseWorkspaces } from "@/lib/mca/supabase-auth"
import { SIGNUP_COOKIE, requireSignupEmail } from "@/lib/mca/stripe-first-signup"
import { AppError } from "@/lib/mca/errors"
import { ActivateAccount } from "./activate-account"
export const dynamic = "force-dynamic"
export default async function ActivatePage() {
  const identity=await supabaseIdentity()
  if (!identity) redirect("/sign-in?next=%2Factivate")
  const token=(await cookies()).get(SIGNUP_COOKIE)?.value
  let issue="",companyName=typeof identity.user.user_metadata.companyName==="string"?identity.user.user_metadata.companyName:""
  try {
    if (!token) throw new AppError(410,"signup_intent_missing","Open the recovery link sent after saving your card, or get started again.")
    const intent=await requireSignupEmail(token,identity.email)
    const workspaces=await listSupabaseWorkspaces(identity)
    if (workspaces.length && (!intent.workspace_id || workspaces.some(w=>w.id!==intent.workspace_id))) redirect("/dashboard")
    if (intent.state==="active") redirect("/onboarding?setup=1")
    companyName=workspaces.find(w=>w.id===intent.workspace_id)?.name??companyName
  } catch(error){if (!(error instanceof AppError))throw error;issue=error.message}
  return <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-5 p-6">
    <a href="/" className="font-semibold underline">Fundlane</a><h1 className="text-3xl font-semibold">Activate your account</h1>
    {issue?<><p role="alert">{issue}</p><a className="underline" href="/get-started">Get started</a><a className="underline" href="/sign-in?next=%2Factivate">Log in with the checkout email</a></>:<ActivateAccount email={identity.email} companyName={companyName}/>}
  </main>
}
