import Link from "next/link"
import { redirect, notFound } from "next/navigation"
import { requirePlatformOwner } from "@/lib/mca/operations/access"
import { AppError } from "@/lib/mca/errors"
import { StatusDashboard } from "@/components/mca/operations/status-dashboard"
export const dynamic = "force-dynamic"
export default async function Page() {
  try {
    await requirePlatformOwner()
  } catch (error) {
    if (error instanceof AppError && error.status === 401) redirect("/sign-in")
    if (error instanceof AppError && error.status === 403) notFound()
    throw error
  }
  return (
    <main className="mx-auto min-h-screen max-w-7xl space-y-6 px-4 py-8 md:px-8">
      <Link href="/home" className="text-sm text-muted-foreground">
        ← Back to Fundlane
      </Link>
      <StatusDashboard />
    </main>
  )
}
