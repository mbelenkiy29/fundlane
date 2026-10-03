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

## How to apply (templates only)

Change these through a PR first. Do **not** run `supabase config push` from
`nextjs-version/supabase/config.toml`: it doesn't point at these files, and a full
push of that toml can overwrite other hosted Auth settings (SMTP, redirects, rate
limits, password rules).

Apply from a scratch folder instead:

1. `supabase init` in an empty folder, then `supabase link --project-ref <ref>`.
2. Run `supabase config pull` (or start from the linked defaults) so every other Auth
   setting matches the hosted project. Comment out any setting the API doesn't
   return, such as `password_requirements`, so a blank value can't wipe it.
3. Add only these sections, with `content_path` pointing at the files here:

   ```toml
   [auth.email.template.confirmation]
   subject = "Your Fundlane verification code"
   content_path = "<repo>/nextjs-version/supabase/email-templates/confirmation.html"

   [auth.email.template.magic_link]
   subject = "Your Fundlane verification code"
   content_path = "<repo>/nextjs-version/supabase/email-templates/magic_link.html"
   ```

4. Dry-run first (`supabase config push --project-ref <ref>` shows the diff and asks
   before applying). Proceed only if the diff lists just the two template subject and
   content changes.
5. After applying, re-run the diff (it should be empty) and send one test signup
   email to confirm the code appears.

Prod changes need the owner's approval before step 4 is confirmed.
