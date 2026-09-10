import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { assertTrustedMutation } from "@/lib/mca/auth";
import { apiError } from "@/lib/mca/errors";
export async function POST(request: Request) {
  try { assertTrustedMutation(request); const { sessionId } = await auth(); if (sessionId) await (await clerkClient()).sessions.revokeSession(sessionId); const response = NextResponse.json({ success: true }); response.cookies.delete("mca_session"); return response; }
  catch (error) { return apiError(error); }
}
