"use client";

// src/components/business/HelpSupportView.js
//
// Business Workspace > Help & Support: any signed-in member asks Inaya's own support desk for help. Posts to /api/help/ticket, which files the ticket in
// the same Customer Support module the customer portal uses. The requester is the signed-in account; nothing here chooses where the ticket goes.

import { useEffect, useState } from "react";
import { Note } from "./nas/ui";

const CATEGORIES = ["General", "Billing", "Account", "Access", "Security", "Storage", "API", "Integration", "Migration", "Other"];
const field = "w-full rounded border border-white/10 bg-transparent px-3 py-2 text-sm";
const label = "mb-1 block text-xs font-medium text-[var(--inaya-text-muted)]";

export default function HelpSupportView({ orgId }) {
  const [config, setConfig] = useState(null); const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ subject: "", category: "General", description: "" });
  const [result, setResult] = useState(null); const [error, setError] = useState("");
  useEffect(() => { fetch("/api/help/config").then((r) => r.json()).then(setConfig).catch(() => setConfig({ enabled: false })); }, []);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const res = await fetch("/api/help/ticket", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, orgId, page: "Business Workspace", idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }) });
      const data = await res.json();
      if (!res.ok) setError(data.error || "Could not send your request."); else { setResult(data); setForm({ subject: "", category: "General", description: "" }); }
    } catch { setError("Could not reach the server. Please try again."); }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Help &amp; Support</h2>
        <p className="text-sm text-[var(--inaya-text-muted)]">Ask the Inaya team for help. We reply by email to the address you are signed in with.</p>
      </header>
      {config && !config.enabled && <Note>Inaya support is not connected yet. Please try again later.</Note>}
      {result ? (
        <div className="space-y-3 rounded border border-white/10 p-4" role="status">
          <p className="text-sm font-medium">Thanks, we have your request: <span className="font-mono">{result.ticketNumber}</span></p>
          <p className="text-sm text-[var(--inaya-text-muted)]">Our team will reply by email. Keep the reference above if you need to follow up.</p>
          {result.portalPath && <a className="inline-block text-sm underline" href={result.portalPath} target="_blank" rel="noreferrer">Track your requests in the support portal</a>}
          <div><button type="button" className="rounded border border-white/10 px-3 py-1.5 text-xs" onClick={() => setResult(null)}>Send another request</button></div>
        </div>
      ) : (
        <form onSubmit={submit} className="max-w-xl space-y-3">
          <div><label htmlFor="help-subject" className={label}>Title</label><input id="help-subject" className={field} value={form.subject} onChange={set("subject")} maxLength={200} required minLength={3} placeholder="For example: I cannot download a file" /></div>
          <div><label htmlFor="help-category" className={label}>What is it about?</label><select id="help-category" className={field} value={form.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
          <div><label htmlFor="help-description" className={label}>Describe what you need</label><textarea id="help-description" className={`${field} min-h-[140px]`} value={form.description} onChange={set("description")} maxLength={8000} required minLength={10} placeholder="What happened, what you expected, and any error message you saw. Please do not include passwords or private keys." /></div>
          {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
          <button type="submit" disabled={busy || (config && !config.enabled)} className="rounded border border-[var(--inaya-accent)] px-4 py-2 text-sm font-medium text-[var(--inaya-accent)] disabled:opacity-50">{busy ? "Sending..." : "Send to Inaya support"}</button>
        </form>
      )}
    </div>
  );
}
