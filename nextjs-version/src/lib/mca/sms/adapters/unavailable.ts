import "server-only"

import type { SmsAdapter, SmsProvider } from "../contracts"

export function unavailableSmsAdapter(slug: SmsProvider): SmsAdapter {
  return {
    slug,
    capabilities: { send: true, statusCallbacks: false, inbound: false, optOut: false },
    validate() {
      return { ok: false, fields: { provider: "This SMS provider is not registered yet." } }
    },
    async testConnection() {
      return { ok: false, code: "sms_provider_unavailable" }
    },
    async send() {
      return {
        state: "failed",
        errorCode: "sms_provider_unavailable",
        errorMessage: "This SMS provider adapter is not implemented. Connect a registered adapter before sending.",
      }
    },
  }
}
