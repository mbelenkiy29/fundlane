import { SmsOnboardingPanel } from "@/components/mca/sms/onboarding-panel"
import { DataMerchConfigPanel } from "@/components/mca/datamerch/data-merch-panel"
import { ImportPanel } from "@/components/mca/imports/import-panel"
import Link from "next/link"
import { SenderConnectionsPanel } from "@/components/mca/senders/sender-connections-panel"
import { SmsConnectionsPanel } from "@/components/mca/sms"
import { ProvidersPanel } from "@/components/mca/leads/providers-panel"
import { WebhookConsole } from "@/components/mca/comms/webhook-console"
import { AdapterCredentialsPanel } from "@/components/mca/submissions/adapter-credentials-panel"
import { IntegrationConnectionStatus } from "@/components/mca/integrations/connection-status"

export default function ConnectionSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Connections and imports</h2>
        <p className="text-sm text-muted-foreground">Configure inbound application providers, spreadsheet batches, document packages, Google Drive, email senders, outbound workflow webhooks, and Data Merch.</p>
      </div>
      <IntegrationConnectionStatus />
      <SenderConnectionsPanel />
      <SmsOnboardingPanel />
      <details><summary className="cursor-pointer text-sm">Existing manually configured SMS senders</summary><SmsConnectionsPanel /></details>
      <WebhookConsole />
      <ProvidersPanel />
      <AdapterCredentialsPanel />
      <div className="rounded-lg border p-5"><h3 className="font-semibold">Application intake</h3><p className="mt-1 text-sm text-muted-foreground">Connect forms, route applications, and track automatic underwriting.</p><Link href="/intake" className="mt-3 inline-block text-sm font-medium underline">Open Application Intake</Link></div>
      <ImportPanel />
      <DataMerchConfigPanel />
    </div>
  )
}
