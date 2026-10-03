import { handleEnrollmentHttp } from "@/lib/mca/onboarding/http"
// POST only: the invite token is never accepted from a URL, and no GET has side effects.
export async function POST(request: Request) {
  return handleEnrollmentHttp(request, "password")
}
