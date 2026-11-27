"use client";

// src/components/business/PowerBiView.js -- Admin > Integrations > Microsoft Power BI (Enterprise, or the Business add-on; src/lib/analytics/oauth.js).
// What Power BI can read, what the customer needs from Microsoft, the connector download, who is connected, and Revoke.

import { useCallback, useEffect, useState } from "react";

async function api(path, options) {
  const res = await fetch(path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}
const card = "bg-[var(--inaya-surface)] border border-[var(--inaya-overlay-10)] rounded-2xl p-5";
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "never");

export default function PowerBiView({ orgId }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState("");
  const load = useCallback(async () => { try { setD(await api(`/api/orgs/powerbi?orgId=${orgId}`)); } catch (e) { setErr(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  async function revoke(id) {
    if (!window.confirm("Disconnect this Power BI connection? Its next refresh will fail until someone signs in again.")) return;
    setBusy(id); setErr(""); try { setD(await api("/api/orgs/powerbi", { method: "POST", body: JSON.stringify({ orgId, action: "revoke", connectionId: id }) })); } catch (e) { setErr(e.message); } finally { setBusy(""); }
  }
  async function toggleMembers(v) { setBusy("members"); setErr(""); try { setD(await api("/api/orgs/powerbi", { method: "PATCH", body: JSON.stringify({ orgId, membersMayConnect: v }) })); } catch (e) { setErr(e.message); } finally { setBusy(""); } }

  if (!d) return <p className="text-sm text-[var(--inaya-text-muted)]">{err || "Loading…"}</p>;
  const active = d.connections.filter((c) => !c.revokedAt);
  return (
    <div className="space-y-4 max-w-4xl">
      <div className={card}>
        <p className="text-[var(--inaya-text-primary)] text-lg font-extrabold">Microsoft Power BI</p>
        <p className="text-[var(--inaya-text-muted)] text-sm mt-1">Build your own dashboards in Power BI from your Inaya data: sales, refunds, invoices, payments, expenses, stock, purchasing, customers, suppliers, work and repair orders, staff hours and leave. Power BI can only <b>read</b>, and each person sees only what their role, departments and branches allow in Inaya.</p>
        {!d.entitled ? <p className="mt-3 text-sm text-amber-500">Power BI is included in the Enterprise package. Business companies can add it in Billing &gt; Add-ons.</p>
          : !d.switchedOn ? <p className="mt-3 text-sm text-amber-500">Power BI is in pilot. Ask Inaya support to switch it on for your company.</p>
          : <p className="mt-3 text-sm text-emerald-500">Power BI is available for your company.</p>}
      </div>

      {d.entitled && d.switchedOn && (<>
        <div className={card}>
          <p className="text-[var(--inaya-text-primary)] font-bold">Connect in 3 steps</p>
          <ol className="list-decimal pl-5 text-sm text-[var(--inaya-text-primary)] space-y-1 mt-2">
            <li>Download the <a className="text-[var(--inaya-accent)] underline" href="/downloads/powerbi/Inaya.mez" download>Inaya connector (Inaya.mez)</a> and the <a className="text-[var(--inaya-accent)] underline" href="/downloads/powerbi/Inaya-Starter-Reports.zip" download>starter reports</a>.</li>
            <li>Put Inaya.mez in <code>Documents\Power BI Desktop\Custom Connectors</code>. In Power BI Desktop, open File &gt; Options and settings &gt; Options &gt; Security, and under Data Extensions choose <b>&quot;Allow any extension to load without validation or warning&quot;</b>. Restart Power BI Desktop.</li>
            <li>Get data &gt; <b>Inaya Business OS</b> &gt; Sign in, pick this company and allow. Or open the starter reports.</li>
          </ol>
          <p className="text-xs text-[var(--inaya-text-muted)] mt-3">Power BI is a separate Microsoft product. Power BI Desktop is free. Publishing reports and scheduled refresh in the Power BI Service need Power BI Pro (or Premium) licences from Microsoft, and Microsoft&apos;s on-premises data gateway running on an always-on Windows computer, because the Inaya connector is not certified by Microsoft. The full guide: <a className="text-[var(--inaya-accent)] underline" href="/docs/products/power-bi" target="_blank" rel="noreferrer">inayanetwork.com/docs/products/power-bi</a>.</p>
        </div>

        {d.canManage && (
          <div className={card}>
            <label className="flex items-center gap-2 text-sm text-[var(--inaya-text-primary)]"><input type="checkbox" checked={d.membersMayConnect} disabled={busy === "members"} onChange={(e) => toggleMembers(e.target.checked)} /> Let members (not only owners and admins) connect Power BI</label>
            <p className="text-xs text-[var(--inaya-text-muted)] mt-1">Each member still sees only the data their own role, departments and branches allow.</p>
          </div>
        )}
      </>)}

      <div className={card}>
        <p className="text-[var(--inaya-text-primary)] font-bold">{d.canManage ? "Connections" : "Your connections"} ({active.length} active)</p>
        {d.connections.length === 0 ? <p className="text-sm text-[var(--inaya-text-muted)] mt-2">No one has connected Power BI yet.</p> : (
          <table className="w-full text-sm mt-2"><thead><tr className="text-left text-[var(--inaya-text-muted)] text-xs"><th className="py-1">Person</th><th>Connected</th><th>Last used</th><th>Status</th><th /></tr></thead>
            <tbody>{d.connections.map((c) => (
              <tr key={c.id} className="border-t border-[var(--inaya-overlay-10)]">
                <td className="py-2">{c.email}</td><td>{when(c.createdAt)}</td><td>{when(c.lastUsedAt)}</td>
                <td>{c.revokedAt ? <span className="text-[var(--inaya-text-muted)]">Disconnected {when(c.revokedAt)}</span> : <span className="text-emerald-500">Active</span>}</td>
                <td className="text-right">{!c.revokedAt && <button type="button" onClick={() => revoke(c.id)} disabled={busy === c.id} className="text-red-400 hover:underline disabled:opacity-40">Disconnect</button>}</td>
              </tr>))}</tbody></table>)}
        <p className="text-xs text-[var(--inaya-text-muted)] mt-3">Disconnecting stops new data at once: every request from Power BI is checked again. Data already downloaded into Power BI files stays there; Inaya cannot erase it.</p>
      </div>
      {err && <p className="text-red-400 text-sm" role="alert">{err}</p>}
    </div>
  );
}
