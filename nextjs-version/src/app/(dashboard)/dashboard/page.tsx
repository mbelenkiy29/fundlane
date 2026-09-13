import Link from "next/link"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { authenticateClerkSession } from "@/lib/mca/clerk-auth"
import { getSessionResponse } from "@/lib/mca/sessions"
import { NeedsAction } from "@/components/mca/home/needs-action"

export default async function DashboardPage() {
  const context = await authenticateClerkSession()
  const session = context ? await getSessionResponse(context) : null
  const firstName = session?.user?.name.split(" ")[0] ?? "there"
  return (
    <div className="space-y-6 px-4 lg:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Good afternoon, {firstName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Here’s where your brokerage needs attention.</p>
        </div>
        {session?.permissions?.actions.createDeal && (
          <Button asChild>
            <Link href="/pipeline?create=1"><Plus /> New deal</Link>
          </Button>
        )}
      </div>
      <NeedsAction />
    </div>
  )
}
