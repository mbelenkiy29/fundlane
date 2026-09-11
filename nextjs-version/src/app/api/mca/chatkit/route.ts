import { chatkitGateway } from "@/lib/mca/assistant/gateway"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export async function POST(request: Request) { return chatkitGateway(request) }
