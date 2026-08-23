import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

// SEO note: og:image / twitter:image are intentionally NOT set manually
// here — app/opengraph-image.js (next/og) generates that image at request
// time and Next.js wires it into this metadata automatically. The old
// manual reference to /og-banner.png pointed at a file that never
// existed in /public, so every shared link rendered a blank preview.
export const metadata = {
  title: "Inaya Network — Sovereign Data Infrastructure",
  description: "Ahead of its time. A decentralized ecosystem for sovereign data storage, business infrastructure, security intelligence, and AI — client-side encrypted, sharded, and anchored on BNB Chain Testnet.",
  metadataBase: new URL("https://www.inayanetwork.com"),
  // SEO TODO (only you can fill this in — see the SEO handoff guide):
  // create a Google Search Console property for inayanetwork.com, choose
  // the "HTML tag" verification method, and paste just the content value
  // (not the whole <meta> tag) below:
  // verification: { google: "PASTE_YOUR_VERIFICATION_CODE_HERE" },
  openGraph: {
    title: "Inaya Network — Ahead of Its Time",
    description: "Sovereign storage, business infrastructure, decentralized security, and AI — built on BNB Chain Testnet.",
    url: "https://www.inayanetwork.com",
    siteName: "Inaya Network",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Inaya Network — Ahead of Its Time",
    description: "Sovereign storage, business infrastructure, decentralized security, and AI — built on BNB Chain Testnet.",
  },
};

// Organization + WebSite structured data (JSON-LD) — read by Google to
// understand what Inaya is, who leads it, and how to contact it. Founder
// names/titles and contact emails match what's already published on the
// site's About Us / Contact Us sections — nothing invented here.
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Inaya Network",
  url: "https://www.inayanetwork.com",
  logo: "https://www.inayanetwork.com/inaya-logo.png",
  description: "A decentralized ecosystem for sovereign data storage, business infrastructure, security intelligence, and AI, built on BNB Chain.",
  founder: [
    { "@type": "Person", name: "Talha Waqas", jobTitle: "Founder & CTO" },
    { "@type": "Person", name: "Yakub Adnan", jobTitle: "Co-Founder & Growth Lead" },
  ],
  employee: [{ "@type": "Person", name: "Fibha Urooj", jobTitle: "Chief Financial Officer" }],
  sameAs: [
    "https://t.me/inayanetwork",
    "https://youtube.com/@inayanetworkofficial",
    "https://github.com/Talhawaqas/custody-sdk",
  ],
  contactPoint: [
    { "@type": "ContactPoint", email: "contact@inayanetwork.com", contactType: "customer support" },
    { "@type": "ContactPoint", email: "investors@inayanetwork.com", contactType: "investor relations" },
  ],
};

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Inaya Network",
  url: "https://www.inayanetwork.com",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col antialiased">
        {children}
        <Analytics />
        <SpeedInsights />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
        />
      </body>
    </html>
  );
}