import { handleEnrollmentHttp } from "@/lib/mca/onboarding/http"
export async function GET(request: Request) {
  return handleEnrollmentHttp(request, "status")
}
