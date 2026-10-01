import "server-only"
import { getDatabase, nowIso } from "../db"
import { AppError } from "../errors"
import { refreshSenderCredential } from "../senders/oauth"
import {
  decryptSenderCredential,
  findSenderById,
  encryptSenderCredential,
  senderConversationReady,
  type StoredEmailSender,
} from "../senders/repository"

export interface RemoteEmail {
  id: string
  threadId: string
  internetId: string
  references: string[]
  from: string
  to: string[]
  body: string
  subject?: string
  occurredAt: string
  localId?: string
}
export interface OutgoingEmail {
  id: string
  internetId: string
  replyTo?: string | null
  threadId?: string | null
  to: string
  subject: string
  body: string
}
export class EmailProviderError extends Error {
  constructor(
    public status: number,
    public retryAfter = 60,
    public uncertain = false
  ) {
    super(
      status === 401 || status === 403
        ? "Reconnect this email account to resume messaging."
        : status === 429
          ? "Email provider rate limit reached. The worker will retry."
          : uncertain
            ? "The provider outcome is uncertain. Checking Sent mail before any further action."
            : "The email provider rejected the request."
    )
  }
}
let testFetch: typeof fetch | undefined
export function setEmailProviderFetchForTests(value?: typeof fetch) {
  testFetch = value
}
const cleanHeader = (s: string) => s.replace(/[\r\n]/g, " ")
const address = (s: string) =>
  (s.match(/<([^<>]+)>/)?.[1] ?? s).trim().toLowerCase()
