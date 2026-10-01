import { Skeleton } from "@/components/ui/skeleton"

export default function PlatformLoading() {
  return <div role="status" className="space-y-6"><span className="sr-only">Loading platform records…</span><Skeleton className="h-8 w-56" /><Skeleton className="h-4 w-72 max-w-full" /><div className="grid gap-4 md:grid-cols-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-36 rounded-xl" />)}</div><Skeleton className="h-72 rounded-xl" /></div>
}
