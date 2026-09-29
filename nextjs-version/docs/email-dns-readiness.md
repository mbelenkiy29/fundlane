# Email DNS readiness

The email DNS checker is a read-only operator tool for `fundlane.io`. It is default-off and performs no lookup unless `MCA_EMAIL_DNS_CHECK_ENABLED` is exactly `true`.

The checked-in defaults keep MX, SPF, DKIM, and DMARC **blocked** until Michael supplies the public values from useSend's Domains page and the approved mailbox and policy settings. A blocked result explains how to supply them. A provider-issued DKIM record can be checked on its own with both `--dkim-selector=SELECTOR` and `--dkim-value=VALUE`; the other defaults stay blocked.

## useSend manifest

Create `fundlane-dns.json` with every record to check. Copy useSend's domain records and add the approved MX, SPF, and DMARC values. Replace every placeholder in this example before running the checker:

```json
[
  { "type": "MX", "name": "fundlane.io", "values": [{ "priority": 10, "target": "<target from approved mailbox setup>" }] },
  { "type": "TXT", "name": "fundlane.io", "purpose": "spf", "value": "<approved SPF value>" },
  { "type": "TXT", "name": "<selector>._domainkey.fundlane.io", "purpose": "dkim", "value": "<value from useSend>" },
  { "type": "TXT", "name": "_dmarc.fundlane.io", "purpose": "dmarc", "value": "<approved DMARC value>" },
  { "type": "TXT", "name": "<name from useSend>.fundlane.io", "purpose": "other", "value": "<value from useSend>" }
]
```

Include an `other` entry for each additional useSend TXT verification record. The manifest contains only public DNS values, no API keys. It replaces the built-in blocked list completely and cannot be combined with the DKIM flags.

From `nextjs-version/`, run:

```sh
MCA_EMAIL_DNS_CHECK_ENABLED=true pnpm ops:email-dns-check -- --expected=./fundlane-dns.json
```

Retain timestamped output with provider-console acceptance evidence if needed. Every expected record is `PASS`, `FAIL`, or `BLOCKED`. The process exits zero only when every record passes; mismatches, blocked expectations, NXDOMAIN, timeouts, and resolver errors exit nonzero. MX comparison requires the exact priority and normalized target set. TXT chunks belonging to one answer are joined, but distinct TXT answers remain distinct. SPF and DMARC require a single exact policy record; DKIM requires its exact value. An `other` TXT record passes when any one answer exactly matches, even if unrelated TXT answers share its name.

The command queries public DNS only. It never changes Vercel DNS, calls useSend, reads provider credentials, or sends mail. A passing snapshot does not prove provider-console verification, mailbox receipt, outbound delivery, spam placement, bounce handling, or replies.

## Work that remains with Michael

Michael must approve the mailbox and useSend accounts, inbound routing, system sender, and complete MX/SPF/DMARC policies; copy public useSend domain records into the manifest; change Vercel DNS; wait for propagation; and verify the provider consoles. Controlled inbound and outbound receipt, delivery, spam placement, bounce, and reply checks with approved accounts and recipients remain separate from this DNS checker.
