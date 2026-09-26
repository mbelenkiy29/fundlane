import type { Metadata } from "next";
import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { SidebarConfigProvider } from "@/contexts/sidebar-context";
import { inter } from "@/lib/fonts";
import { marketingFontClasses } from "@/lib/marketing/fonts";
import { marketingPolishEnabled } from "@/lib/marketing/polish";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: {
    default: "Fundlane",
    template: "%s | Fundlane",
  },
  description: "A secure workspace for merchant cash advance teams.",
  applicationName: "Fundlane",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Fundlane", statusBarStyle: "default" },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const currentMarketingFonts = marketingPolishEnabled() ? "" : ` ${await marketingFontClasses(false)}`;
  return (
    <html lang="en" className={`${inter.variable}${currentMarketingFonts} antialiased`}>
      <body className={inter.className}>
          <ThemeProvider defaultTheme="system" storageKey="nextjs-ui-theme">
          <SidebarConfigProvider>
          {children}
          </SidebarConfigProvider>
          <Toaster richColors closeButton />
          </ThemeProvider>
      </body>
    </html>
  );
}
