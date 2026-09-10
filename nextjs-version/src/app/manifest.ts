import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MCA Workspace",
    short_name: "MCA",
    description: "Secure merchant cash advance operations for brokerage teams.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#18181b",
    orientation: "any",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcuts: [
      { name: "Home", short_name: "Home", url: "/dashboard" },
      { name: "Deals", short_name: "Deals", url: "/deals" },
      { name: "Settings", short_name: "Settings", url: "/settings" },
    ],
  }
}
