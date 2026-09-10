# DocuSeal PSF activation

The application has an executable DocuSeal PSF provider path, but it remains unavailable until an administrator supplies an approved DocuSeal template and workspace credentials. Use the approved PSF template and its exact field names.

Configure `MCA_DOCUSEAL_PSF_CONNECTIONS_JSON` as an array with exactly one entry for each enabled workspace:

```json
[
  {
    "workspaceId": "WORKSPACE_ID",
    "apiBaseUrl": "https://api.docuseal.com",
    "apiToken": "DOCUSEAL_API_TOKEN",
    "webhookSecret": "DOCUSEAL_WEBHOOK_SECRET_AT_LEAST_32_CHARACTERS",
    "templateId": 123,
    "signerRole": "EXACT_CASE_SENSITIVE_TEMPLATE_ROLE",
    "fieldBindings": {
      "amount": { "name": "EXACT_AMOUNT_FIELD", "type": "number" },
      "bankName": { "name": "EXACT_BANK_NAME_FIELD", "type": "text" },
      "routingNumber": { "name": "EXACT_ROUTING_FIELD", "type": "text", "mask": true },
      "accountNumber": { "name": "EXACT_ACCOUNT_FIELD", "type": "text", "mask": true },
      "businessName": { "name": "EXACT_BUSINESS_FIELD", "type": "text" },
      "contactName": { "name": "EXACT_CONTACT_NAME_FIELD", "type": "text" },
      "contactEmail": { "name": "EXACT_CONTACT_EMAIL_FIELD", "type": "text" }
    },
    "sendEmail": true,
    "requireEmail2fa": true,
    "artifactAllowedHosts": ["EXACT_DOCUSEAL_ARTIFACT_HOST"]
  }
]
```

Use `https://api.docuseal.com` for DocuSeal Cloud. For self-hosted DocuSeal, use the deployment's exact HTTPS API root ending in `/api`. `sendEmail` and `requireEmail2fa` are explicit product choices; the application does not infer them. `artifactAllowedHosts` must list the exact host names returned for signed PDFs and the audit log.

Create the DocuSeal webhook with this application URL:

```text
https://YOUR_APP_HOST/api/mca/closing/psf/webhook/WORKSPACE_ID
```

The callback must include DocuSeal's `X-Docuseal-Signature` header. The application verifies the raw request body, timestamp, completion of every signer, submission ID, template ID, exact merchant signer role and email, and the stable PSF request identity. It then independently reads the completed submission through the DocuSeal API.

After environment configuration, an administrator opens the closing workspace and enables PSF delivery. The UI reports that DocuSeal is connected from the server environment; no placeholder webhook URL or secret is required in the database. Existing generic webhook requests stay pinned to that provider, and DocuSeal requests stay pinned to DocuSeal even if environment configuration changes.

A completed provider submission remains `delivered` with a visible evidence-processing message until every signed PDF and the audit log are downloaded from an allowed public host, stored with immutable request-derived keys, and reported clean by the document scanner. Only then does the request become `signed`.

If artifact download or scanning fails, restore the scanner or storage service and request webhook redelivery from DocuSeal. A replay must be a newly delivered provider request with a fresh valid signature and timestamp; saved or expired webhook headers are rejected. The application does not expose a manual endpoint that bypasses provider verification. Partial retries re-fetch authenticated provider artifacts and replay clean document storage by deal, category, and checksum.

Before enabling production use, verify the configured template against the approved PSF fields, create a controlled test submission, complete it with an authorized test signer, and confirm that the signed PDF and audit log appear as clean closing documents. Production DocuSeal API availability and self-hosted licensing must be confirmed with DocuSeal. See the official [API documentation](https://www.docuseal.com/docs/api) and [webhook documentation](https://www.docuseal.com/resources/use-webhooks).
