// app/business/layout.js
//
// page.js in this segment is "use client" and can't export metadata
// directly — Next.js requires metadata exports from Server Components,
// so this server-component layout carries it instead. Previously this
// route silently inherited the homepage's exact title/description.
//
// Business Workspace redesign (2026-10-18): the workspace's typeface,
// Instrument Sans, is loaded here (self-hosted by next/font, no runtime
// request to Google) and exposed as --font-workspace for the `.bw` scope
// in globals.css.

import { Instrument_Sans } from "next/font/google";

const workspaceFont = Instrument_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-workspace", display: "swap" });

export const metadata = {
  title: "Inaya Business OS — Run Your Whole Business on One Connected System | Inaya Network",
  description: "Inaya Business OS is a business operations platform: back office (finance, HR, inventory, purchasing, documents), front office (point of sale) and online selling (own web store with Shopify and WooCommerce sync) in one connected system, with documents encrypted on your own device. Pay in USD or PKR, no wallet needed.",
  keywords: ["business operating system", "business operations platform", "point of sale", "POS software", "Shopify integration", "WooCommerce integration", "business workspace", "ERP software", "small business ERP", "encrypted document management", "CRM", "invoicing software", "HR software", "inventory management", "procurement software", "secure business software", "Inaya Network"],
  alternates: { canonical: "/business" },
  openGraph: {
    title: "Inaya Business OS — Run Your Whole Business on One Connected System",
    description: "Back office, front office and online selling in one connected system: finance, HR, inventory, point of sale and your own web store with Shopify and WooCommerce sync.",
    url: "https://www.inayanetwork.com/business",
    siteName: "Inaya Network",
    images: [{ url: "/og-banner.png", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Inaya Business OS — Run Your Whole Business on One Connected System",
    description: "Back office, front office and online selling in one connected system.",
    images: ["/og-banner.png"],
  },
};

export default function BusinessLayout({ children }) {
  return <div className={`${workspaceFont.variable} contents`}>{children}</div>;
}
