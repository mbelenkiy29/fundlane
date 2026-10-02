import { redirect } from "next/navigation"

/** Public company self-serve sign-up is retired. Invite accept and Stripe-first claim stay on their own routes. */
export default function SignUpPage() {
  redirect("/")
}
