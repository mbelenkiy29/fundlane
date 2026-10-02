import { signupCheckout } from "@/lib/mca/signup-http"
export async function POST(request:Request) {return signupCheckout(request)}
