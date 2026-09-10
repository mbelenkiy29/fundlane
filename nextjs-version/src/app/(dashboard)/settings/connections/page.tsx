import { SmsOnboardingPanel } from "@/components/mca/sms/onboarding-panel"
import { DataMerchConfigPanel } from "@/components/mca/datamerch/data-merch-panel"
import { ImportPanel } from "@/components/mca/imports/import-panel"
import { IntakePanel } from "@/components/mca/intake/intake-panel"
import { SenderConnectionsPanel } from "@/components/mca/senders/sender-connections-panel"
import { SmsConnectionsPanel } from "@/components/mca/sms"
import { ProvidersPanel } from "@/components/mca/leads/providers-panel"
import { WebhookConsole } from "@/components/mca/comms/webhook-console"
import { AdapterCredentialsPanel } from "@/components/mca/submissions/adapter-credentials-panel"

export default function ConnectionSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Connections and imports</h2>
        <p className="text-sm text-muted-foreground">Configure inbound application providers, spreadsheet batches, document packages, Google Drive, email senders, and Data Merch.</p>
      </div>
      <SenderConnectionsPanel />
      <SmsOnboardingPanel />
      <details><summary className="cursor-pointer text-sm">Existing manually configured SMS senders</summary><SmsConnectionsPanel /></details>
      <WebhookConsole />
      <ProvidersPanel />
      <AdapterCredentialsPanel />
      <IntakePanel />
      <ImportPanel />
      <DataMerchConfigPanel />
    </div>
  )
}
