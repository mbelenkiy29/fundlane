import { ImageResponse } from "next/og"

export const dynamic = "force-static"

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          background: "#09090f",
          color: "#f5f3ff",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontSize: 34,
            fontWeight: 700,
          }}
        >
          <svg width="45" height="45" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="9" fill="#a78bfa" />
            <path
              d="M9 9h15l-4 4H9V9Zm0 7h11l-4 4H9v-4Zm0 7h7l-4 4H9v-4Z"
              fill="white"
            />
          </svg>
          fundlane
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              display: "flex",
              fontSize: 67,
              lineHeight: 1.08,
              fontWeight: 700,
              letterSpacing: -3,
              maxWidth: 940,
            }}
          >
            Run your MCA brokerage from application to renewal.
          </div>
          <div style={{ display: "flex", fontSize: 23, color: "#b4aec6" }}>
            One workspace. A clear next step for every deal.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: "1px solid #302940",
            paddingTop: 24,
            fontSize: 19,
          }}
        >
          <span>Built for MCA brokerages</span>
          <span style={{ color: "#a78bfa" }}>fundlane.io</span>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  )
}
