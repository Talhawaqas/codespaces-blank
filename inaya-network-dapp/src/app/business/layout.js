// app/business/layout.js
//
// page.js in this segment is "use client" and can't export metadata
// directly — Next.js requires metadata exports from Server Components,
// so this server-component layout carries it instead. Previously this
// route silently inherited the homepage's exact title/description.

export const metadata = {
  title: "Business Workspace — Encrypted Document Management for Teams | Inaya Network",
  description: "Zero-knowledge encrypted document management for companies: departments, projects, approval workflows, granular permissions, and secure external sharing — built on the same client-side encryption as the core Inaya protocol.",
};

export default function BusinessLayout({ children }) {
  return children;
}
