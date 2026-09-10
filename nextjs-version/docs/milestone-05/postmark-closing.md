# Postmark closing email activation

The closing adapter uses Postmark's server-level Email API and outbound Messages API. It never uses `POSTMARK_ACCOUNT_TOKEN`, which is an account-management credential.

## Credential scope

Set `MCA_CLOSING_EMAIL_PROVIDER=postmark`. Store `MCA_CLOSING_POSTMARK_CONNECTIONS_JSON` as a Railway secret containing an array of exact connection bindings:

```json
[
  {
    "workspaceId": "workspace-id",
    "senderId": "mca-email-sender-id",
    "fromAddress": "confirmed-sender@example.com",
    "serverToken": "postmark-server-token",
    "messageStream": "outbound"
  }
]
```

All three identity fields must match the authenticated workspace and selected sender. Before each preview send, the closing service independently checks that the sender belongs to the workspace, is allowed for the actor, has the required merchant/submission purpose and credential, and is `verified`. The adapter then requires the deployment binding and exact From address. A token entry for one workspace/sender cannot authorize another.

`MCA_CLOSING_POSTMARK_MESSAGE_STREAM` optionally supplies a fallback stream; otherwise `outbound` is used.

## Admin activation path

1. In **Settings → Connections**, create an SMTP sender for the required merchant or submission purpose. Use `smtp.postmarkapp.com`, Postmark's documented TLS port and server credential, and the provider-confirmed From address. Grant only the intended workspace members.
2. Save the pending sender and copy its generated sender ID from the API/admin record.
3. Add the exact workspace ID, sender ID, confirmed From address, and server-level send token to the Railway secret mapping above, then redeploy.
4. Use **Test sender** with a recipient explicitly authorized for live verification. In Postmark mode the test uses the real Email API. The service marks the sender verified only when Postmark returns numeric `ErrorCode: 0` and a nonempty `MessageID`. A development preview, account read, provider error, timeout, HTTP 5xx, malformed response, or unresolved search never verifies it.
5. Confirm the provider `MessageID` is present in the test result and Postmark activity before enabling normal closing use.

Production now has two pending connections (merchant and submission) using the existing provider-confirmed sender. Exact workspace/sender credential bindings are configured in Railway. No live test recipient has been authorized; both connections remain pending until the supported Test sender flow succeeds.

## Delivery and retry behavior

- `Subject` and `TextBody` come directly from the immutable preview.
- Contract/repricing attachments are reauthorized by deal, clean state, version and checksum immediately before delivery; Postmark receives their exact bytes, filename and MIME type.
- The provider `MessageID` is stored as the external delivery ID only after explicit acceptance.
- Provider error text is never persisted because it can echo recipient or message data. Stored errors use bounded status/error codes and fixed safe messages.
- HTTP 4xx and Postmark nonzero `ErrorCode` are known failures. HTTP 5xx, connection loss and malformed HTTP success are outcome-unknown and trigger an outbound-message search.
- Each send includes `mca_delivery_id`, record ID and immutable payload hash as metadata. Reconciliation requires matching recipient, delivery ID and payload hash before accepting a found `MessageID`.
- A PostgreSQL record advisory lock fences different attempt keys. Existing `pending`, sent or unknown records prevent a second send. Pending/unknown records are reconciled only, including after a process crash.

No real Postmark message was sent while implementing or testing this adapter. Provider documentation: [Email API](https://postmarkapp.com/developer/api/email-api) and [Messages API](https://postmarkapp.com/developer/api/messages-api).
