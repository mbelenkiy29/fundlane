"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"

export function CompanyPaused({ canManage }: { canManage: boolean }) {
  return <main className="mx-auto max-w-xl space-y-4 p-8">
    <h1 className="text-2xl font-semibold">Company access is paused</h1>
    <p className="text-muted-foreground">Business tools and automation are paused. Your company data is retained.</p>
    <p className="text-muted-foreground">For paid subscriptions, monthly fees continue during suspension until the effective cancellation date. Outstanding invoices, including missed months, remain due. All applicable overdue invoices must be verified paid before otherwise-eligible access resumes; separate administrative suspensions remain in effect.</p>
    {canManage ? <Link className="font-medium underline" href="/settings/billing">Review outstanding invoices, pay or cancel subscription</Link> : <p>Ask your company administrator to review billing or contact support.</p>}
    <div className="flex items-center gap-4"><Link className="underline" href="/onboarding?switch=1">Switch company</Link><Button variant="outline" onClick={async () => {
      const response = await fetch("/api/auth/sign-out", { method: "POST" })
      if (response.ok) window.location.assign("/sign-in")
    }}>Sign out</Button></div>
  </main>
}
