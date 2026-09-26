import { Label } from "@/components/ui/label"

export function SignupLegalAgreement({ legalDraftsEnabled }: { legalDraftsEnabled: boolean }) {
  if (!legalDraftsEnabled) return <Label className="flex gap-2"><input type="checkbox" name="terms" required/>I agree to the terms of service and privacy policy.</Label>
  return <Label className="flex gap-2"><input type="checkbox" name="terms" required/><span>I agree to the <a className="underline" href="/terms" target="_blank" rel="noopener noreferrer">Terms of Service (draft)</a> and <a className="underline" href="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy (draft)</a>.</span></Label>
}
