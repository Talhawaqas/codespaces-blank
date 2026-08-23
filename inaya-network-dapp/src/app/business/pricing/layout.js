// app/business/pricing/layout.js — overrides the parent /business layout's
// title/description for this specific page (client component page.js
// can't export metadata itself). See app/business/layout.js for why this
// pattern exists.

export const metadata = {
  title: "Business Workspace Pricing — Inaya Network",
  description: "Compare Inaya Business Workspace plans — encrypted document management, team seats, and storage sized for teams of any size, billed transparently with no hidden egress fees.",
};

export default function BusinessPricingLayout({ children }) {
  return children;
}
