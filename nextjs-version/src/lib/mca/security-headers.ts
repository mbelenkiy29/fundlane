/**
 * Browser security headers for the Next.js / Vercel frontend.
 *
 * CSP is enforced (not Report-Only) with an allowlist of origins the app
 * actually loads. `'unsafe-inline'` stays on script/style because Next.js 16
 * injects inline bootstrapping without a nonce pipeline here; tightening to
 * hashes/nonces is a follow-up, not this change. Images allow any HTTPS host
 * because company logo URLs are operator-supplied.
 *
 * CORS: HTML and API responses stay same-origin (no ACAO). Public `/fonts`
 * files keep `Access-Control-Allow-Origin: *` so the ChatKit frame can load
 * Inter; those files are static and carry no credentials.
 */

export type NextHeader = { key: string; value: string }

const cspDirectives: Record<string, string[]> = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "form-action": [
    "'self'",
    "https://accounts.google.com",
    "https://login.microsoftonline.com",
    "https://checkout.stripe.com",
    "https://billing.stripe.com",
  ],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
  "script-src": [
    "'self'",
    "'unsafe-inline'",
    "https://cdn.platform.openai.com",
    "https://va.vercel-scripts.com",
    "https://vercel.live",
    "https://accounts.google.com",
    "https://apis.google.com",
  ],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:", "https:"],
  "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
  "connect-src": [
    "'self'",
    "https://*.supabase.co",
    "wss://*.supabase.co",
    "https://*.supabase.com",
    "wss://*.supabase.com",
    "https://accounts.google.com",
    "https://oauth2.googleapis.com",
    "https://www.googleapis.com",
    "https://apis.google.com",
    "https://login.microsoftonline.com",
    "https://graph.microsoft.com",
    "https://cdn.platform.openai.com",
    "https://*.openai.com",
    "https://*.oaiusercontent.com",
    "https://va.vercel-scripts.com",
    "https://vitals.vercel-insights.com",
    "https://vercel.live",
    "https://*.pusher.com",
    "wss://*.pusher.com",
    "https://*.pusherapp.com",
    "wss://*.pusherapp.com",
    "https://checkout.stripe.com",
    "https://api.stripe.com",
    "https://m.stripe.network",
  ],
  "frame-src": [
    "'self'",
    "https://form.jotform.com",
    "https://*.jotform.com",
    "https://accounts.google.com",
    "https://login.microsoftonline.com",
    "https://js.stripe.com",
    "https://hooks.stripe.com",
    "https://checkout.stripe.com",
    "https://vercel.live",
    "https://cdn.platform.openai.com",
  ],
  "worker-src": ["'self'", "blob:"],
  "media-src": ["'self'", "blob:"],
}

export const CONTENT_SECURITY_POLICY = Object.entries(cspDirectives)
  .map(([name, values]) => (values.length ? `${name} ${values.join(" ")}` : name))
  .join("; ")

export const STRICT_TRANSPORT_SECURITY = "max-age=63072000; includeSubDomains; preload"

export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ")

export const DOCUMENT_SECURITY_HEADERS: NextHeader[] = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "Strict-Transport-Security", value: STRICT_TRANSPORT_SECURITY },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
]

export const FONT_CORS_HEADERS: NextHeader[] = [
  { key: "Access-Control-Allow-Origin", value: "*" },
  { key: "Access-Control-Allow-Methods", value: "GET, OPTIONS" },
  { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
]

export const API_CACHE_HEADERS: NextHeader[] = [
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
]

export function nextConfigHeaders(): Array<{ source: string; headers: NextHeader[] }> {
  return [
    {
      source: "/fonts/:path*",
      headers: FONT_CORS_HEADERS,
    },
    {
      source: "/api/:path*",
      headers: API_CACHE_HEADERS,
    },
    {
      source: "/(.*)",
      headers: DOCUMENT_SECURITY_HEADERS,
    },
  ]
}

export function headerValue(headers: NextHeader[], key: string): string | undefined {
  return headers.find((header) => header.key === key)?.value
}
