import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

export const metadata = {
  title: "Inaya Network — Sovereign Data Infrastructure",
  description: "Ahead of its time. A decentralized ecosystem for sovereign data storage, business infrastructure, security intelligence, and AI — client-side encrypted, sharded, and anchored on BNB Chain Testnet.",
  metadataBase: new URL("https://www.inayanetwork.com"),
  openGraph: {
    title: "Inaya Network — Ahead of Its Time",
    description: "Sovereign storage, business infrastructure, decentralized security, and AI — built on BNB Chain Testnet.",
    url: "https://www.inayanetwork.com",
    siteName: "Inaya Network",
    images: [{ url: "/og-banner.png", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Inaya Network — Ahead of Its Time",
    description: "Sovereign storage, business infrastructure, decentralized security, and AI — built on BNB Chain Testnet.",
    images: ["/og-banner.png"],
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col antialiased">
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}