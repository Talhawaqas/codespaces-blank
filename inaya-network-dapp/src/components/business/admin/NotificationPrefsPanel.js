"use client";

// src/components/business/admin/NotificationPrefsPanel.js -- choose, per event, how you want to be told (Competitive Expansion SOW V). Email, push and
// webhook messages never contain protected detail; the in-app feed and the desktop app show the full text.
import { useCallback, useEffect, useState } from "react";

const muted = "text-[var(--inaya-text-muted)]";
const LABEL = { inApp: "In app", email: "Email", push: "Push", desktop: "Desktop", webhook: "Webhook" };
export default function NotificationPrefsPanel({ orgId }) {
  const [data, setData] = useState(null); const [err, setErr] = useState("");
  const load = useCallback(async () => { try { const r = await fetch(`/api/orgs/notify/prefs?orgId=${orgId}`, { credentials: "include" }); const d = await r.json(); if (!r.ok) throw new Error(d.error); setData(d); setErr(""); } catch (e) { setErr(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  async function set(event, ch, on) {
    try { const r = await fetch("/api/orgs/notify/prefs", { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, changes: { [event]: { [ch]: on } } }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error); setData(d); } catch (e) { setErr(e.message); }
  }
  return (
    <div className="bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg p-4 mt-3">
      <h3 className="text-sm font-bold mb-1">Notifications</h3>
      <p className={`text-[12px] ${muted} mb-3`}>Choose how you are told about each event. Email, push and webhook messages say only what happened, never file names or other protected detail; the in-app feed and the desktop app show the full text. {data?.pushStatus === "NOT_CONFIGURED" ? "Push is not configured for this deployment yet, so those choices are saved but nothing is sent." : ""}</p>
      {err && <p className="text-red-400 text-[12px]" role="alert">{err}</p>}
      {!data ? <p className={`text-[12px] ${muted}`}>Loading…</p> : (
        <div className="overflow-x-auto"><table className="text-[12px] w-full"><thead><tr className={`text-left ${muted}`}><th className="pr-3 py-1">Event</th>{data.channels.map((c) => <th key={c} className="px-2">{LABEL[c]}</th>)}</tr></thead><tbody>
          {data.catalog.map((e) => <tr key={e.key} className="border-t border-[var(--inaya-overlay-10)]"><td className="pr-3 py-1">{e.label}</td>{data.channels.map((c) => <td key={c} className="px-2 text-center">{c === "webhook" && !e.webhook ? <span className={muted}>-</span> : <input type="checkbox" aria-label={`${e.label}: ${LABEL[c]}`} checked={!!data.prefs[e.key][c]} onChange={(ev) => set(e.key, c, ev.target.checked)} />}</td>)}</tr>)}
        </tbody></table></div>)}
    </div>
  );
}
