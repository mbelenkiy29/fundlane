// Read-only application checks apart from creating/revoking the verification login session.
// Supply an existing administrator through MCA_VERIFY_EMAIL/MCA_VERIFY_PASSWORD.
const origin = process.env.MCA_VERIFY_ORIGIN
const email = process.env.MCA_VERIFY_EMAIL
const password = process.env.MCA_VERIFY_PASSWORD
if (!origin || !email || !password) throw new Error("Verification origin and existing login credentials are required.")
const results = []
let cookie
async function check(path, expected, init = {}) {
  const response = await fetch(new URL(path, origin), {
    ...init,
    headers: { origin, ...(cookie ? { cookie } : {}), ...init.headers },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  })
  results.push({ path, status: response.status, expected, passed: response.status === expected })
  return response
}
try {
  await check("/sign-in", 200)
  await check("/api/mca/accounting/payments", 401)
  const login = await check("/api/auth/sign-in", 200, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
  })
  if (login.ok) {
    const session = await login.json()
    cookie = login.headers.getSetCookie().find((value) => value.startsWith("mca_session="))?.split(";")[0]
    if (!cookie) throw new Error("Authenticated session cookie was not returned.")
    await check("/api/auth/session", 200)
    await check("/api/mca/senders", 200)
    await check("/api/mca/sms/accounts", 200)
    await check("/api/mca/accounting/payments", session.permissions?.canAccessPayments ? 200 : 403)
    for (const path of ["/offers", "/advances", "/payments", "/renewals"]) await check(path, 200)
  }
} finally {
  if (cookie) await check("/api/auth/sign-out", 200, { method: "POST" })
  console.log(JSON.stringify({ origin, checks: results }, null, 2))
  if (results.some((result) => !result.passed)) process.exitCode = 1
}
