import { FileCheck2, LockKeyhole, ShieldCheck } from "lucide-react"
import { NativeApplyForm } from "@/components/mca/intake/native-apply-form"
import { inspectNativeApply } from "@/lib/mca/intake/native-apply"

export default async function NativeApplyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  let representativeName: string | undefined
  try {
    representativeName = (await inspectNativeApply(token)).representativeName
  } catch {
    representativeName = undefined
  }

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-start gap-3">
          <div className="rounded-xl bg-primary p-2.5 text-primary-foreground"><FileCheck2 className="size-5" /></div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Business funding application</h1>
            <p className="mt-1 text-sm text-muted-foreground">A short form plus document upload. No extra portals.</p>
          </div>
        </div>
        {!representativeName ? (
          <div className="rounded-xl border border-destructive/30 bg-card p-6" role="alert">
            <div className="flex items-center gap-2 font-medium text-destructive"><LockKeyhole className="size-5" />This application link is invalid or no longer active</div>
            <p className="mt-2 text-sm text-muted-foreground">Ask your representative for a new personal link. No application data was accepted.</p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_240px]">
            <NativeApplyForm token={token} representativeName={representativeName} />
            <aside className="h-fit rounded-xl border bg-card p-5">
              <div className="flex items-center gap-2 font-medium"><ShieldCheck className="size-4 text-emerald-600" />Before you submit</div>
              <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
                <li>Upload recent bank statements, a photo ID, and a voided check if you have them.</li>
                <li>Use the last four digits of an ID only — never a full Social Security number.</li>
                <li>Your representative {representativeName} is assigned automatically.</li>
              </ul>
            </aside>
          </div>
        )}
      </div>
    </main>
  )
}
