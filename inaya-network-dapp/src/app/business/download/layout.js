// app/business/download/layout.js — see app/business/layout.js for why
// this pattern (server layout carrying metadata for a client page.js)
// exists.

export const metadata = {
  title: "Download Business OS — Inaya Network",
  description: "Get the Inaya Business OS desktop app — the ERP-style workspace for documents, finance, CRM, HR and inventory, native on Windows and Linux with auto-updates.",
  alternates: { canonical: "/business/download" },
  openGraph: {
    title: "Download Inaya Business OS for Windows and Linux",
    description: "The ERP-style business workspace as a native desktop app, with auto-updates.",
    url: "https://www.inayanetwork.com/business/download",
    siteName: "Inaya Network",
    images: [{ url: "/og-banner.png", width: 1200, height: 630 }],
    type: "website",
  },
};

export default function BusinessDownloadLayout({ children }) {
  return children;
}
