import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { SIGNUP_COOKIE, readSignupIntent, completeSignupSetup, signupOrigin } from "@/lib/mca/stripe-first-signup"
export async function GET(request:Request) {
  try {
    const token=(await cookies()).get(SIGNUP_COOKIE)?.value
    if (!token) throw new AppError(410,"signup_intent_missing","Open the recovery email sent after saving your card to finish signup.")
    const intent=await readSignupIntent(token),session=new URL(request.url).searchParams.get("session_id")
    if (!session || session!==intent.checkout_session_id) throw new AppError(403,"signup_checkout_mismatch","This checkout does not belong to your signup.")
    await completeSignupSetup(session)
    return NextResponse.redirect(new URL("/sign-up?next=%2Factivate",signupOrigin()),{headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}})
  } catch(error){return apiError(error)}
}
