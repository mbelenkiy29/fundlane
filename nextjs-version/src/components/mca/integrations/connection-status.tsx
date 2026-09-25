"use client"

import * as React from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { RequestError, requestJson } from "@/lib/mca/client"
import {
  emailChannelStatus,
  funderSubmissionChannelStatus,
  smsChannelStatus,
  type ChannelStatus,
  type ConnectionLabel,
} from "@/lib/mca/integrations/connection-status"

type SenderPayload = {
  senders: Array<{ state: string; hasCredential?: boolean; conversationReady?: boolean }>
}

type SmsAccountsPayload = {
  accounts: Array<{ state?: string; providerConfigured?: boolean; credentialRef?: string }>
}

type SmsOnboardingPayload = {
  registrationState?: string
  platformReady?: boolean
  optOutReady?: boolean
  numbers?: unknown[]
  suspended?: boolean
}

type AdaptersPayload = {
  credentials: Array<{ hasCredential?: boolean; active?: boolean }>
  funders: Array<{ hasApiRoute?: boolean; adapterSlug?: string }>
}

type FundersPayload = {
  funders: Array<{ active?: boolean; routes?: Array<{ active: boolean; kind: string }> }>
}

function badgeVariant(label: ConnectionLabel): "default" | "secondary" | "destructive" | "outline" {
  if (label === "Connected") return "default"
  if (label === "Expired" || label === "Revoked") return "destructive"
  if (label === "Pending") return "secondary"
  return "outline"
}

export function ConnectionStatusBadge({ label }: { label: ConnectionLabel }) {
  return <Badge variant={badgeVariant(label)}>{label}</Badge>
}

export function MissingPrerequisites({ missing }: { missing: string[] }) {
  if (!missing.length) return null
  return (
    <ul role="status" className="list-disc space-y-1 pl-5 text-sm text-amber-800">
      {missing.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

async function optionalJson<T>(url: string): Promise<T | undefined> {
  try {
    return await requestJson<T>(url)
  } catch (caught) {
    if (caught instanceof RequestError && (caught.status === 401 || caught.status === 403 || caught.status === 404)) {
      return undefined
    }
    throw caught
  }
}

export function IntegrationConnectionStatus() {
  const [channels, setChannels] = React.useState<ChannelStatus[]>()
  const [error, setError] = React.useState<string>()

  React.useEffect(() => {
    let active = true
    void Promise.all([
      optionalJson<SenderPayload>("/api/mca/senders"),
      optionalJson<SmsAccountsPayload>("/api/mca/sms/accounts"),
      optionalJson<SmsOnboardingPayload>("/api/mca/sms/onboarding"),
      optionalJson<AdaptersPayload>("/api/mca/adapters"),
      optionalJson<FundersPayload>("/api/mca/funders"),
    ])
      .then(([senders, smsAccounts, onboarding, adapters, funders]) => {
        if (!active) return
        const accounts = (smsAccounts?.accounts ?? []).filter((account) => account.credentialRef !== "MANAGED")
        setChannels([
          emailChannelStatus(senders?.senders ?? []),
          smsChannelStatus({ accounts, onboarding }),
          funderSubmissionChannelStatus({
            funders: [
              ...(funders?.funders ?? []),
              ...(adapters?.funders ?? []),
            ],
            credentials: adapters?.credentials,
          }),
        ])
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "Connection status could not be loaded.")
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Integration status</CardTitle>
        <CardDescription>
          Email, SMS, and funder submission stay disabled until the existing connection or route is ready. Nothing is sent from this page.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-3">
        {error && <p role="alert" className="text-sm text-destructive md:col-span-3">{error}</p>}
        {!channels && !error && <p role="status" className="text-sm text-muted-foreground md:col-span-3">Loading connection status…</p>}
        {channels?.map((channel) => (
          <div key={channel.channel} className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{channel.title}</p>
              <ConnectionStatusBadge label={channel.label} />
            </div>
            <p className="text-sm text-muted-foreground">{channel.detail}</p>
            <Link href={channel.href} className="text-sm underline">
              {channel.ready ? "Manage connection" : "Finish setup"}
            </Link>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
