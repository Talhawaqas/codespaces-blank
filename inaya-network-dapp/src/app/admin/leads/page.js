"use client";

// app/admin/leads/page.js
//
// Inaya's own prospect CRM for Business Workspace outreach: leads by regional
// batch (PK, UK, US, EU), where each one is in the outreach, and notes on what
// they said. The outreach sender moves leads to EMAILED / FOLLOWED_UP; replies
// and outcomes are recorded here by hand.

import { useCallback, useEffect, useState } from "react";

const BATCHES = ["PK", "UK", "US", "EU"];
const STATUSES = ["NEW", "EMAILED", "FOLLOWED_UP", "REPLIED", "INTERESTED", "PILOT", "NOT_INTERESTED", "UNSUBSCRIBED", "BOUNCED"];
const STATUS_STYLE = {
  NEW: "text-[#94a3b8]", EMAILED: "text-sky-400", FOLLOWED_UP: "text-sky-300", REPLIED: "text-amber-400",
  INTERESTED: "text-emerald-400", PILOT: "text-emerald-300 font-bold", NOT_INTERESTED: "text-[#8a96ab]", UNSUBSCRIBED: "text-red-400", BOUNCED: "text-red-400",
};
const day = (iso) => (iso ? iso.slice(0, 10) : "—");
const input = "bg-black/30 border border-white/10 rounded px-2 py-1.5 text-white text-[12px]";

async function post(body) {
  const res = await fetch("/api/admin/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed.");
  return data;
}

