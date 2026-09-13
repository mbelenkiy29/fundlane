import { NextResponse } from "next/server"

/** Retired Clerk endpoint. Identity is Supabase Auth; do not process these events. */
export async function POST() {
  return NextResponse.json({ error: "Clerk webhooks are retired." }, { status: 410 })
}
