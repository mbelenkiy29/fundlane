// Run every five minutes in the deployed scheduler with the same SMS job token.
const origin = process.env.MCA_APP_ORIGIN;
const token = process.env.MCA_SMS_JOB_TOKEN;
if (!origin || !token) throw new Error("SMS job origin and credential are required.");
const response = await fetch(new URL("/api/mca/sms/jobs", origin), {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  redirect: "error",
  signal: AbortSignal.timeout(300000),
});
if (!response.ok) throw new Error(`SMS worker failed (${response.status}).`);
const result = await response.json();
console.log(JSON.stringify(result));
if (result.failedWorkspaces?.length) process.exitCode = 1;
