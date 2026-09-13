import { handleSupabaseAuth } from "@/lib/mca/supabase-auth-http"
export async function POST(request: Request) { return handleSupabaseAuth(request, "recovery-request") }
