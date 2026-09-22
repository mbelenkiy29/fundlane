"use client"
import { Button } from "@/components/ui/button"
export default function PlatformError({reset}:{reset:()=>void}) {return <div role="alert" className="space-y-4 p-6"><h1 className="text-xl font-semibold">Platform console unavailable</h1><p>Confirm that your account has platform access and multi-factor authentication, then retry.</p><Button onClick={reset}>Retry</Button><Button asChild variant="outline"><a href="/account-security">Account security</a></Button></div>}
