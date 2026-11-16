// app/business/pricing/layout.js — overrides the parent /business layout's
// title/description for this specific page (client component page.js
// can't export metadata itself). See app/business/layout.js for why this
// pattern exists.

export const metadata = {
  title: "Business Workspace Pricing — Inaya Network",
  description: "Compare Inaya Business Workspace plans from $7.99 to $799 a month — an ERP-style workspace with encrypted documents, finance, CRM, HR and inventory, billed in USD with no egress fees.",
  alternates: { canonical: "/business/pricing" },
  openGraph: {
    title: "Inaya Business Workspace Pricing",
    description: "Plans from $7.99 to $799 a month. Documents, finance, CRM, HR and inventory in one encrypted workspace, billed in USD.",
    url: "https://www.inayanetwork.com/business/pricing",
    siteName: "Inaya Network",
    images: [{ url: "/og-banner.png", width: 1200, height: 630 }],
    type: "website",
  },
};

export default function BusinessPricingLayout({ children }) {
  return children;
}
