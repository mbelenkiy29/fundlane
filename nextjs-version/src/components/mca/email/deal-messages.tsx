"use client"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SmsComposerPanel } from "@/components/mca/sms/composer-panel"
import { SmsInboxPanel } from "@/components/mca/sms/inbox-panel"
import { EmailInbox } from "./inbox"
export function DealMessages({
  dealId,
  channel = "sms",
}: {
  dealId: string
  channel?: "sms" | "email"
}) {
  return (
    <Tabs key={`${dealId}:${channel}`} defaultValue={channel}>
      <TabsList aria-label="Message channel">
        <TabsTrigger value="sms">SMS</TabsTrigger>
        <TabsTrigger value="email">Email</TabsTrigger>
      </TabsList>
      <TabsContent value="sms" className="space-y-4">
        <SmsComposerPanel dealId={dealId} />
        <SmsInboxPanel dealId={dealId} />
      </TabsContent>
      <TabsContent value="email">
        <EmailInbox dealId={dealId} />
      </TabsContent>
    </Tabs>
  )
}
