import "server-only"
import { createClerkClient } from "@clerk/backend"
export function getClerkClient() {
  if (!process.env.CLERK_SECRET_KEY)
    throw new Error("CLERK_SECRET_KEY is required.")
  return createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
    ...(process.env.CLERK_API_URL ? { apiUrl: process.env.CLERK_API_URL } : {}),
  })
}
