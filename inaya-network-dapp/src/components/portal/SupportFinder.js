"use client";

// Public "Get support" page: a customer who was told to contact a company's support enters that company's portal
// address (or pastes the link they were given) and lands on its portal. Nothing is listed or searched: portals are
// private to each company's customers, so there is no directory to browse and nothing to enumerate.

import { useState } from "react";

const CSS = `
.sf{min-height:100vh;background:#f6f7f9;color:#14181f;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px 16px}
@media (prefers-color-scheme:dark){.sf{background:#0f1218;color:#e8ebf0}.sf-card{background:#181c24;border-color:#2a303b}.sf input{background:#0f1218;color:#e8ebf0;border-color:#2a303b}.sf-mut{color:#9aa4b2}}
.sf-card{background:#fff;border:1px solid #dfe3ea;border-radius:12px;padding:24px;width:100%;max-width:30rem}
.sf h1{font-size:22px;margin:0 0 8px}.sf-mut{color:#5b6472;font-size:13px}
.sf input{width:100%;padding:10px;border:1px solid #dfe3ea;border-radius:8px;font:inherit;margin:6px 0 12px}
.sf button{padding:10px 16px;border-radius:8px;border:1px solid #1f4fd8;background:#1f4fd8;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.sf :focus-visible{outline:2px solid #6f96ff;outline-offset:2px}
`;

function parse(input) {
  const v = String(input || "").trim().toLowerCase();
  const m = v.match(/\/(?:portal|support)\/([a-z0-9-]{4,40})/);
  const slug = m ? m[1] : v.replace(/^https?:\/\/[^/]+\/?/, "").replace(/[^a-z0-9-]/g, "");
  return /^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/.test(slug) ? slug : "";
}

export default function SupportFinder() {
  const [v, setV] = useState(""); const [err, setErr] = useState("");
  const go = async (e) => {
    e.preventDefault(); setErr("");
    const slug = parse(v);
    if (!slug) { setErr("Enter the portal address you were given, for example acme-support, or paste the link."); return; }
    try { const r = await fetch(`/api/portal/${slug}/config`); if (r.status === 404) { setErr("We could not find a support portal with that address. Check the spelling, or ask the company for the link."); return; } } catch { /* offline: try anyway */ }
    window.location.href = `/portal/${slug}`;
  };
  return (
    <main className="sf">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <form className="sf-card" onSubmit={go}>
        <h1>Get support</h1>
        <p className="sf-mut">Each company runs its own support portal. Enter the address the company gave you (or paste the link) to open a request or follow an existing one.</p>
        <label htmlFor="sf-in">Portal address</label>
        <input id="sf-in" value={v} onChange={(e) => setV(e.target.value)} placeholder="acme-support" autoComplete="off" />
        {err && <p role="alert" style={{ color: "#a4262c" }}>{err}</p>}
        <button type="submit">Continue</button>
        <p className="sf-mut" style={{ marginTop: 16 }}>Companies: switch your portal on under Business Workspace → Customer Support → Portal &amp; sharing to get your address, link and QR code.</p>
      </form>
    </main>
  );
}
