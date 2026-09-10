import { NextResponse } from "next/server";
import { requireMembershipAccess } from "@/lib/mca/auth";
import { apiError } from "@/lib/mca/errors";
import { requestCorrelationId } from "@/lib/mca/http";
import { getSessionResponse } from "@/lib/mca/sessions";

export async function GET(request: Request) {
  const correlationId = requestCorrelationId(request);
  try { return NextResponse.json(await getSessionResponse(await requireMembershipAccess(request))); }
  catch (error) { return apiError(error, correlationId); }
}
