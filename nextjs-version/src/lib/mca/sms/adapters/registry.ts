import "server-only"

import { AppError } from "../../errors"
import type { SmsAdapter, SmsProvider } from "../contracts"
import { SMS_PROVIDERS } from "../contracts"
import { entranceSmsAdapter } from "./entrance"
import { gohighlevelSmsAdapter } from "./gohighlevel"
import { openphoneSmsAdapter } from "./openphone"
import { texttorrentSmsAdapter } from "./texttorrent"
import { textusSmsAdapter } from "./textus"
import { twilioSmsAdapter } from "./twilio"
import { unavailableSmsAdapter } from "./unavailable"

const adapters = new Map<SmsProvider, SmsAdapter>()

export function registerSmsAdapter(adapter: SmsAdapter): void {
  adapters.set(adapter.slug, adapter)
}

registerSmsAdapter(twilioSmsAdapter)
registerSmsAdapter(entranceSmsAdapter)
registerSmsAdapter(texttorrentSmsAdapter)
registerSmsAdapter(textusSmsAdapter)
registerSmsAdapter(openphoneSmsAdapter)
registerSmsAdapter(gohighlevelSmsAdapter)

export function getSmsAdapter(slug: SmsProvider): SmsAdapter {
  if (!SMS_PROVIDERS.includes(slug)) throw new AppError(422, "sms_provider_unsupported", "That SMS provider is not supported.")
  return adapters.get(slug) ?? unavailableSmsAdapter(slug)
}

export function listSmsAdapterSlugs(): SmsProvider[] {
  return [...SMS_PROVIDERS]
}
