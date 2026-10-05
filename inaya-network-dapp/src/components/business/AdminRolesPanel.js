"use client";

// src/components/business/AdminRolesPanel.js -- assign scoped administrator roles (Competitive Expansion SOW T). Owner/admin only.
import { useCallback, useEffect, useState } from "react";

const muted = "text-[var(--inaya-text-muted)]";
export default function AdminRolesPanel({ orgId, canManage }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState("");
  const load = useCallback(async () => { try { const r = await fetch(`/api/orgs/admin-roles?orgId=${orgId}`, { credentials: "include" }); const d = await r.json(); if (!r.ok) throw new Error(d.error); setData(d); setErr(""); } catch (e) { setErr(e.message); } }, [orgId]);
  useEffect(() => { if (canManage) load(); }, [load, canManage]);
  async function toggle(m, role, on) {
    const next = on ? [...m.adminRoles, role] : m.adminRoles.filter((r) => r !== role); setBusy(m.email + role);
    try { const r = await fetch("/api/orgs/admin-roles", { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, email: m.email, adminRoles: next }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error); await load(); } catch (e) { setErr(e.message); } finally { setBusy(""); }
  }
  if (!canManage) return null;
  const members = data ? data.members.filter((m) => m.role === "member") : [];
  return (
    <div className="bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg p-4 mt-3">
      <h3 className="text-sm font-bold mb-1">Administrator roles</h3>
      <p className={`text-[12px] ${muted} mb-3`}>Give someone just the administrative scope they need. Owners and admins already hold every scope. An auditor can read security, device, backup and governance records but change nothing.</p>
      {err && <p className="text-red-400 text-[12px] mb-2" role="alert">{err}</p>}
      {!data ? <p className={`text-[12px] ${muted}`}>Loading…</p> : members.length === 0 ? <p className={`text-[12px] ${muted}`}>Everyone here is already an owner or admin.</p> : members.map((m) => (
        <details key={m.email} className="border-t border-[var(--inaya-overlay-10)] py-2 first:border-0">
          <summary className="cursor-pointer text-[12px]"><b>{m.email}</b> <span className={muted}>{m.adminRoles.length ? m.adminRoles.join(", ") : "no administrator roles"}</span></summary>
          <div className="grid sm:grid-cols-2 gap-1 mt-2">{Object.entries(data.catalog).map(([k, label]) => <label key={k} className="flex items-start gap-2 text-[12px]"><input type="checkbox" className="mt-0.5" checked={m.adminRoles.includes(k)} disabled={busy === m.email + k} onChange={(e) => toggle(m, k, e.target.checked)} /><span><b>{k}</b><br /><span className={muted}>{label}</span></span></label>)}</div>
        </details>))}
    </div>
  );
}
