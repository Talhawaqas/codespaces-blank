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
  title: "Business Workspace — Encrypted Document Management for Teams | Inaya Network",
  description: "Zero-knowledge encrypted document management for companies: departments, projects, approval workflows, granular permissions, and secure external sharing — built on the same client-side encryption as the core Inaya protocol.",
};

export default function BusinessLayout({ children }) {
  return <div className={`${workspaceFont.variable} contents`}>{children}</div>;
}