function LeadRow({ lead, onSaved }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(lead.notes || "");
  const [err, setErr] = useState("");

  async function save(fields) {
    setErr("");
    try { onSaved((await post({ action: "update", id: lead.id, ...fields })).lead); } catch (e) { setErr(e.message); }
  }

  return (
    <>
      <tr className="border-t border-white/5 align-top">
        <td className="py-2.5 pr-3">
          <button onClick={() => setOpen(!open)} className="text-left">
            <p className="text-white font-bold text-[13px]">{lead.company}</p>
            <p className="text-[#8a96ab] text-[11px]">{[lead.sector, lead.city, lead.country].filter(Boolean).join(" · ")}</p>
          </button>
        </td>
        <td className="py-2.5 pr-3 text-[12px]">
          <p className="text-[#cbd5e1]">{lead.contactName || "—"}{lead.contactRole ? `, ${lead.contactRole}` : ""}</p>
          <p className="text-[#8a96ab] font-mono text-[11px]">{lead.email}</p>
        </td>
        <td className="py-2.5 pr-3 text-[11px] text-[#8a96ab] font-mono whitespace-nowrap">sent {day(lead.emailedAt)}<br />f/u {day(lead.followedUpAt)}</td>
        <td className="py-2.5">
          <select value={lead.status} onChange={(e) => save({ status: e.target.value })} className={`bg-black/30 border border-white/10 rounded px-2 py-1 text-[11px] ${STATUS_STYLE[lead.status]}`}>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
          {err && <p className="text-red-400 text-[11px] mt-1">{err}</p>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="pb-4">
            <div className="bg-black/20 border border-white/5 rounded-lg p-3 space-y-2 text-[12px]">
              {lead.website && <p><a href={lead.website.startsWith("http") ? lead.website : `https://${lead.website}`} target="_blank" rel="noreferrer" className="text-[#00f2fe]">{lead.website}</a>{lead.phone ? ` · ${lead.phone}` : ""}</p>}
              {lead.fitNote && <p className="text-[#cbd5e1]"><span className="text-[#8a96ab]">Why they fit: </span>{lead.fitNote}</p>}
              {lead.source && <p className="text-[#8a96ab]">Source: {lead.source}</p>}
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Notes: what they said, next step…" className={`w-full ${input}`} />
              <button onClick={() => save({ notes })} className="text-[11px] font-bold uppercase bg-white/5 border border-white/10 text-white px-3 py-1.5 rounded">Save notes</button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AddLead({ batch, onAdded }) {
  const blank = { company: "", sector: "", city: "", country: "", website: "", contactName: "", contactRole: "", email: "", fitNote: "" };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState("");
  async function submit(e) {
    e.preventDefault();
    setErr("");
    try { await post({ action: "create", lead: { ...f, batch } }); setF(blank); onAdded(); } catch (e2) { setErr(e2.message); }
  }
  return (
    <form onSubmit={submit} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-4 grid grid-cols-2 md:grid-cols-4 gap-2 mb-6">
      {Object.keys(blank).map((k) => (
        <input key={k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={k === "fitNote" ? "Why they need an ERP" : k.replace(/([A-Z])/g, " $1").toLowerCase()} className={`${input} ${k === "fitNote" ? "col-span-2 md:col-span-3" : ""}`} />
      ))}
      <button className="text-[11px] font-bold uppercase bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black rounded px-3 py-1.5">Add to {batch}</button>
      {err && <p className="col-span-full text-red-400 text-[11px]">{err}</p>}
    </form>
  );
}

export default function LeadsAdminPage() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [batch, setBatch] = useState("PK");
  const [status, setStatus] = useState("");
  const [data, setData] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/leads?batch=${batch}${status ? `&status=${status}` : ""}`);
    if (res.status === 401) { setAuthed(false); return; }
    if (res.ok) { setData(await res.json()); setAuthed(true); }
  }, [batch, status]);

  useEffect(() => { load(); }, [load]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError("");
    const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase }) });
    if (!res.ok) { setLoginError((await res.json().catch(() => ({}))).error || "Login failed."); return; }
    setPassphrase("");
    await load();
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-extrabold text-white mb-1">Leads</h1>
          <p className="text-[#94a3b8] text-xs mb-5">Enterprise Dashboard passphrase</p>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white outline-none mb-3" placeholder="Passphrase" autoFocus />
          {loginError && <p className="text-red-400 text-xs mb-3">{loginError}</p>}
          <button type="submit" className="w-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-4 py-2.5">Sign in</button>
        </form>
      </div>
    );
  }

  const counts = (data?.counts || []).filter((c) => c.batch === batch);
  const total = counts.reduce((s, c) => s + c.n, 0);
  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-6xl mx-auto">
        <a href="/admin" className="text-[#94a3b8] hover:text-slate-300 text-xs font-mono">← Admin</a>
        <div className="flex flex-wrap items-end justify-between gap-3 mt-2 mb-5">
          <div>
            <h1 className="text-2xl font-extrabold text-white">Leads</h1>
            <p className="text-[#94a3b8] text-sm">Business Workspace pilot outreach, by region.</p>
          </div>
          <button onClick={() => setShowAdd(!showAdd)} className="text-[11px] font-bold uppercase bg-white/5 border border-white/10 text-white px-3 py-2 rounded-lg">{showAdd ? "Close" : "+ Add lead"}</button>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {BATCHES.map((b) => (
            <button key={b} onClick={() => setBatch(b)} className={`px-3 py-1.5 rounded-lg text-xs font-bold ${batch === b ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "bg-white/5 text-[#94a3b8]"}`}>
              {b} <span className="font-mono opacity-70">{(data?.counts || []).filter((c) => c.batch === b).reduce((s, c) => s + c.n, 0)}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5 mb-5">
          <button onClick={() => setStatus("")} className={`px-2.5 py-1 rounded text-[11px] ${!status ? "bg-white/10 text-white" : "text-[#94a3b8]"}`}>All {total}</button>
          {STATUSES.map((s) => {
            const n = counts.find((c) => c.status === s)?.n || 0;
            return n ? <button key={s} onClick={() => setStatus(s)} className={`px-2.5 py-1 rounded text-[11px] ${status === s ? "bg-white/10 text-white" : STATUS_STYLE[s]}`}>{s.replace("_", " ")} {n}</button> : null;
          })}
        </div>

        {showAdd && <AddLead batch={batch} onAdded={load} />}

        <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-4 overflow-x-auto">
          {!data ? <p className="text-[#94a3b8] text-sm">Loading…</p> : data.leads.length === 0 ? <p className="text-[#94a3b8] text-sm">No leads in this view.</p> : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-[#8a96ab]">
                  <th className="pb-2 pr-3">Company</th><th className="pb-2 pr-3">Contact</th><th className="pb-2 pr-3">Outreach</th><th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.leads.map((l) => <LeadRow key={l.id} lead={l} onSaved={(updated) => setData((d) => ({ ...d, leads: d.leads.map((x) => (x.id === updated.id ? updated : x)) }))} />)}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
