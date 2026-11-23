// app/business/page.js
//
// Server entry for /business. Reads only whether a session cookie exists (never its value) so the
// signed-out landing page is server-rendered for visitors and search crawlers; the workspace itself
// is the client component in BusinessClient.js. Also emits the Workspace's structured data.

import { cookies } from "next/headers";
import BusinessPage from "./BusinessClient";
// Same name as SESSION_COOKIE in src/lib/orgs.js (not imported: that module pulls in the database client).
const SESSION_COOKIE = "inaya_org_session";

const softwareJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Inaya Business OS",
  alternateName: ["Inaya Business Operations Platform", "Inaya Business Workspace"],
  url: "https://www.inayanetwork.com/business",
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "ERP",
  operatingSystem: "Web, Windows, Linux, Android",
  description:
    "A business operations platform: back office (finance, HR, inventory, purchasing, documents), front office (point of sale) and online selling (own web store with Shopify and WooCommerce sync) in one connected system. Sign in with email and pay in USD or PKR, no wallet needed.",
  featureList: [
    "Point of sale with returns, shifts and cash control",
    "Own web store with Shopify and WooCommerce sync",
    "Client-side encrypted document management with approvals",
    "Finance: invoices, expenses and revenue reporting",
    "CRM, appointment booking and email campaigns",
    "HR: employee records and leave management",
    "Inventory and procurement with purchase orders",
    "Tasks, projects, insights and team chat",
    "Industry editions: healthcare, legal, education, hospitality, government and more",
  ],
  offers: {
    "@type": "AggregateOffer",
    priceCurrency: "USD",
    lowPrice: "7.99",
    highPrice: "799",
    offerCount: 4,
    url: "https://www.inayanetwork.com/business/pricing",
  },
  publisher: { "@type": "Organization", name: "Inaya Network", url: "https://www.inayanetwork.com" },
};

export default async function Page() {
  const cookieStore = await cookies();
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }} />
      <BusinessPage initialSignedOut={!cookieStore.has(SESSION_COOKIE)} />
    </>
  );
}
