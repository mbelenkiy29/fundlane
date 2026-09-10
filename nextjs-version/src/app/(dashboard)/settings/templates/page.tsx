import { FollowupPanel } from "@/components/mca/comms/followup-panel"
import { TemplateEditor } from "@/components/mca/comms/template-editor"

export default function MessageTemplatesPage() {
  return (
    <div className="space-y-6">
      <TemplateEditor />
      <FollowupPanel />
    </div>
  )
}
