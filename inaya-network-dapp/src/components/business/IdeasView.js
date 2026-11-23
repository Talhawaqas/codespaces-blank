"use client";

// src/components/business/IdeasView.js -- "Suggest an improvement" (post-SOW #6): send an idea to Inaya, see your company's
// ideas and their status, and +1 ideas on the public board. Ideas Inaya plans go into a development sprint; everyone who
// asked or voted is told when it is planned and when it ships.
import { useCallback, useEffect, useState } from "react";
import EmptyState from "../EmptyState";
import { useErpSection } from "./erp/ErpNavContext";
const TABS = [["mine", "Your company's ideas"], ["board", "Public board"]];

const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-10)] rounded-xl";
const muted = "text-[var(--inaya-text-muted)]";
const field = "w-full rounded-lg border border-[var(--inaya-overlay-15)] bg-[var(--inaya-surface)] px-3 py-2 text-sm text-[var(--inaya-text-primary)]";
const primary = "px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] disabled:opacity-50";
const PILL = { New: "border-slate-400/40 text-slate-500", Reviewing: "border-sky-500/40 text-sky-600", Planned: "border-violet-500/40 text-violet-600", "In Progress": "border-amber-500/40 text-amber-600", Shipped: "border-emerald-500/40 text-emerald-600", Rejected: "border-red-500/40 text-red-600" };
const LABEL = { New: "Received", Reviewing: "Under review", Planned: "Planned", "In Progress": "In progress", Shipped: "Shipped", Rejected: "Not planned", Confirmed: "Under review", Resolved: "Shipped" };

async function api(path, { orgId, method = "GET", body } = {}) {
  const r = await fetch(`/api/orgs/ideas${path}${method === "GET" ? `?orgId=${orgId}` : ""}`, { method, credentials: "include", headers: { "Content-Type": "application/json" }, ...(method !== "GET" ? { body: JSON.stringify({ orgId, ...body }) } : {}) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Something went wrong."); return d;
}

function Idea({ i, onVote }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 border-t border-[var(--inaya-overlay-10)] first:border-t-0">
      <button type="button" onClick={() => onVote(i)} aria-pressed={i.votedByMe} title={i.votedByMe ? "Remove your vote" : "Vote for this"}
        className={`shrink-0 w-12 rounded-lg border text-center py-1 ${i.votedByMe ? "border-[var(--inaya-accent)] text-[var(--inaya-accent)] bg-[var(--inaya-accent-soft)]" : "border-[var(--inaya-overlay-15)] text-[var(--inaya-text-muted)]"}`}>
        <span className="block text-[11px] leading-none">▲</span><span className="block text-sm font-semibold">{i.votes}</span>
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-[var(--inaya-text-primary)]">{i.title}</p>
        {i.problem && <p className={`text-[13px] ${muted} mt-0.5`}>{i.problem}</p>}
        {i.note && <p className="text-[12px] text-red-600 mt-1">Why not: {i.note}</p>}
      </div>
      <span className={`shrink-0 text-[12px] font-semibold px-2.5 py-0.5 rounded-full border ${PILL[i.status] || PILL.New}`}>{LABEL[i.status] || i.status}{i.sprint && (i.status === "Planned" || i.status === "In Progress") ? ` · ${i.sprint}` : ""}</span>
    </li>
  );
}

export default function IdeasView({ orgId }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(""); 
  const [tab, setTab] = useErpSection("mine", TABS);
  const [f, setF] = useState({ title: "", problem: "", importance: "Important" }); const [busy, setBusy] = useState(false); const [ok, setOk] = useState("");
  const load = useCallback(() => api("", { orgId }).then(setData).catch((e) => setErr(e.message)), [orgId]);
  useEffect(() => { load(); }, [load]);
  const vote = async (i) => { try { await api(`/${i.id}/vote`, { orgId, method: "POST", body: { on: !i.votedByMe } }); load(); } catch (e) { setErr(e.message); } };
  const submit = async () => { setBusy(true); setErr(""); setOk(""); try { await api("", { orgId, method: "POST", body: f }); setF({ title: "", problem: "", importance: "Important" }); setOk("Thank you! Your idea has been sent to the Inaya team."); setTab("mine"); load(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const list = data ? (tab === "mine" ? data.mine : data.board) : [];
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] items-start">
      <div className={`${card} p-4 space-y-3`}>
        <div><h3 className="text-[15px] font-semibold text-[var(--inaya-text-primary)]">Suggest an improvement</h3><p className={`text-[13px] ${muted}`}>Tell us what would make Inaya better for your company. We review every idea and plan the popular ones into our development sprints.</p></div>
        <label className="block text-[13px] font-medium">Your idea<input className={`${field} mt-1`} maxLength={200} placeholder="e.g. Print barcode labels from the product list" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="block text-[13px] font-medium">What problem would it solve?<textarea className={`${field} mt-1`} rows={4} maxLength={3000} placeholder="Today we have to… which takes…" value={f.problem} onChange={(e) => setF({ ...f, problem: e.target.value })} /></label>
        <label className="block text-[13px] font-medium">How important is it?<select className={`${field} mt-1`} value={f.importance} onChange={(e) => setF({ ...f, importance: e.target.value })}>{["Nice to have", "Important", "Critical for us"].map((x) => <option key={x}>{x}</option>)}</select></label>
        <button className={primary} disabled={busy || f.title.trim().length < 5 || f.problem.trim().length < 10} onClick={submit}>{busy ? "Sending…" : "Send idea"}</button>
        {ok && <p className="text-[13px] text-emerald-600">{ok}</p>}{err && <p className="text-[13px] text-red-600" role="alert">{err}</p>}
        <p className={`text-[12px] ${muted}`}>Other companies only see an idea's title once we put it on the public board. Your description stays private to your company and Inaya.</p>
      </div>
      <div className={card}>
        <div className="flex items-center gap-2 px-4 pt-3" role="tablist" data-erp-tabs>
          {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`text-[13px] font-semibold px-3 py-1.5 rounded-full border ${tab === k ? "bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] border-transparent" : "border-[var(--inaya-overlay-15)] text-[var(--inaya-text-muted)]"}`}>{l}</button>)}
        </div>
        <div className="pt-2">
          {!data ? <p className={`p-4 text-sm ${muted}`}>Loading…</p> : list.length === 0
            ? <div className="p-4"><EmptyState compact icon="💡" description={tab === "mine" ? "Your company hasn't sent any ideas yet." : "Nothing on the public board yet."} /></div>
            : <ul>{list.map((i) => <Idea key={i.id} i={i} onVote={vote} />)}</ul>}
        </div>
      </div>
    </div>
  );
}
