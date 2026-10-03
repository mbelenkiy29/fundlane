# Supabase Auth email templates

These files are the single source for the hosted Supabase Auth emails on staging
(`djnhfcxbuigsnqwcpdrz`) and prod (`drubsfvhlggmtyiigwxy`). Apply the same file to both.

| File | Supabase template | Subject |
| --- | --- | --- |
| `confirmation.html` | Confirm signup | Your Fundlane verification code |
| `magic_link.html` | Magic link (sign-in) | Your Fundlane verification code |

Both show the 8-digit code (`{{ .Token }}`) that `/enrollment` verifies with
`verifyOtp({ type: "email" })`, and keep the confirmation link. The code length is
the project's `auth.email.otp_length` (8 on both projects), not part of the template.

Change these through a PR, then apply with the Supabase CLI (`config push`, templates only).
