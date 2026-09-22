# Google sign-in and account security

Google sign-in uses the existing Supabase browser identity and PKCE cookie flow. `POST /api/auth/google` starts it; `/auth/callback` exchanges the code and checks the verified, live Supabase identity before continuing. The callback accepts only explicit local onboarding, invitation, recovery, and account-security destinations. Provider failures retain safe continuation context for retry.

The callback does not create application users, companies, memberships, or accept invitations. Existing server onboarding and invitation handlers remain authoritative: invitations require the matching verified email, and historical application accounts require controlled migration rather than email-based linking. Google users resume company selection/setup through `/onboarding`; invited users return to the invitation's explicit acceptance step.

`/account-security` is server-authenticated and available before workspace selection. It enrolls a TOTP authenticator or challenges an existing one using authenticated, origin-checked, rate-limited server endpoints. Secrets are returned only during enrollment with no-store headers. Platform authorization continues to require the existing server-verified `aal2` claim for the same live session and an explicit platform grant. Company administrators do not acquire platform grants by enrolling MFA.

## External configuration (operator action; not changed by this task)

1. Create a Google OAuth **Web application** client and configure the consent screen, approved domains, and test users while in testing mode.
2. In Google, register the Supabase provider callback as an authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback` (use the exact callback shown in the isolated Supabase project's Google provider settings).
3. Enable Google under Supabase Auth providers and enter that client's ID and secret there. Do not put the Google secret in browser environment variables.
4. Set the Supabase Site URL to the app's canonical origin and allow the app's `/auth/callback` redirect, including the application's continuation query variants. Configure local/staging origins separately and avoid broad production wildcard hosts.
5. Ensure `MCA_APP_ORIGIN` is the canonical app origin, email confirmation remains enabled, and Supabase TOTP enrollment/verification is enabled. Existing Supabase URL/publishable key/server secrets are reused.
6. Validate Google success, consent cancellation, expired/replayed PKCE code, mismatched invitation email, historical migration account, interrupted onboarding, TOTP enrollment, invalid code, and the platform guard at AAL1/AAL2 against isolated Supabase staging.

No OAuth provider configuration or deployment is performed by these source changes.
