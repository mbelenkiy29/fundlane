import { redirect } from "next/navigation"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"

export const dynamic = "force-dynamic"
export default async function Page() {
  await requirePlatformPage()
  redirect("/platform/sms")
}
