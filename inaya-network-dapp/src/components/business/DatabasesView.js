"use client";

// src/components/business/DatabasesView.js
//
// Business Workspace > Databases: provision and manage a real managed-Postgres instance through a configured
// provider (currently Supabase). Owner/admin only -- a real, potentially billable external resource.
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream A.

import { useEffect, useState, useCallback } from "react";
import { Note } from "./nas/ui";

const field = "w-full rounded border border-white/10 bg-transparent px-3 py-2 text-sm";
const label = "mb-1 block text-xs font-medium text-[var(--inaya-text-muted)]";
const btn = "rounded border border-[var(--inaya-accent)] px-3 py-1.5 text-xs font-medium text-[var(--inaya-accent)] disabled:opacity-50";

export default function DatabasesView({ orgId }) {
  const [instances, setInstances] = useState([]);
  const [providers, setProviders] = useState([]);
  const [form, setForm] = useState({ providerName: "", name: "", organizationSlug: "", region: "us-east-1", dbPassword: "", highAvailability: false });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/orgs/rds/instances?orgId=${orgId}`).then((x) => x.json()).catch(() => ({ instances: [], availableProviders: [] }));
    setInstances(r.instances || []); setProviders(r.availableProviders || []);
    if (!form.providerName && r.availableProviders?.length) setForm((f) => ({ ...f, providerName: r.availableProviders[0] }));
  }, [orgId, form.providerName]);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  async function provision(e) {
    e.preventDefault(); setBusy(true); setError(""); setNotice("");
    const res = await fetch("/api/orgs/rds/instances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, ...form }) });
    const body = await res.json();
    if (!res.ok) setError(body.error || "Could not provision this instance.");
    else { setNotice(`Provisioning "${form.name}" -- this can take a minute.`); setForm((f) => ({ ...f, name: "", dbPassword: "" })); load(); }
    setBusy(false);
  }

  async function lifecycle(instanceId, action) {
    setBusy(true);
    const res = await fetch(`/api/orgs/rds/instances/${instanceId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, action }) });
    const body = await res.json();
    if (!res.ok) setError(body.error || "Could not do that.");
    setBusy(false); load();
  }

  async function remove(instanceId, name) {
    const confirmName = window.prompt(`Type "${name}" to permanently delete this instance. This cannot be undone.`);
    if (confirmName !== name) return;
    setBusy(true);
    const res = await fetch(`/api/orgs/rds/instances/${instanceId}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, confirmName }) });
    const body = await res.json();
    if (!res.ok) setError(body.error || "Could not delete this instance.");
    setBusy(false); load();
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Databases</h2>
        <p className="text-sm text-[var(--inaya-text-muted)]">A real, managed PostgreSQL instance, hosted by a configured external provider (Vercel serverless cannot itself run a database engine, so this always provisions a real instance elsewhere on your behalf).</p>
      </header>

      {!providers.length && <Note>No database provider is configured on this server yet. Ask your operator to set SUPABASE_ACCESS_TOKEN.</Note>}

      {!!providers.length && (
        <form onSubmit={provision} className="max-w-xl space-y-3 rounded border border-white/10 p-4">
          <div>
            <label htmlFor="rds-provider" className={label}>Provider</label>
            <select id="rds-provider" className={field} value={form.providerName} onChange={set("providerName")}>{providers.map((p) => <option key={p} value={p}>{p}</option>)}</select>
          </div>
          <div><label htmlFor="rds-name" className={label}>Instance name</label><input id="rds-name" className={field} value={form.name} onChange={set("name")} required maxLength={63} placeholder="e.g. inaya-analytics" /></div>
          <div><label htmlFor="rds-org-slug" className={label}>Provider organization slug</label><input id="rds-org-slug" className={field} value={form.organizationSlug} onChange={set("organizationSlug")} required placeholder="Find this in your Supabase account settings" /></div>
          <div><label htmlFor="rds-region" className={label}>Region</label><input id="rds-region" className={field} value={form.region} onChange={set("region")} placeholder="us-east-1" /></div>
          <div><label htmlFor="rds-password" className={label}>Database password</label><input id="rds-password" type="password" className={field} value={form.dbPassword} onChange={set("dbPassword")} required minLength={12} placeholder="At least 12 characters -- stored encrypted, never shown again" /></div>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.highAvailability} onChange={set("highAvailability")} /> Request High Availability (paid add-on)</label>
          {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
          {notice && <p className="text-sm text-emerald-400" role="status">{notice}</p>}
          <button type="submit" disabled={busy} className={btn}>{busy ? "Provisioning..." : "Provision instance"}</button>
        </form>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Instances</h3>
        {!instances.length && <Note>No database instances yet.</Note>}
        <div className="space-y-2">
          {instances.map((i) => (
            <div key={i.instanceId} className="rounded border border-white/10 p-3 text-sm">
              <div className="flex items-center justify-between"><span className="font-medium">{i.name}</span><span className="text-xs uppercase text-[var(--inaya-text-muted)]">{i.status}</span></div>
              <div className="mt-1 text-xs text-[var(--inaya-text-muted)]">{i.provider} &middot; {i.engine} &middot; {i.region || "region unknown"}{i.highAvailability ? " · HA" : ""}</div>
              <div className="mt-2 flex gap-2">
                <button type="button" className={btn} disabled={busy} onClick={() => lifecycle(i.instanceId, "start")}>Start</button>
                <button type="button" className={btn} disabled={busy} onClick={() => lifecycle(i.instanceId, "stop")}>Stop</button>
                <button type="button" className={btn} disabled={busy} onClick={() => remove(i.instanceId, i.name)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
