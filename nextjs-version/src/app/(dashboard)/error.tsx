"use client"
import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <div className="mx-4 flex min-h-80 flex-col items-center justify-center rounded-xl border p-8 text-center lg:mx-6"><AlertCircle className="size-7 text-destructive" /><h1 className="mt-3 text-lg font-semibold">This page could not be loaded</h1><p className="mt-1 text-sm text-muted-foreground">Your current work is safe. Retry the request when you’re ready.</p><Button variant="outline" className="mt-4" onClick={reset}>Try again</Button></div> }