const refs = (s: string) => s.match(/<[^<>\s]+>/g) ?? []
const validInternetId = (s: string) => /^<[^<>\s]+>$/.test(s)
export function mimeEmail(from: string, input: OutgoingEmail): string {
  const headers = [
    `From: ${cleanHeader(from)}`,
    `To: ${cleanHeader(input.to)}`,
    `Subject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`,
    `Message-ID: ${input.internetId}`,
    `X-Fundlane-Message-Id: ${input.id}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ]
  if (input.replyTo && validInternetId(input.replyTo))
    headers.push(
      `In-Reply-To: ${input.replyTo}`,
      `References: ${input.replyTo}`
    )
  return (
    headers.join("\r\n") +
    "\r\n\r\n" +
    (
      Buffer.from(input.body)
        .toString("base64")
        .match(/.{1,76}/g) ?? []
    ).join("\r\n")
  )
}
type GmailPart = {
  mimeType?: string
  filename?: string
  body?: { data?: string }
  parts?: GmailPart[]
  headers?: { name: string; value: string }[]
}
type GmailMessage = {
  id: string
  threadId: string
  internalDate?: string
  payload?: GmailPart
}
function plainText(part?: GmailPart, allowHtml = true): string {
  if (!part || part.filename) return ""
  if (part.mimeType === "text/plain" && part.body?.data)
    return Buffer.from(part.body.data, "base64url")
      .toString("utf8")
      .slice(0, 100000)
  const textChildren = (part.parts ?? [])
    .map((child) => plainText(child, false))
    .filter(Boolean)
  if (textChildren.length) return textChildren.join("\n").slice(0, 100000)
  const htmlChildren = allowHtml
    ? (part.parts ?? []).map((child) => plainText(child, true)).filter(Boolean)
    : []
  if (htmlChildren.length) return htmlChildren.join("\n").slice(0, 100000)
  // HTML-only mail is displayed as text, never inserted into the DOM as HTML.
  if (allowHtml && part.mimeType === "text/html" && part.body?.data)
    return Buffer.from(part.body.data, "base64url")
      .toString("utf8")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, " ")
      .slice(0, 100000)
  return ""
}
function gmailMessage(m: GmailMessage): RemoteEmail {
  const h = (name: string) =>
    m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? ""
  return {
    id: m.id,
    threadId: m.threadId,
    internetId: h("message-id"),
    references: [...refs(h("references")), ...refs(h("in-reply-to"))],
    from: address(h("from")),
    to: h("to").split(",").map(address),
    body: plainText(m.payload),
    subject: h("subject"),
    occurredAt: new Date(Number(m.internalDate) || Date.now()).toISOString(),
    localId: h("x-fundlane-message-id") || undefined,
  }
}
type GraphMessage = {
  id: string
  conversationId: string
  internetMessageId: string
  internetMessageHeaders?: { name: string; value: string }[]
  from?: { emailAddress?: { address?: string } }
  toRecipients?: { emailAddress?: { address?: string } }[]
  body?: { content?: string; contentType?: string }
  subject?: string
  sentDateTime?: string
  receivedDateTime?: string
  isDraft?: boolean
}
function graphMessage(m: GraphMessage): RemoteEmail {
  const h = (name: string) =>
    m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name)
      ?.value ?? ""
  return {
    id: m.id,
    threadId: m.conversationId,
    internetId: m.internetMessageId,
    references: [...refs(h("references")), ...refs(h("in-reply-to"))],
    from: (m.from?.emailAddress?.address ?? "").toLowerCase(),
    to: (m.toRecipients ?? []).map((r) =>
      (r.emailAddress?.address ?? "").toLowerCase()
    ),
    body: (m.body?.contentType?.toLowerCase() === "html"
      ? (m.body.content ?? "")
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]*>/g, " ")
      : (m.body?.content ?? "")
    ).slice(0, 100000),
    subject: m.subject,
    occurredAt: m.receivedDateTime ?? m.sentDateTime ?? nowIso(),
    localId: h("x-fundlane-message-id") || undefined,
  }
}
export class Mailbox {
  private token = ""
  constructor(
    public sender: StoredEmailSender,
    private heartbeat: () => Promise<void> = async () => {}
  ) {}
  async connect() {
    if (!senderConversationReady(this.sender))
      throw new AppError(
        409,
        "email_reconnect_required",
        "Reconnect this account with email read and send permissions."
      )
    let credential = decryptSenderCredential(
      this.sender.workspaceId,
      this.sender.credentialCipher!
    )
    if (credential?.kind !== "oauth")
      throw new AppError(
        409,
        "email_reconnect_required",
        "Reconnect this account."
      )
    if (
      !credential.expiresAt ||
      new Date(credential.expiresAt).getTime() < Date.now() + 60000
    ) {
      await this.heartbeat()
      try {
        credential = await refreshSenderCredential(
          this.sender.provider as "google" | "microsoft",
          credential
        )
      } catch (error) {
        if (error instanceof AppError && [429, 503].includes(error.status))
          throw new EmailProviderError(429, 60)
        throw new EmailProviderError(401)
      }
      const cipher = encryptSenderCredential(
        this.sender.workspaceId,
        credential
      )
      const result = await getDatabase()
        .prepare(
          "UPDATE mca_email_senders SET credential_cipher=?,updated_at=? WHERE workspace_id=? AND id=? AND credential_cipher=? AND state='verified'"
        )
        .run(
          cipher,
          nowIso(),
          this.sender.workspaceId,
          this.sender.id,
          this.sender.credentialCipher
        )
      if (!result.changes)
        throw new AppError(
          409,
          "email_connection_changed",
          "Email connection changed; the worker will reload it."
        )
      this.sender = { ...this.sender, credentialCipher: cipher }
    }
    this.token = credential.accessToken
  }
  private async request<T>(
    url: string,
    init: RequestInit = {},
    sending = false
  ): Promise<T> {
    await this.heartbeat()
    const expected =
      this.sender.provider === "google"
        ? "gmail.googleapis.com"
        : "graph.microsoft.com"
    const parsed = new URL(url)
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== expected ||
      parsed.username ||
      parsed.password
    )
      throw new Error("Invalid email provider pagination URL.")
    const current = await findSenderById(this.sender.workspaceId, this.sender.id)
    if (!current || !senderConversationReady(current) || current.credentialCipher !== this.sender.credentialCipher) {
      throw new AppError(409, "email_connection_changed", "Email connection changed; reconnect or reload the mailbox.")
    }
    let response: Response
    await (await import("../company-access")).assertCompanyOperational(this.sender.workspaceId)
    if (sending) await (await import("../outbound-approval")).assertOutboundDispatch(this.sender.workspaceId, new Date().toISOString())
    try {
      response = await (testFetch ?? fetch)(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"',
          ...init.headers,
        },
      })
    } catch {
      throw new EmailProviderError(0, 60, sending)
    }
    if (!response.ok) {
      const retry = response.headers.get("retry-after")
      const seconds =
        retry && /^\d+$/.test(retry)
          ? Number(retry)
          : retry
            ? Math.ceil((Date.parse(retry) - Date.now()) / 1000)
            : 60
      throw new EmailProviderError(
        response.status,
        Math.min(3600, Math.max(1, seconds || 60)),
        sending && response.status >= 500
      )
    }
    if (response.status === 202 || response.status === 204) return {} as T
    try {
      return (await response.json()) as T
    } catch {
      throw new EmailProviderError(0, 60, sending)
    }
  }
  async send(
    input: OutgoingEmail
  ): Promise<{ id?: string; threadId?: string }> {
    const mime = mimeEmail(
      `=?UTF-8?B?${Buffer.from(this.sender.fromName).toString("base64")}?= <${this.sender.fromAddress}>`,
      input
    )
    if (this.sender.provider === "google")
      return this.request<{ id: string; threadId: string }>(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          body: JSON.stringify({
            raw: Buffer.from(mime).toString("base64url"),
            ...(input.threadId ? { threadId: input.threadId } : {}),
          }),
        },
        true
      )
    await this.request(
      "https://graph.microsoft.com/v1.0/me/sendMail",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: Buffer.from(mime).toString("base64"),
      },
      true
    )
    return {}
  }
  async findSent(input: {
    id: string
    internetId: string
    createdAt: string
  }): Promise<RemoteEmail | undefined> {
    if (this.sender.provider === "google") {
      const query = new URLSearchParams({
        q: `in:sent rfc822msgid:${input.internetId}`,
        maxResults: "10",
      })
      const result = await this.request<{ messages?: { id: string }[] }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`
      )
      for (const row of result.messages ?? []) {
        const m = gmailMessage(
          await this.request<GmailMessage>(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(row.id)}?format=full`
          )
        )
        if (m.internetId === input.internetId || m.localId === input.id)
          return m
      }
      return
    }
    const query = new URLSearchParams({
      $filter: `sentDateTime ge ${new Date(new Date(input.createdAt).getTime() - 60000).toISOString()}`,
      $select:
        "id,conversationId,internetMessageId,internetMessageHeaders,from,toRecipients,body,sentDateTime,isDraft",
      $top: "50",
    })
    let url: string | undefined =
      `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?${query}`
    for (let page = 0; url && page < 100; page++) {
      const result: { value: GraphMessage[]; "@odata.nextLink"?: string } =
        await this.request(url)
      for (const row of result.value ?? []) {
        const m = graphMessage(row)
        if (
          !row.isDraft &&
          (m.internetId === input.internetId || m.localId === input.id)
        )
          return m
      }
      url = result["@odata.nextLink"]
    }
    if (url) throw new EmailProviderError(429, 60)
  }
  async thread(id: string): Promise<RemoteEmail[]> {
    if (this.sender.provider === "google") {
      const result = await this.request<{ messages?: GmailMessage[] }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=full`
      )
      return (result.messages ?? []).map(gmailMessage)
    }
    const query = new URLSearchParams({
      $filter: `conversationId eq '${id.replace(/'/g, "''")}'`,
      $select:
        "id,conversationId,internetMessageId,internetMessageHeaders,from,toRecipients,body,receivedDateTime,sentDateTime,isDraft",
      $top: "50",
    })
    let url: string | undefined =
      `https://graph.microsoft.com/v1.0/me/messages?${query}`
    const messages: RemoteEmail[] = []
    for (let page = 0; url && page < 100; page++) {
      const result: { value: GraphMessage[]; "@odata.nextLink"?: string } =
        await this.request(url)
      messages.push(
        ...(result.value ?? []).filter((m) => !m.isDraft).map(graphMessage)
      )
      url = result["@odata.nextLink"]
    }
    if (url) throw new EmailProviderError(429, 60)
    return messages
  }
  /** Read-only inbox scan with a polling-interval overlap; consumers deduplicate by provider ID. */
  async listInboxSince(cursor?: string): Promise<{ messages: RemoteEmail[]; nextCursor: string }> {
    const since = cursor && Number.isFinite(Date.parse(cursor)) ? Date.parse(cursor) - 15 * 60_000 : Date.now() - 7 * 24 * 60 * 60_000
    const messages: RemoteEmail[] = []
    if (this.sender.provider === "google") {
      let pageToken: string | undefined
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ q: `in:inbox after:${Math.floor(since / 1000)}`, maxResults: "100" })
        if (pageToken) query.set("pageToken", pageToken)
        const result = await this.request<{ messages?: { id: string }[]; nextPageToken?: string }>(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`
        )
        for (const row of result.messages ?? []) {
          messages.push(gmailMessage(await this.request<GmailMessage>(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(row.id)}?format=full`
          )))
        }
        pageToken = result.nextPageToken
        if (!pageToken) break
      }
      if (pageToken) throw new EmailProviderError(429, 60)
    } else {
      const query = new URLSearchParams({
        $filter: `receivedDateTime ge ${new Date(since).toISOString()}`,
        $select: "id,conversationId,internetMessageId,internetMessageHeaders,from,toRecipients,body,subject,receivedDateTime,isDraft",
        $top: "100",
      })
      let url: string | undefined = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${query}`
      for (let page = 0; url && page < 100; page++) {
        const result: { value: GraphMessage[]; "@odata.nextLink"?: string } = await this.request(url)
        messages.push(...(result.value ?? []).filter(row => !row.isDraft).map(graphMessage))
        url = result["@odata.nextLink"]
      }
      if (url) throw new EmailProviderError(429, 60)
    }
    return { messages, nextCursor: new Date(Math.max(Date.now(), ...messages.map(message => Date.parse(message.occurredAt) || 0))).toISOString() }
  }
}
