import "server-only"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import { cookies } from "next/headers"
import { supabasePublicConfig } from "./config"

export async function createSupabaseServerClient() {
  const store = await cookies()
  const { url, key } = supabasePublicConfig()
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (values) => {
        // Server Components cannot write cookies; proxy refreshes them before rendering.
        try { values.forEach(({ name, value, options }) => store.set(name, value, options)) } catch { /* Read-only Server Component. */ }
      },
    },
  })
}

export function getSupabaseAdminClient() {
  const { url } = supabasePublicConfig()
  const key = process.env.SUPABASE_SECRET_KEY
  if (!key) throw new Error("Supabase server secret key is not configured.")
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } })
}
