"use client";

// src/components/business/S3ManagementPanels.js
//
// Business Workspace panels for the S3/Azure management API that previously had no UI (tags, batch
// operations, inventory, analytics, credential policy findings) plus the Azure SAS link generator.
// Every panel reads and writes through /api/orgs/s3-compat/manage and /api/orgs/s3-compat/sas -- nothing
// here is computed in the browser except formatting.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import { formatBytes, parseTagInput } from "./s3ManagementHelpers.js";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const manage = (orgId, query) => api(`/api/orgs/s3-compat/manage?orgId=${orgId}&${query}`);
const post = (orgId, body) => api("/api/orgs/s3-compat/manage", { method: "POST", body: JSON.stringify({ orgId, ...body }) });

const btn = "text-[10px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 text-[var(--inaya-text-muted)] disabled:opacity-40";
const input = "bg-black/45 border border-white/15 rounded-md px-2 py-1 text-[11px] text-[var(--inaya-text-primary)]";
const SEVERITY = { HIGH: "text-red-400", MEDIUM: "text-amber-400", LOW: "text-[var(--inaya-text-muted)]" };

function BucketPicker({ buckets, value, onChange, allowAll = false }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={input}>
      {allowAll && <option value="">All buckets</option>}
      {!allowAll && !value && <option value="">Choose a bucket</option>}
      {buckets.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
    </select>
  );
}

