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
  title: "Business Workspace — Run Your Whole Business on One Secure Workspace | Inaya Network",
  description: "An ERP-style business workspace: documents, finance, CRM, HR, inventory and procurement in one place, with every file encrypted on your own device before upload. Sign in with email and pay in USD, no wallet needed.",
};

export default function BusinessLayout({ children }) {
  return <div className={`${workspaceFont.variable} contents`}>{children}</div>;
}
