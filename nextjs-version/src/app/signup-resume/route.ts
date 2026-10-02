import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { readSignupIntent, signupOrigin } from "@/lib/mca/stripe-first-signup"
import { setSignupCookie } from "@/lib/mca/signup-http"
export async function GET(request:Request) {
  try {
    const token=new URL(request.url).searchParams.get("token")
    if (!token || token.length>256) throw new AppError(410,"signup_intent_expired","This recovery link is invalid or expired.")
    const intent=await readSignupIntent(token)
    if (intent.state==="pending") throw new AppError(409,"signup_card_incomplete","Finish saving your card first.")
    await setSignupCookie(token,intent.expires_at)
    return NextResponse.redirect(new URL(intent.state==="active"?"/sign-in":"/sign-up?next=%2Factivate",signupOrigin()),{headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}})
  } catch(error){const response=apiError(error);response.headers.set("Referrer-Policy","no-referrer");return response}
}
