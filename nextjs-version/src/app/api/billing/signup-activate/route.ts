import { signupActivate } from "@/lib/mca/signup-http"
export async function POST(request:Request) {return signupActivate(request)}
