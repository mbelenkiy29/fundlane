import { NextResponse } from "next/server";
export async function POST() {
  return NextResponse.json({ error: { code: "clerk_auth_required", message: "Use the Clerk sign-in, onboarding or invitation flow. Legacy authentication is no longer available." } }, { status: 410 });
}