function TagsAndBatchPanel({ orgId, buckets }) {
  const [bucket, setBucket] = useState("");
  const [objects, setObjects] = useState(null);
  const [selected, setSelected] = useState({});
  const [tagText, setTagText] = useState("");
  const [operation, setOperation] = useState("SET_TAGS");
  const [mode, setMode] = useState("GOVERNANCE");
  const [until, setUntil] = useState("");
  const [hold, setHold] = useState(true);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setObjects(null); setSelected({}); setResult(null);
    if (!bucket) return;
    manage(orgId, `action=objects&bucket=${encodeURIComponent(bucket)}`).then((d) => setObjects(d.contents || [])).catch((e) => setError(e.message));
  }, [orgId, bucket]);

  const keys = Object.keys(selected).filter((k) => selected[k]);

  async function run() {
    setBusy(true); setError(""); setResult(null);
    try {
      const params =
        operation === "SET_TAGS" ? { tags: parseTagInput(tagText) }
        : operation === "SET_RETENTION" ? { retentionMode: mode, retentionUntil: new Date(until).toISOString() }
        : { legalHold: hold };
      setResult(await post(orgId, { action: "batch", bucket, keys, operation, params }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const ready = bucket && keys.length > 0 && (operation !== "SET_RETENTION" || until);

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-[var(--inaya-text-muted)]">Apply one change to many objects at once. Every object reports its own result, so a failure on one never hides the rest.</p>
      <div className="flex gap-2 flex-wrap items-center">
        <BucketPicker buckets={buckets} value={bucket} onChange={setBucket} />
        <select value={operation} onChange={(e) => setOperation(e.target.value)} className={input}>
          <option value="SET_TAGS">Set tags</option>
          <option value="SET_RETENTION">Set retention (needs Object Lock)</option>
          <option value="SET_LEGAL_HOLD">Legal hold</option>
        </select>
        {operation === "SET_TAGS" && <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="project=apollo, tier=gold" className={`${input} w-56`} />}
        {operation === "SET_RETENTION" && (
          <>
            <select value={mode} onChange={(e) => setMode(e.target.value)} className={input}><option>GOVERNANCE</option><option>COMPLIANCE</option></select>
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={input} />
          </>
        )}
        {operation === "SET_LEGAL_HOLD" && (
          <select value={hold ? "on" : "off"} onChange={(e) => setHold(e.target.value === "on")} className={input}><option value="on">Place hold</option><option value="off">Release hold</option></select>
        )}
        <button disabled={busy || !ready} onClick={run} className={btn}>{busy ? "Applying…" : `Apply to ${keys.length} object${keys.length === 1 ? "" : "s"}`}</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {bucket && !objects && !error && <p className="text-[var(--inaya-text-muted)] text-xs">Loading objects…</p>}
      {objects && objects.length === 0 && <p className="text-[var(--inaya-text-muted)] text-xs">No objects in this bucket.</p>}
      {objects && objects.length > 0 && (
        <div className="max-h-52 overflow-y-auto bg-black/20 border border-white/5 rounded-lg p-2 space-y-1">
          <label className="flex items-center gap-2 text-[11px] text-[var(--inaya-text-muted)]">
            <input type="checkbox" checked={keys.length === objects.length} onChange={(e) => setSelected(Object.fromEntries(objects.map((o) => [o.filename, e.target.checked])))} /> Select all
          </label>
          {objects.map((o) => (
            <label key={o.filename} className="flex items-center gap-2 text-[11px] font-mono text-[var(--inaya-text-primary)]">
              <input type="checkbox" checked={!!selected[o.filename]} onChange={(e) => setSelected((s) => ({ ...s, [o.filename]: e.target.checked }))} />
              <span className="truncate">{o.filename}</span>
              <span className="text-[var(--inaya-text-muted)] ml-auto">{formatBytes(o.sizeBytes)}</span>
            </label>
          ))}
        </div>
      )}
      {result && (
        <div className="bg-black/20 border border-white/5 rounded-lg p-3 text-[11px]">
          <p className="text-[var(--inaya-text-primary)] font-bold">{result.succeeded} succeeded, <span className={result.failed ? "text-red-400" : ""}>{result.failed} failed</span> of {result.totalKeys}</p>
          {result.results.filter((r) => r.status === "FAILED").map((r) => (
            <p key={r.key} className="text-red-400 font-mono">{r.key}: {r.error || r.reason || "failed"}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function InventoryPanel({ orgId, buckets }) {
  const [bucket, setBucket] = useState("");
  const [inv, setInv] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError(""); setInv(null);
    try { setInv(await manage(orgId, `action=inventory${bucket ? `&bucket=${encodeURIComponent(bucket)}` : ""}`)); } catch (err) { setError(err.message); }
  }, [orgId, bucket]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center">
        <BucketPicker buckets={buckets} value={bucket} onChange={setBucket} allowAll />
        <a className={btn} href={`/api/orgs/s3-compat/manage?orgId=${orgId}&action=inventory&format=csv${bucket ? `&bucket=${encodeURIComponent(bucket)}` : ""}`}>Download CSV</a>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {!inv && !error && <p className="text-[var(--inaya-text-muted)] text-xs">Building inventory…</p>}
      {inv && (
        <>
          <p className="text-[11px] text-[var(--inaya-text-muted)]">{inv.objectCount} objects, {formatBytes(inv.totalSizeBytes)} in {inv.bucketScope}. Generated {new Date(inv.generatedAt).toLocaleString()}.</p>
          {inv.objects.length === 0 ? <EmptyState compact icon="📋" description="No objects to list." /> : (
            <div className="max-h-64 overflow-auto bg-black/20 border border-white/5 rounded-lg">
              <table className="w-full text-[10px] font-mono">
                <thead><tr className="text-left text-[var(--inaya-text-muted)]"><th className="p-1.5">Bucket</th><th>Key</th><th>Size</th><th>Tags</th><th>Protection</th></tr></thead>
                <tbody>
                  {inv.objects.slice(0, 500).map((o) => (
                    <tr key={`${o.bucket}/${o.key}/${o.versionId}`} className="border-t border-white/5 text-[var(--inaya-text-primary)]">
                      <td className="p-1.5">{o.bucket}</td><td className="truncate max-w-[220px]">{o.key}</td><td>{formatBytes(o.sizeBytes)}</td>
                      <td>{Object.entries(o.tags).map(([k, v]) => `${k}=${v}`).join(", ") || "-"}</td>
                      <td>{[o.retentionMode && `locked ${o.retentionMode}`, o.legalHold && "legal hold"].filter(Boolean).join(", ") || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {inv.objects.length > 500 && <p className="p-2 text-[10px] text-[var(--inaya-text-muted)]">Showing the first 500. Download the CSV for everything.</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AnalyticsPanel({ orgId, buckets }) {
  const [bucket, setBucket] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null); setError("");
    manage(orgId, `action=analytics${bucket ? `&bucket=${encodeURIComponent(bucket)}` : ""}`).then(setData).catch((e) => setError(e.message));
  }, [orgId, bucket]);

  return (
    <div className="space-y-3">
      <BucketPicker buckets={buckets} value={bucket} onChange={setBucket} allowAll />
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {!data && !error && <p className="text-[var(--inaya-text-muted)] text-xs">Computing…</p>}
      {data && (
        <>
          <p className="text-[11px] text-[var(--inaya-text-primary)] font-bold">{data.totals.objectCount} objects, {formatBytes(data.totals.totalSizeBytes)} in total</p>
          <div className="grid gap-2 md:grid-cols-2">
            {data.buckets.map((b) => (
              <div key={b.bucket} className="bg-black/20 border border-white/5 rounded-lg p-3 text-[11px] text-[var(--inaya-text-muted)] space-y-1">
                <p className="text-[var(--inaya-text-primary)] font-bold text-xs">{b.bucket}</p>
                <p>{b.objectCount} objects · {formatBytes(b.totalSizeBytes)} · average {formatBytes(b.averageSizeBytes)}</p>
                <p>{b.totalVersionCount} versions · {b.lockedObjectCount} locked · {b.legalHoldCount} on legal hold</p>
                {b.largestObjects.length > 0 && <p className="font-mono">Largest: {b.largestObjects.map((o) => `${o.key} (${formatBytes(o.sizeBytes)})`).join(", ")}</p>}
                {Object.keys(b.tagDistribution).length > 0 && <p>Tags in use: {Object.entries(b.tagDistribution).map(([k, n]) => `${k} (${n})`).join(", ")}</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PolicyPanel({ orgId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { manage(orgId, "action=policy-analysis").then(setData).catch((e) => setError(e.message)); }, [orgId]);

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-[var(--inaya-text-muted)]">Reviews every active credential for over-broad access: no scope, no expiry, write and delete rights, no bucket limit.</p>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {!data && !error && <p className="text-[var(--inaya-text-muted)] text-xs">Analyzing…</p>}
      {data && (
        <>
          <p className="text-[11px] text-[var(--inaya-text-primary)] font-bold">{data.activeCredentialCount} active credentials, {data.findingCount} finding{data.findingCount === 1 ? "" : "s"}</p>
          {data.credentials.filter((c) => c.active).map((c) => (
            <div key={c.accessKeyId} className="bg-black/20 border border-white/5 rounded-lg p-3 text-[11px]">
              <p className="text-[var(--inaya-text-primary)] font-mono">{c.accessKeyId} {c.label && <span className="text-[var(--inaya-text-muted)]">· {c.label}</span>}</p>
              {c.findings.length === 0 ? <p className="text-emerald-400">No findings.</p> : c.findings.map((f) => (
                <p key={f.type} className={SEVERITY[f.severity] || ""}>{f.severity}: {f.detail}</p>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function SasPanel({ orgId, buckets }) {
  const [creds, setCreds] = useState(null);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [container, setContainer] = useState("");
  const [blob, setBlob] = useState("");
  const [perms, setPerms] = useState({ r: true });
  const [minutes, setMinutes] = useState(60);
  const [out, setOut] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api(`/api/orgs/s3-compat/credentials?orgId=${orgId}`).then((d) => {
      const active = (d.credentials || []).filter((c) => c.active);
      setCreds(active);
      if (active[0]) setAccessKeyId(active[0].accessKeyId);
    }).catch((e) => setError(e.message));
  }, [orgId]);

  const letters = Object.keys(perms).filter((p) => perms[p]).join("");

  async function make() {
    setError(""); setOut(null); setCopied(false);
    try { setOut(await api("/api/orgs/s3-compat/sas", { method: "POST", body: JSON.stringify({ orgId, accessKeyId, container, blob: blob || undefined, permissions: letters, expiresInMinutes: Number(minutes) }) })); }
    catch (err) { setError(err.message); }
  }

  const options = blob ? ["r", "a", "c", "w", "d"] : ["r", "a", "c", "w", "d", "l"];
  const names = { r: "Read", a: "Add", c: "Create", w: "Write", d: "Delete", l: "List" };

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-[var(--inaya-text-muted)]">Creates an Azure SAS link for AzCopy or an Azure SDK. It only works as far as the credential that signs it: revoking or scoping that credential limits every link it signed.</p>
      <div className="flex gap-2 flex-wrap items-center">
        <select value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} className={input}>
          {(creds || []).map((c) => <option key={c.accessKeyId} value={c.accessKeyId}>{c.label || c.accessKeyId}</option>)}
        </select>
        <BucketPicker buckets={buckets} value={container} onChange={setContainer} />
        <input value={blob} onChange={(e) => setBlob(e.target.value)} placeholder="blob path (blank = whole container)" className={`${input} w-56`} />
        <input type="number" min="1" max="10080" value={minutes} onChange={(e) => setMinutes(e.target.value)} className={`${input} w-20`} /><span className="text-[11px] text-[var(--inaya-text-muted)]">minutes</span>
      </div>
      <div className="flex gap-3 flex-wrap text-[11px] text-[var(--inaya-text-muted)]">
        {options.map((p) => (
          <label key={p} className="flex items-center gap-1"><input type="checkbox" checked={!!perms[p]} onChange={(e) => setPerms((s) => ({ ...s, [p]: e.target.checked }))} /> {names[p]}</label>
        ))}
      </div>
      <button disabled={!accessKeyId || !container || !letters} onClick={make} className={btn}>Create SAS link</button>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {creds && creds.length === 0 && <p className="text-[var(--inaya-text-muted)] text-xs">Create a credential above first.</p>}
      {out && (
        <div className="bg-black/20 border border-white/5 rounded-lg p-3 space-y-2">
          <p className="text-[10px] text-[var(--inaya-text-muted)]">Expires {new Date(out.expiresAt).toLocaleString()}. Keep the whole link, including <span className="font-mono">inaya-account</span>.</p>
          <textarea readOnly value={out.url} rows={3} className={`${input} w-full font-mono`} />
          <button className={btn} onClick={async () => { try { await navigator.clipboard.writeText(out.url); setCopied(true); } catch { /* clipboard blocked: the text is selectable above */ } }}>{copied ? "Copied" : "Copy link"}</button>
        </div>
      )}
    </div>
  );
}

const EVENT_GROUPS = [
  ["s3:ObjectCreated:*", "Uploads"],
  ["s3:ObjectRemoved:*", "Deletes"],
  ["s3:LifecycleExpiration:*", "Lifecycle expiry"],
];
const DELIVERY_STYLE = { DELIVERED: "text-emerald-400", PENDING: "text-amber-400", SENDING: "text-amber-400", DEAD: "text-red-400", FAILED: "text-red-400" };

function NotificationsPanel({ orgId, buckets }) {
  const [configs, setConfigs] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [form, setForm] = useState({ bucket: "", url: "", prefix: "", suffix: "", events: { "s3:ObjectCreated:*": true, "s3:ObjectRemoved:*": true } });
  const [secret, setSecret] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = "/api/orgs/s3-compat/notifications";

  const load = useCallback(async () => {
    try {
      const [c, d] = await Promise.all([api(`${base}?orgId=${orgId}`), api(`${base}?orgId=${orgId}&view=deliveries`)]);
      setConfigs(c.notifications); setDeliveries(d.deliveries);
    } catch (err) { setError(err.message); }
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  async function run(fn, okMessage) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await fn();
      if (okMessage) setNotice(typeof okMessage === "function" ? okMessage(result) : okMessage);
      await load();
      return result;
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const create = (e) => {
    e.preventDefault();
    run(async () => {
      const events = Object.keys(form.events).filter((k) => form.events[k]);
      const r = await api(base, { method: "POST", body: JSON.stringify({ orgId, action: "create", bucket: form.bucket, url: form.url, events, prefix: form.prefix, suffix: form.suffix }) });
      setSecret(r.secret);
      setForm((f) => ({ ...f, url: "", prefix: "", suffix: "" }));
      return r;
    }, "Notification created.");
  };

  const act = (body, okMessage) => run(() => api(base, { method: "POST", body: JSON.stringify({ orgId, ...body }) }), okMessage);

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-[var(--inaya-text-muted)]">Sends a signed webhook to your endpoint whenever an object is uploaded, deleted or expires. The payload follows AWS's S3 event format. Failed deliveries retry with backoff, then wait here for you to redeliver.</p>
      <form onSubmit={create} className="flex gap-2 flex-wrap items-center">
        <BucketPicker buckets={buckets} value={form.bucket} onChange={(bucket) => setForm((f) => ({ ...f, bucket }))} />
        <input required value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://example.com/s3-events" className={`${input} w-64`} />
        <input value={form.prefix} onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value }))} placeholder="key prefix" className={`${input} w-24`} />
        <input value={form.suffix} onChange={(e) => setForm((f) => ({ ...f, suffix: e.target.value }))} placeholder="key suffix" className={`${input} w-24`} />
        {EVENT_GROUPS.map(([ev, label]) => (
          <label key={ev} className="flex items-center gap-1 text-[11px] text-[var(--inaya-text-muted)]">
            <input type="checkbox" checked={!!form.events[ev]} onChange={(e) => setForm((f) => ({ ...f, events: { ...f.events, [ev]: e.target.checked } }))} /> {label}
          </label>
        ))}
        <button disabled={busy || !form.bucket || !form.url || !Object.values(form.events).some(Boolean)} className={btn}>Add notification</button>
      </form>
      {secret && (
        <div className="bg-amber-400/10 border border-amber-400/30 rounded-lg p-3 text-[11px]">
          <p className="text-amber-400 font-bold">Signing secret, shown once. Copy it now.</p>
          <p className="font-mono text-[var(--inaya-text-primary)] break-all">{secret}</p>
          <p className="text-[var(--inaya-text-muted)] mt-1">Verify each request: HMAC-SHA256 of <span className="font-mono">timestamp.body</span> with this secret equals the <span className="font-mono">x-inaya-signature</span> header (<span className="font-mono">v1=...</span>).</p>
          <button className={`${btn} mt-2`} onClick={() => setSecret(null)}>I have saved it</button>
        </div>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {notice && <p className="text-emerald-400 text-xs">{notice}</p>}
      {!configs && !error && <p className="text-[var(--inaya-text-muted)] text-xs">Loading…</p>}
      {configs && configs.length === 0 && <EmptyState compact icon="🔔" description="No notifications yet." />}
      {configs && configs.map((c) => (
        <div key={c.configId} className="bg-black/20 border border-white/5 rounded-lg p-3 text-[11px] space-y-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[var(--inaya-text-primary)] font-mono break-all">{c.bucket} → {c.url}</p>
            <div className="flex gap-1.5">
              <button disabled={busy} className={btn} onClick={() => act({ action: "test", configId: c.configId }, (r) => (r.ok ? `Test event delivered (HTTP ${r.status}).` : `Test failed: ${r.error}`))}>Send test</button>
              <button disabled={busy} className={btn} onClick={() => run(() => api(base, { method: "PATCH", body: JSON.stringify({ orgId, configId: c.configId, active: !c.active }) }))}>{c.active ? "Disable" : "Enable"}</button>
              <button disabled={busy} className={btn} onClick={() => run(() => api(`${base}?orgId=${orgId}&configId=${c.configId}`, { method: "DELETE" }), "Notification deleted.")}>Delete</button>
            </div>
          </div>
          <p className="text-[var(--inaya-text-muted)]">
            {c.events.join(", ")}{c.prefix && ` · prefix ${c.prefix}`}{c.suffix && ` · suffix ${c.suffix}`} · {c.active ? "active" : <span className="text-amber-400">disabled</span>}
            {c.consecutiveFailures > 0 && <span className="text-red-400"> · {c.consecutiveFailures} consecutive failures</span>}
          </p>
        </div>
      ))}
      {deliveries.length > 0 && (
        <div className="max-h-56 overflow-auto bg-black/20 border border-white/5 rounded-lg">
          <table className="w-full text-[10px] font-mono">
            <thead><tr className="text-left text-[var(--inaya-text-muted)]"><th className="p-1.5">When</th><th>Event</th><th>Key</th><th>Status</th><th>Tries</th><th /></tr></thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.deliveryId} className="border-t border-white/5 text-[var(--inaya-text-primary)]">
                  <td className="p-1.5">{new Date(d.createdAt).toLocaleTimeString()}</td>
                  <td>{d.event.replace("s3:", "")}</td>
                  <td className="truncate max-w-[160px]">{d.key}</td>
                  <td className={DELIVERY_STYLE[d.status] || ""} title={d.lastError || ""}>{d.status}</td>
                  <td>{d.attempts}</td>
                  <td>{(d.status === "DEAD" || d.status === "FAILED") && <button disabled={busy} className={btn} onClick={() => act({ action: "redeliver", deliveryId: d.deliveryId }, "Queued for redelivery.")}>Redeliver</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const TABS = [
  ["batch", "Tags & batch"],
  ["inventory", "Inventory"],
  ["analytics", "Analytics"],
  ["policy", "Credential review"],
  ["sas", "Azure SAS links"],
  ["notifications", "Event notifications"],
];

export default function S3ManagementPanels({ orgId }) {
  const [tab, setTab] = useState("batch");
  const [buckets, setBuckets] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { manage(orgId, "action=buckets").then((d) => setBuckets(d.buckets)).catch((e) => setError(e.message)); }, [orgId]);

  return (
    <div className="bg-[var(--inaya-surface)] border border-white/10 rounded-xl p-4 space-y-3">
      <h4 className="text-[var(--inaya-text-primary)] font-bold text-xs uppercase">Storage Management Tools</h4>
      <div className="flex gap-1.5 flex-wrap">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`${btn} ${tab === id ? "!bg-[#00f2fe]/15 !text-[#00f2fe]" : ""}`}>{label}</button>
        ))}
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {!buckets && !error && <p className="text-[var(--inaya-text-muted)] text-xs">Loading…</p>}
      {buckets && tab === "batch" && <TagsAndBatchPanel orgId={orgId} buckets={buckets} />}
      {buckets && tab === "inventory" && <InventoryPanel orgId={orgId} buckets={buckets} />}
      {buckets && tab === "analytics" && <AnalyticsPanel orgId={orgId} buckets={buckets} />}
      {buckets && tab === "policy" && <PolicyPanel orgId={orgId} />}
      {buckets && tab === "sas" && <SasPanel orgId={orgId} buckets={buckets} />}
      {buckets && tab === "notifications" && <NotificationsPanel orgId={orgId} buckets={buckets} />}
    </div>
  );
}
