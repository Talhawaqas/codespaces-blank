"use client";

// src/components/BrandHeader.js -- the heading of public pages (secure links, file requests, data rooms). Shows the organization's logo and portal
// title when it has set branding, otherwise the Inaya mark. Everything is rendered as text or as an <img> from a verified PNG/JPEG/WebP data URL: no HTML
// from branding ever reaches the page. Terms and privacy text open as plain text.

import { useEffect, useState } from "react";

export default function BrandHeader({ branding, subtitle }) {
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (!branding?.favicon) return; let link = document.querySelector("link[rel~='icon']"); const prev = link?.href;
    if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); } link.href = branding.favicon; return () => { if (prev) link.href = prev; };
  }, [branding?.favicon]);
  const accent = /^#[0-9a-fA-F]{6}$/.test(branding?.accent || "") ? branding.accent : "#00f2fe";
  return (
    <div className="text-center mb-6">
      {branding?.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={branding.logo} alt={branding.portalTitle || "Logo"} className="mx-auto max-h-12 mb-2" />
      ) : null}
      <h1 className="text-lg font-extrabold text-white">{branding?.portalTitle ? <span style={{ color: accent }}>{branding.portalTitle}</span> : <>INAYA <span style={{ color: accent }}>NETWORK</span></>}</h1>
      {subtitle && <p className="text-[#8a96ab] text-xs mt-1">{subtitle}</p>}
      {(branding?.terms || branding?.privacy || branding?.supportUrl) && (
        <p className="text-[11px] text-[#8a96ab] mt-2 space-x-3">
          {branding.terms && <button className="underline" onClick={() => setOpen(open === "terms" ? null : "terms")}>Terms</button>}
          {branding.privacy && <button className="underline" onClick={() => setOpen(open === "privacy" ? null : "privacy")}>Privacy</button>}
          {branding.supportUrl && <a className="underline" href={branding.supportUrl} target="_blank" rel="noopener noreferrer">Support</a>}
        </p>)}
      {open && <pre className="text-left text-[11px] text-[#c8d3e6] whitespace-pre-wrap bg-black/30 border border-white/10 rounded-lg p-3 mt-2 max-h-48 overflow-auto">{branding[open]}</pre>}
      {branding?.footerText && <p className="text-[11px] text-[#8a96ab] mt-2">{branding.footerText}</p>}
    </div>
  );
}
