"use client"
import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  CreateOrganization,
  OrganizationList,
  TaskChooseOrganization,
  TaskResetPassword,
  TaskSetupMFA,
  useOrganization,
  useSession,
  useUser,
  useClerk,
} from "@clerk/nextjs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AuthShell } from "@/components/mca/auth-shell"
import TeamPanel from "@/components/mca/team-panel"
import { BillingPanel } from "@/components/mca/billing-panel"
import { requestJson } from "@/lib/mca/client"
import { clerkErrorMessage, safeAuthReturnTo } from "@/lib/mca/auth-navigation"
export default function OnboardingPage() {
  return (
    <Suspense>
      <Onboarding />
    </Suspense>
  )
}
function Onboarding() {
  const { user, isLoaded } = useUser()
  const { session } = useSession()
  const { organization } = useOrganization()
  const clerk = useClerk()
  const router = useRouter()
  const params = useSearchParams()
  const setup = params.get("setup") === "1"
  const switching = params.get("switch") === "1"
  const [create, setCreate] = useState(false)
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [team, setTeam] = useState(false)
  const [planChosen, setPlanChosen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const orgId = organization?.id
  const ready =
    !!user?.passwordEnabled &&
    user.primaryEmailAddress?.verification.status === "verified"
  const destination = safeAuthReturnTo(params.get("returnTo"))
  useEffect(() => {
    if (!isLoaded || !ready || !orgId || switching || session?.currentTask)
      return
    let cancelled = false
    requestJson<{ role: string; billingEnabled: boolean }>("/api/onboarding", { method: "POST" })
      .then((result) => {
        if (cancelled) return
        setPlanChosen(!result.billingEnabled)
        if (setup && ["admin", "super_admin"].includes(result.role))
          setTeam(true)
        else router.replace(destination)
      })
      .catch((error) => {
        if (!cancelled) setError(clerkErrorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [
    isLoaded,
    ready,
    orgId,
    switching,
    setup,
    destination,
    router,
    attempt,
    session?.currentTask,
  ])
  if (!isLoaded)
    return (
      <AuthShell
        title="Loading your account"
        description="Checking your company membership…"
      >
        <p>Please wait.</p>
      </AuthShell>
    )
  const task = session?.currentTask?.key
  if (task)
    return (
      <AuthShell
        title="Complete account setup"
        description="Finish the required step to continue."
      >
        {task === "choose-organization" ? (
          <TaskChooseOrganization redirectUrlComplete="/onboarding" />
        ) : task === "reset-password" ? (
          <TaskResetPassword redirectUrlComplete="/onboarding" />
        ) : (
          <TaskSetupMFA redirectUrlComplete="/onboarding" />
        )}
      </AuthShell>
    )
  if (!user)
    return (
      <AuthShell
        title="Sign in to continue"
        description="Your account setup is saved."
      >
        <Button onClick={() => router.replace("/sign-in")}>Sign in</Button>
      </AuthShell>
    )
  if (!ready)
    return (
      <AuthShell
        title="Finish your account"
        description="Existing accounts keep their company data. Set a new password after verifying your email."
      >
        <form
          className="space-y-5"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError("")
            try {
              await user.updatePassword({
                newPassword: password,
                signOutOfOtherSessions: true,
              })
              await user.reload()
              setAttempt((n) => n + 1)
            } catch (e) {
              setError(clerkErrorMessage(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          {user.primaryEmailAddress?.verification.status !== "verified" ? (
            <p>
              Sign out and use “Verify email” on the sign-in screen to verify
              this account.
            </p>
          ) : (
            <>
              <Label className="grid gap-2">
                New password
                <Input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Label>
              <Button disabled={busy}>Set password and continue</Button>
            </>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => clerk.signOut({ redirectUrl: "/sign-in" })}
          >
            Sign out
          </Button>
        </form>
      </AuthShell>
    )
  if (team && !planChosen) return <main className="mx-auto max-w-6xl p-6"><BillingPanel onboarding onContinue={() => setPlanChosen(true)} /></main>
  if (team)
    return (
      <main className="mx-auto max-w-6xl space-y-6 p-6">
        <header>
          <h1 className="text-2xl font-semibold">Invite your employees</h1>
          <p className="text-muted-foreground">
            Choose each employee’s role and manager. You can also invite people
            later from Team settings.
          </p>
        </header>
        <TeamPanel />
        <Button onClick={() => router.replace("/settings/connections")}>
          Continue to business setup
        </Button>
        <Button variant="ghost" onClick={() => router.replace("/dashboard")}>
          Finish later
        </Button>
      </main>
    )
  return (
    <AuthShell
      title={orgId ? "Connecting your company" : "Set up your company"}
      description="Create your company or select a company you've been invited to."
    >
      {error && (
        <div className="space-y-3">
          <p role="alert" className="text-destructive">
            {error}
          </p>
          <Button
            onClick={() => {
              setError("")
              setAttempt((n) => n + 1)
            }}
          >
            Retry setup
          </Button>
          <Button
            variant="outline"
            onClick={() => clerk.setActive({ organization: null })}
          >
            Choose another company
          </Button>
        </div>
      )}
      {(!orgId || switching) && (
        <>
          {typeof user.unsafeMetadata.companyName === "string" && (
            <p className="mb-4 text-sm text-muted-foreground">
              Company name from sign-up: {user.unsafeMetadata.companyName}
            </p>
          )}
          {create ? (
            <>
              <CreateOrganization
                routing="hash"
                skipInvitationScreen
                afterCreateOrganizationUrl="/onboarding?setup=1"
              />
              <Button variant="ghost" onClick={() => setCreate(false)}>
                Back to companies
              </Button>
            </>
          ) : (
            <>
              <OrganizationList
                hidePersonal
                skipInvitationScreen
                afterSelectOrganizationUrl={`/onboarding?returnTo=${encodeURIComponent(destination)}`}
                afterCreateOrganizationUrl="/onboarding?setup=1"
              />
              <Button
                variant="outline"
                className="mt-4 w-full"
                onClick={() => setCreate(true)}
              >
                Create a company
              </Button>
            </>
          )}
        </>
      )}
      {orgId && !switching && !error && <p>Preparing your workspace…</p>}
      <Button
        variant="ghost"
        className="mt-4"
        onClick={() => clerk.signOut({ redirectUrl: "/sign-in" })}
      >
        Sign out
      </Button>
    </AuthShell>
  )
}
