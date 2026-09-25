import { Skeleton } from "@/components/ui/skeleton"

export function PipelineLoading() {
  return (
    <div className="space-y-6 px-4 lg:px-6" role="status" aria-label="Loading pipeline">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-24 rounded-xl" />)}
      </div>
      <Skeleton className="h-28 rounded-xl" />
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-20 w-full" />)}
      </div>
    </div>
  )
}
