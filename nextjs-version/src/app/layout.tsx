import { shadcn } from "@clerk/ui/themes";
import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { SidebarConfigProvider } from "@/contexts/sidebar-context";
import { inter } from "@/lib/fonts";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: {
    default: "MCA Workspace",
    template: "%s | MCA Workspace",
  },
  description: "A secure workspace for merchant cash advance teams.",
  applicationName: "MCA Workspace",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "MCA Workspace", statusBarStyle: "default" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} antialiased`}>
      <body className={inter.className}>
        <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/onboarding" signUpFallbackRedirectUrl="/onboarding" appearance={{ theme: shadcn }}>
          <ThemeProvider defaultTheme="system" storageKey="nextjs-ui-theme">
          <SidebarConfigProvider>
          {children}
          </SidebarConfigProvider>
          <Toaster richColors closeButton />
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
