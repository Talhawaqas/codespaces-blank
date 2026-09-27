"use client";

// src/components/SupportTicketLink.js
//
// A small "need a reply from our team?" link for the dApp (wallet users have no Business Workspace session). It shows only when Inaya's support desk is
// connected, and opens the customer portal, where the visitor signs in with an emailed one-time link and raises a ticket.

import { useEffect, useState } from "react";

export default function SupportTicketLink({ className = "" }) {
  const [portalPath, setPortalPath] = useState(null);
  useEffect(() => { let alive = true; fetch("/api/help/config").then((r) => r.json()).then((c) => { if (alive && c?.enabled && c.portalPath) setPortalPath(c.portalPath); }).catch(() => {}); return () => { alive = false; }; }, []);
  if (!portalPath) return null;
  return (
    <p className={className || "text-[12px] text-[#8a96ab] font-mono text-center"}>
      Need a reply from our team?{" "}
      <a href={portalPath} target="_blank" rel="noreferrer" className="text-[#00f2fe] underline">Open a support ticket</a>
    </p>
  );
}
