"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
export function VerificationForm({
  busy,
  onVerify,
  onResend,
  mfa = false,
}: {
  busy: boolean
  onVerify: (code: string, strategy: "email" | "totp" | "backup") => void
  onResend?: () => void
  mfa?: boolean
}) {
  const [code, setCode] = useState("")
  const [strategy, setStrategy] = useState<"email" | "totp" | "backup">("email")
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        onVerify(code, strategy)
      }}
    >
      <Label className="grid gap-2">
        Verification code
        <Input
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
      </Label>
      {mfa && (
        <Label className="grid gap-2">
          Verification method
          <select
            className="rounded-md border bg-background p-2"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as typeof strategy)}
          >
            <option value="email">Email code</option>
            <option value="totp">Authenticator app</option>
            <option value="backup">Backup code</option>
          </select>
        </Label>
      )}
      <Button className="w-full" disabled={busy}>
        {busy ? "Verifying…" : "Verify and continue"}
      </Button>
      {onResend && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={busy}
          onClick={onResend}
        >
          Send a new code
        </Button>
      )}
    </form>
  )
}
