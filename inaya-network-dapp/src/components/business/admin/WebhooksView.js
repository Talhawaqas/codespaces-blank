"use client";

// src/components/business/admin/WebhooksView.js -- the organization webhook registry (Competitive Expansion SOW X): endpoints, event selection, pause,
// secret rotation, test event, delivery history with the dead-letter list and manual redelivery. Payloads carry identifiers and metadata only.
import { useCallback, useEffect, useState } from "react";
import EmptyState from "../../EmptyState";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[10px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2 py-1 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accent = "text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1 text-[11px] text-[var(--inaya-text-primary)]";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }); } catch { return "-"; } };
const j = async (path, opts = {}) => { const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts }); const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { status: r.status }); return d; };
const ST = { DELIVERED: "text-emerald-400", PENDING: "text-amber-300", SENDING: "text-amber-300", DEAD: "text-red-400", FAILED: "text-red-400" };

export default function WebhooksView({ orgId, canManage }) {
  const [data, setData] = useState(null); const [dels, setDels] = useState([]); const [err, setErr] = useState(""); const [msg, setMsg] = useState(""); const [secret, setSecret] = useState(null); const [filter, setFilter] = useState("");
  const [form, setForm] = useState({ url: "", description: "", events: new Set(), chat: false }); const [open, setOpen] = useState(false);
  const load = useCallback(async () => { try { setData(await j(`/api/orgs/webhooks?orgId=${orgId}`)); setDels((await j(`/api/orgs/webhooks/deliveries?orgId=${orgId}${filter ? `&status=${filter}` : ""}`)).deliveries); setErr(""); } catch (e) { setErr(e.message); } }, [orgId, filter]);
  useEffect(() => { if (canManage) load(); }, [load, canManage]);
  const act = async (fn, ok) => { setErr(""); setMsg(""); try { const r = await fn(); if (ok) setMsg(typeof ok === "function" ? ok(r) : ok); load(); return r; } catch (e) { setErr(e.message); } };
  if (!canManage) return <EmptyState title="Webhooks" description="Only owners, admins and integration admins can manage webhooks." />;
  if (!data) return <p className={`text-[12px] ${muted}`}>{err || "Loading…"}</p>;
  const create = () => act(() => j("/api/orgs/webhooks", { method: "POST", body: JSON.stringify({ orgId, url: form.url, description: form.description, events: [...form.events], chatMetadata: form.chat }) }), null).then((r) => { if (r) { setSecret({ url: form.url, secret: r.secret }); setOpen(false); setForm({ url: "", description: "", events: new Set(), chat: false }); } });
  return (
    <div className="space-y-3 text-[12px]">
      <div className="flex flex-wrap gap-2 items-center"><p className={muted}>Signed events for your own systems. Every delivery is signed with HMAC-SHA256 and carries a timestamp and a unique delivery id; reject anything older than five minutes.</p><button className={`${accent} ml-auto`} onClick={() => setOpen(true)}>New endpoint</button></div>
      {err && <p className="text-red-400" role="alert">{err}</p>}{msg && <p className="text-emerald-400" role="status">{msg}</p>}
      {secret && <div className={`${card} p-3 border-emerald-400/40`}><p className="text-emerald-400 font-bold">Signing secret for {secret.url}</p><code className="break-all">{secret.secret}</code><p className={muted}>Save it now. It is shown once.</p><button className={`${btn} mt-1`} onClick={() => setSecret(null)}>I saved it</button></div>}
      {open && <div className={`${card} p-3 space-y-2`}><input aria-label="Endpoint URL" className={field} placeholder="https://example.com/inaya-webhook" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /><input aria-label="Description" className={field} placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="flex flex-wrap gap-x-4 gap-y-1">{data.events.map((ev) => <label key={ev} className="flex items-center gap-1"><input type="checkbox" checked={form.events.has(ev)} onChange={(e) => { const n = new Set(form.events); e.target.checked ? n.add(ev) : n.delete(ev); setForm({ ...form, events: n }); }} /> {ev}</label>)}</div>
        {form.events.has("chat.metadata") && <label className="flex items-center gap-1 text-amber-300"><input type="checkbox" checked={form.chat} onChange={(e) => setForm({ ...form, chat: e.target.checked })} /> I understand chat events carry who, which conversation and when, never message content.</label>}
        <div className="flex gap-2"><button className={accent} disabled={!form.url || !form.events.size} onClick={create}>Create</button><button className={btn} onClick={() => setOpen(false)}>Cancel</button></div></div>}
      {data.webhooks.length === 0 ? <EmptyState compact icon="🔔" description="No endpoints yet." /> : data.webhooks.map((w) => (
        <div key={w.webhookId} className={`${card} p-3`}>
          <div className="flex flex-wrap items-center gap-2"><b className="break-all">{w.url}</b><span className={`text-[10px] font-bold uppercase ${w.active ? "text-emerald-400" : "text-amber-300"}`}>{w.active ? "active" : "paused"}</span></div>
          <p className={muted}>{w.events.join(", ")}{w.description ? ` · ${w.description}` : ""} · {w.lastSuccessAt ? `last success ${when(w.lastSuccessAt)}` : "no success yet"}{w.consecutiveFailures ? ` · ${w.consecutiveFailures} failures in a row` : ""}{w.pausedReason ? ` · ${w.pausedReason}` : ""}{w.previousSecretUntil && w.previousSecretUntil > new Date().toISOString() ? ` · old secret also valid until ${when(w.previousSecretUntil)}` : ""}</p>
          <div className="flex flex-wrap gap-1 mt-2">
            <button className={btn} onClick={() => act(() => j(`/api/orgs/webhooks/${w.webhookId}`, { method: "POST", body: JSON.stringify({ orgId, action: "test" }) }), "Test event sent. See the delivery list.")}>Send test</button>
            <button className={btn} onClick={() => act(() => j(`/api/orgs/webhooks/${w.webhookId}`, { method: "POST", body: JSON.stringify({ orgId, action: w.active ? "pause" : "resume" }) }), w.active ? "Paused." : "Resumed.")}>{w.active ? "Pause" : "Resume"}</button>
            <button className={btn} onClick={() => window.confirm("Rotate the signing secret? The old one keeps signing for 24 hours.") && act(() => j(`/api/orgs/webhooks/${w.webhookId}`, { method: "POST", body: JSON.stringify({ orgId, action: "rotate" }) }), null).then((r) => r && setSecret({ url: w.url, secret: r.secret }))}>Rotate secret</button>
            <button className={`${btn} !text-red-400`} onClick={() => window.confirm("Delete this endpoint?") && act(() => j(`/api/orgs/webhooks/${w.webhookId}?orgId=${orgId}`, { method: "DELETE" }), "Deleted.")}>Delete</button></div>
        </div>))}
      <div className={`${card} p-3`}><div className="flex items-center gap-2 mb-2"><p className="font-bold">Deliveries</p><select aria-label="Status filter" className={`${field} !w-auto`} value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">All</option><option value="PENDING">Pending</option><option value="DELIVERED">Delivered</option><option value="DEAD">Dead letter</option></select></div>
        {dels.length === 0 ? <p className={muted}>No deliveries.</p> : dels.map((d) => <div key={d.deliveryId} className="flex flex-wrap items-center gap-2 border-t border-[var(--inaya-overlay-10)] py-1"><span className={`font-bold ${ST[d.status] || ""}`}>{d.status}</span><span className="flex-1">{d.event} · {when(d.createdAt)} · {d.attempts} attempt{d.attempts === 1 ? "" : "s"}{d.lastError ? ` · ${d.lastError}` : ""}{d.nextAttemptAt ? ` · next ${when(d.nextAttemptAt)}` : ""}</span>{(d.status === "DEAD" || d.status === "FAILED") && <button className={btn} onClick={() => act(() => j("/api/orgs/webhooks/deliveries", { method: "POST", body: JSON.stringify({ orgId, deliveryId: d.deliveryId }) }), "Queued for redelivery.")}>Redeliver</button>}</div>)}</div>
    </div>
  );
}
