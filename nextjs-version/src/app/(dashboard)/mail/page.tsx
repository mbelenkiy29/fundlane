import { EmailInbox } from "@/components/mca/email/inbox"
export default async function MailPage({searchParams}:{searchParams:Promise<{deal?:string;sender?:string;code?:string}>}) {
  const query=await searchParams
  return <div className="space-y-4 p-4 md:p-6">{query.sender==="connected" && <p role="status" className="text-sm">Email connection saved. Check its readiness below before starting a conversation.</p>}{query.sender==="error" && <p role="alert" className="text-sm text-destructive">Email connection could not be completed. Check that you chose the matching account and granted email read and send access, then reconnect.</p>}<EmailInbox key={query.deal??"inbox"} dealId={query.deal} showConnections/></div>
}
