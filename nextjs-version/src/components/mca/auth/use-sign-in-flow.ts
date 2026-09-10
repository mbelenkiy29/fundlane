"use client"
import { useSignIn } from "@clerk/nextjs"
import { useState } from "react"
import {
  checkClerk,
  clerkErrorMessage,
  safeAuthReturnTo,
} from "@/lib/mca/auth-navigation"

export function useSignInFlow() {
  const { signIn, fetchStatus } = useSignIn()
  const [error, setError] = useState("")
  const [working, setWorking] = useState(false)
  const [codeSent, setCodeSent] = useState(false)
  async function finish() {
    if (signIn.status === "complete") {
      checkClerk(
        await signIn.finalize({
          navigate: ({ decorateUrl }) => {
            const target = safeAuthReturnTo(
              new URLSearchParams(window.location.search).get("returnTo")
            )
            window.location.href = decorateUrl(
              `/onboarding?returnTo=${encodeURIComponent(target)}`
            )
          },
        })
      )
    } else if (
      signIn.status === "needs_client_trust" ||
      signIn.status === "needs_second_factor"
    ) {
      if (
        signIn.supportedSecondFactors?.some((f) => f.strategy === "email_code")
      ) {
        checkClerk(await signIn.mfa.sendEmailCode())
        setCodeSent(true)
      }
    } else if (signIn.status === "needs_new_password") {
      window.location.href = "/reset-password"
    }
  }
  async function run(action: () => Promise<void>) {
    setWorking(true)
    setError("")
    try {
      await action()
    } catch (error) {
      setError(clerkErrorMessage(error))
    } finally {
      setWorking(false)
    }
  }
  return {
    signIn,
    error,
    busy: working || fetchStatus === "fetching",
    codeSent,
    finish,
    run,
    password: (emailAddress: string, password: string) =>
      run(async () => {
        checkClerk(await signIn.password({ emailAddress, password }))
        await finish()
      }),
    sendCode: (emailAddress: string) =>
      run(async () => {
        checkClerk(await signIn.emailCode.sendCode({ emailAddress }))
        setCodeSent(true)
      }),
    verify: (code: string, strategy: "email" | "totp" | "backup" = "email") =>
      run(async () => {
        const second =
          signIn.status === "needs_client_trust" ||
          signIn.status === "needs_second_factor"
        checkClerk(
          await (strategy === "totp"
            ? signIn.mfa.verifyTOTP({ code })
            : strategy === "backup"
              ? signIn.mfa.verifyBackupCode({ code })
              : second
                ? signIn.mfa.verifyEmailCode({ code })
                : signIn.emailCode.verifyCode({ code }))
        )
        await finish()
      }),
  }
}
