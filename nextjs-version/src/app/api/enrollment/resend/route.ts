import { handleEnrollmentHttp } from "@/lib/mca/onboarding/http"
export async function POST(request: Request) {
  return handleEnrollmentHttp(request, "resend")
}
