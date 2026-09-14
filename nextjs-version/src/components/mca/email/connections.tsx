"use client"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { requestJson } from "@/lib/mca/client"
import type { EmailSender } from "@/lib/mca/senders/contracts"

export function PersonalEmailConnections({
  onChanged,
}: {
  onChanged?: () => void
}) {
  const [payload, setPayload] = useState<{
    senders: EmailSender[]
    oauth: { google: boolean; microsoft: boolean }
  }>()
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [name, setName] = useState(""),
    [address, setAddress] = useState(""),
    [signature, setSignature] = useState("")
  const load = useCallback(
    async () => setPayload(await requestJson("/api/mca/senders")),
    []
  )
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void load().catch((e) => setError(e.message))
    }
    refresh()
    const timer = setInterval(refresh, 15000)
    return () => clearInterval(timer)
  }, [load])
  async function connect(provider: "google" | "microsoft", id?: string) {
    setBusy(true)
    setError("")
    try {
      const existing = payload?.senders.find(
        (s) =>
          s.fromAddress.toLowerCase() === address.trim().toLowerCase() &&
          s.provider === provider &&
          s.ownerMembershipId &&
          s.canReconnect
      )
      const sender = id
        ? { id }
        : (existing ??
          (await requestJson<EmailSender>("/api/mca/senders", {
            method: "POST",
            body: JSON.stringify({
              personal: true,
              provider,
              purpose: "merchant",
              fromName: name,
              fromAddress: address,
              signature,
            }),
          })))
      const result = await requestJson<{ authorizationUrl: string }>(
        `/api/mca/senders/${sender.id}/oauth`,
        { method: "POST" }
      )
      window.location.assign(result.authorizationUrl)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to connect email.")
      await load()
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="rounded-lg border p-4" id="email-connections">
      <summary className="cursor-pointer font-medium">
        Connect your work email
      </summary>
      <p className="mt-3 text-sm text-muted-foreground">
        Send as yourself and read replies to conversations started in Fundlane.
        Your provider will request email read and send access.
      </p>
      {error && (
        <p role="alert" className="my-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Label className="grid gap-2">
          Your sender name
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
        </Label>
        <Label className="grid gap-2">
          Work email
          <Input
            type="email"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Label>
      </div>
      <Label className="mt-3 grid gap-2">
        Email signature
        <Textarea
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          maxLength={8000}
          placeholder="Optional signature"
        />
      </Label>
      <div className="mt-3 flex flex-wrap gap-2">
        {(["google", "microsoft"] as const).map((provider) => (
          <Button
            key={provider}
            disabled={
              busy ||
              !name.trim() ||
              !address.trim() ||
              !payload?.oauth[provider]
            }
            variant="outline"
            onClick={() => void connect(provider)}
          >
            Connect {provider === "google" ? "Gmail" : "Microsoft"}
          </Button>
        ))}
      </div>
      {payload && (!payload.oauth.google || !payload.oauth.microsoft) && (
        <p className="mt-2 text-sm text-muted-foreground">
          Unavailable providers need deployment configuration from your
          administrator.
        </p>
      )}
      <div className="mt-4 space-y-2">
        {payload?.senders
          .filter((s) => s.provider === "google" || s.provider === "microsoft")
          .map((sender) => (
            <div
              key={sender.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border p-3"
            >
              <div>
                <p className="text-sm font-medium">{sender.fromAddress}</p>
                <p className="text-xs text-muted-foreground">
                  {sender.conversationReady
                    ? "Ready for conversations"
                    : "Connection or additional permissions required"}
                </p>
              </div>
              {!sender.conversationReady && sender.canReconnect && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void connect(
                      sender.provider as "google" | "microsoft",
                      sender.id
                    )
                  }
                >
                  Connect / reconnect
                </Button>
              )}
            </div>
          ))}
      </div>
    </details>
  )
}
