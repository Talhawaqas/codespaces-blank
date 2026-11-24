// app/business/why-inaya/page.js -- "Why Inaya Business OS?" (Differentiators, Competitive Intelligence & AI Explainer SOW,
// 24 Nov 2026). A supporting page linked from the /business landing (the landing hero itself is untouched).
// Prices come from the canonical pricing code on the server and are passed down as plain numbers.
import { pricingFacts } from "../../../lib/whyInaya/pricing.server.js";
import WhyInayaClient from "./WhyInayaClient";

export const metadata = {
  title: "Why Inaya Business OS? Differentiators, Comparison and Team | Inaya Network",
  description: "What Inaya Business OS does, what makes it different, how it compares with Odoo, Shopify, Lightspeed, Zoho and Cin7 (with sources), the team behind it, and an optional AI walkthrough for your own business.",
  alternates: { canonical: "/business/why-inaya" },
  openGraph: {
    title: "Why Inaya Business OS?",
    description: "One connected platform for the systems that run your business: differentiators, a source-linked comparison and an optional AI walkthrough.",
    url: "https://www.inayanetwork.com/business/why-inaya",
    siteName: "Inaya Network",
    images: [{ url: "/og-banner.png", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "Why Inaya Business OS?", description: "Differentiators, a source-linked comparison and an optional AI walkthrough.", images: ["/og-banner.png"] },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: "Why Inaya Business OS?",
  url: "https://www.inayanetwork.com/business/why-inaya",
  about: { "@type": "SoftwareApplication", name: "Inaya Business OS", applicationCategory: "BusinessApplication", operatingSystem: "Web, Windows, Android" },
  publisher: { "@type": "Organization", name: "Inaya Network", url: "https://www.inayanetwork.com" },
};

export default function WhyInayaPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <WhyInayaClient prices={pricingFacts()} />
    </>
  );
}
