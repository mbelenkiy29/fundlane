import { handleEnrollmentHttp } from "@/lib/mca/onboarding/http"
export async function GET(request: Request) {
  return handleEnrollmentHttp(request, "invite-open")
}
export async function POST(request: Request) {
  return handleEnrollmentHttp(request, "password")
}
