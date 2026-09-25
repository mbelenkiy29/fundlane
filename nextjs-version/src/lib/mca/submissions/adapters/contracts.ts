import type {
  AdapterCapabilities,
  AdapterEnvironment,
  AdapterStatusResult,
} from "../contracts"

export {
  ADAPTER_ENVIRONMENTS,
  type AdapterCapabilities,
  type AdapterEnvironment,
  type AdapterStatusResult,
  type AdapterSubmitResult,
  type FunderAdapter,
  type FunderSubmissionAdapter,
} from "../contracts"

export const ADAPTER_SECRET_FIELDS = [
  "apiKey",
  "clientId",
  "clientSecret",
  "username",
  "password",
  "baseUrl",
  "webhookSecret",
] as const
export type AdapterSecretField = (typeof ADAPTER_SECRET_FIELDS)[number]

export interface AdapterSecretValues {
  apiKey?: string
  clientId?: string
  clientSecret?: string
  username?: string
  password?: string
  baseUrl?: string
  webhookSecret?: string
}

export interface AdapterRateLimit {
  retryAfterSeconds: number
  retryAt: string
}

export type AdapterAction = "submit" | "status"

export interface AdapterLastAction {
  action: AdapterAction
  correlationId: string
  externalRef?: string
  errorCode?: string
  errorMessage?: string
  fields?: Record<string, string>
  rateLimit?: AdapterRateLimit
  rawStatus?: string
  at: string
}

export interface AdapterCredentialPublic {
  id: string
  workspaceId: string
  funderId: string
  funderName?: string
  adapterSlug: string
  readiness: "live" | "sandbox" | "unavailable"
  environment: AdapterEnvironment
  hasCredential: boolean
  capabilities: AdapterCapabilities
  active: boolean
  secretHints: Record<AdapterSecretField, boolean>
  lastAction?: AdapterLastAction
  updatedAt: string
}

export interface AdapterFunderOption {
  id: string
  name: string
  adapterSlug?: string
  hasApiRoute: boolean
}

export interface AdapterCatalogEntry {
  slug: string
  readiness: "live" | "sandbox" | "unavailable"
  capabilities: AdapterCapabilities
}

export interface AdapterConnectionList {
  adapters: AdapterCatalogEntry[]
  credentials: AdapterCredentialPublic[]
  funders: AdapterFunderOption[]
  environments: readonly AdapterEnvironment[]
  canManage: boolean
}

export interface AdapterResolvedSecrets {
  credentialId: string
  workspaceId: string
  funderId: string
  adapterSlug: string
  environment: AdapterEnvironment
  capabilities: AdapterCapabilities
  secrets: AdapterSecretValues
  active: boolean
}

export interface AdapterRuntime {
  credentialId: string
  workspaceId: string
  funderId: string
  adapterSlug: string
  environment: AdapterEnvironment
  capabilities: AdapterCapabilities
  secrets: AdapterSecretValues
  correlationId: string
  externalRef?: string
}

export interface AdapterExecutionOptions {
  environment?: AdapterEnvironment
  correlationId?: string
  externalRef?: string
}

export interface AdapterActionView {
  ok: boolean
  action: AdapterAction
  credentialId: string
  correlationId: string
  externalRef?: string
  errorCode?: string
  errorMessage?: string
  fields?: Record<string, string>
  rateLimit?: AdapterRateLimit
  rawStatus?: string
  normalized?: AdapterStatusResult["normalized"]
  unknown?: boolean
  capabilities: AdapterCapabilities
}

export interface AdapterEncryptedPayload {
  version: 1
  workspaceId: string
  environment: AdapterEnvironment
  secrets: AdapterSecretValues
}
