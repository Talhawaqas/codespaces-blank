"use client";

// src/components/business/gateway/GatewayView.js -- Sovereign Gateway (Competitive Expansion SOW M, N). Administrators: deployment mode, enrol and revoke gateways, approve
// connectors and folders, see health, approve file transfers, map directory accounts to people, read permission diagnostics and the forwarded audit trail.
// Everyone: the network folders their own permissions on the customer's system allow them to read. Nothing here shows file content: Inaya holds none.
import { useCallback, useEffect, useState } from "react";
import EmptyState from "../../EmptyState";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[10px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2 py-1 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const accent = "text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40";
const field = "w-full bg-black/45 border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1 text-[11px] text-[var(--inaya-text-primary)]";
const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }); } catch { return "-"; } };
const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const j = async (path, opts = {}) => { const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts }); const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || "Request failed."), { status: r.status, code: d.code }); return d; };
const PILL = { ONLINE: "text-emerald-400", OFFLINE: "text-amber-300", NEVER_CONNECTED: "text-[var(--inaya-text-muted)]", REVOKED: "text-red-400", READY: "text-emerald-400", PARTIAL: "text-amber-300", NOT_READY: "text-amber-300", NOT_CONFIGURED: "text-[var(--inaya-text-muted)]", RECORDED_ONLY: "text-[var(--inaya-text-muted)]", OK: "text-emerald-400", ATTENTION: "text-amber-300", NO_DATA: "text-[var(--inaya-text-muted)]" };
const Pill = ({ s }) => <span className={`text-[10px] font-bold uppercase ${PILL[s] || muted}`}>{String(s).replace(/_/g, " ")}</span>;

export default function GatewayView({ orgId, canManage, canChangeMode }) {
  const [tab, setTab] = useState(canManage ? "gateways" : "folders"); const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const act = async (fn, ok) => { setErr(""); setMsg(""); try { const r = await fn(); if (ok) setMsg(typeof ok === "function" ? ok(r) : ok); return r; } catch (e) { setErr(e.message); } };
  const tabs = [["folders", "Network folders"], ...(canManage ? [["gateways", "Gateways"], ["permissions", "Permissions and mapping"], ["transfers", "Transfers"], ["audit", "Audit"], ["mode", "Deployment mode"]] : [])];
  return (
    <div className="space-y-3 text-[12px]">
      <div className="flex flex-wrap gap-1">{tabs.map(([k, l]) => <button key={k} className={tab === k ? accent : btn} onClick={() => { setTab(k); setErr(""); setMsg(""); }}>{l}</button>)}</div>
      {err && <p className="text-red-400" role="alert">{err}</p>}{msg && <p className="text-emerald-400" role="status">{msg}</p>}
      {tab === "folders" && <Folders orgId={orgId} act={act} />}
      {canManage && tab === "gateways" && <Gateways orgId={orgId} act={act} />}
      {canManage && tab === "permissions" && <Permissions orgId={orgId} act={act} />}
      {canManage && tab === "transfers" && <Transfers orgId={orgId} act={act} />}
      {canManage && tab === "audit" && <Audit orgId={orgId} act={act} />}
      {canManage && tab === "mode" && <Mode orgId={orgId} act={act} canChange={canChangeMode} />}
    </div>
  );
}

function Mode({ orgId, act, canChange }) {
  const [d, setD] = useState(null); const load = useCallback(() => j(`/api/orgs/gateway/mode?orgId=${orgId}`).then(setD).catch((e) => act(() => { throw e; })), [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]); if (!d) return <p className={muted}>Loading…</p>;
  const set = (mode) => act(async () => { const r = await j("/api/orgs/gateway/mode", { method: "POST", body: JSON.stringify({ orgId, mode, acknowledgeNoClaim: mode === "air_gapped" ? window.confirm("Air-gapped is recorded as a requirement only. Nothing is built or tested for disconnected operation. Record it anyway?") : undefined }) }); setD(r); return r; }, "Deployment mode recorded.");
  return (<div className="space-y-2">{d.modes.map((m) => (
    <div key={m.key} className={`${card} p-3 ${d.mode === m.key ? "border-[#00f2fe]/50" : ""}`}>
      <div className="flex flex-wrap items-center gap-2"><b>Mode {m.n}: {m.label}</b>{d.mode === m.key && <span className="text-[10px] font-bold uppercase text-[#00f2fe]">Current</span>}<Pill s={m.readiness.state} /></div>
      <p className={muted}>{m.text}</p><p>{m.readiness.note}</p>
      {canChange && d.mode !== m.key && <button className={`${btn} mt-2`} onClick={() => set(m.key)}>Use this mode</button>}
    </div>))}</div>);
}

function Folders({ orgId, act }) {
  const [list, setList] = useState(null); const [sel, setSel] = useState(null); const [files, setFiles] = useState(null);
  useEffect(() => { j(`/api/orgs/gateway/folders?orgId=${orgId}`).then((d) => setList(d.folders)).catch((e) => { setList([]); act(() => { throw e; }); }); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = (f) => { setSel(f); setFiles(null); act(async () => { const r = await j(`/api/orgs/gateway/folders/${f.folderId}/browse?orgId=${orgId}`); setFiles(r); return r; }); };
  if (!list) return <p className={muted}>Loading…</p>;
  return (<div className="space-y-2">
    <p className={muted}>Folders on your organization's own servers that your account may read. What you can do here follows the permissions the customer's system gives you; Inaya adds no access and removes none. A folder you cannot read does not appear.</p>
    {list.length === 0 ? <EmptyState compact icon="🗂️" description="No network folders are available to you." /> : list.map((f) => <div key={f.folderId} className={`${card} p-3 flex flex-wrap items-center gap-2`}><b>{f.label}</b><span className={muted}>{f.connector} · {f.gateway}</span><Pill s={f.gatewayStatus} /><button className={btn} onClick={() => open(f)}>Open</button></div>)}
    {sel && files && <div className={`${card} p-3`}><p className="font-bold mb-1">{sel.label}</p><p className={`${muted} mb-2`}>{files.traceability}</p>
      {files.items.length === 0 ? <p className={muted}>No files listed yet.</p> : files.items.map((i) => <div key={i.path} className="flex gap-3 border-t border-[var(--inaya-overlay-10)] py-1"><span className="break-all flex-1">{i.isDir ? "📁 " : ""}{i.path}</span><span className={muted}>{i.isDir ? "" : bytes(i.size)}</span>{i.classification && <span className="text-amber-300">{i.classification}</span>}</div>)}</div>}
  </div>);
}

function Gateways({ orgId, act }) {
  const [gs, setGs] = useState(null); const [token, setToken] = useState(null); const [label, setLabel] = useState(""); const [open, setOpen] = useState(null); const [detail, setDetail] = useState(null);
  const load = useCallback(() => j(`/api/orgs/gateway/gateways?orgId=${orgId}`).then((d) => setGs(d.gateways)).catch((e) => { setGs([]); act(() => { throw e; }); }), [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadDetail = useCallback((id) => j(`/api/orgs/gateway/gateways/${id}?orgId=${orgId}`).then(setDetail), [orgId]);
  useEffect(() => { load(); }, [load]); useEffect(() => { if (open) loadDetail(open).catch(() => {}); }, [open, loadDetail]);
  if (!gs) return <p className={muted}>Loading…</p>;
  return (<div className="space-y-2">
    <p className={muted}>A gateway is a small program inside your network that connects out to Inaya. No inbound port is needed. Its private key stays on your machine.</p>
    <div className={`${card} p-3 flex flex-wrap gap-2 items-center`}><input aria-label="Gateway name" className={`${field} !w-56`} placeholder="Name, for example Head office" value={label} onChange={(e) => setLabel(e.target.value)} /><button className={accent} onClick={() => act(async () => { const r = await j("/api/orgs/gateway/enrollments", { method: "POST", body: JSON.stringify({ orgId, label }) }); setToken(r); setLabel(""); return r; })}>Create enrollment token</button></div>
    {token && <div className={`${card} p-3 border-emerald-400/40`}><p className="text-emerald-400 font-bold">Enrollment token (shown once, works once, expires in 24 hours)</p><code className="break-all">{token.token}</code><p className={`${muted} mt-1`}>On the gateway machine: <code>inaya-gateway enroll --url {typeof window !== "undefined" ? window.location.origin : ""} --token {token.token}</code></p><button className={`${btn} mt-1`} onClick={() => setToken(null)}>I saved it</button></div>}
    {gs.length === 0 ? <EmptyState compact icon="🛰️" description="No gateways yet." /> : gs.map((g) => (
      <div key={g.gatewayId} className={`${card} p-3`}>
        <div className="flex flex-wrap items-center gap-2"><b>{g.label}</b><Pill s={g.status} /><span className={muted}>v{g.version || "?"} · {g.platform || "?"} · last seen {g.lastSeenAt ? when(g.lastSeenAt) : "never"}</span></div>
        {g.health && <p className={muted}>queue {g.health.queueDepth} · lag {g.health.lagSeconds}s · permission read failures {g.health.aclFailures}{g.health.connectors?.some((c) => c.status !== "ok") ? " · a connector needs attention" : ""}</p>}
        <p className={muted}>key fingerprint {g.fingerprint}{g.pendingCommands ? ` · ${g.pendingCommands} command(s) waiting` : ""}</p>
        {g.status !== "REVOKED" && <div className="flex flex-wrap gap-1 mt-2"><button className={btn} onClick={() => setOpen(open === g.gatewayId ? null : g.gatewayId)}>{open === g.gatewayId ? "Close" : "Connectors and files"}</button>
          <button className={btn} onClick={() => act(() => j(`/api/orgs/gateway/gateways/${g.gatewayId}/commands`, { method: "POST", body: JSON.stringify({ orgId, type: "rescan" }) }).then(load), "Rescan queued; the gateway picks it up on its next check-in.")}>Rescan</button>
          <button className={btn} onClick={() => act(() => j(`/api/orgs/gateway/gateways/${g.gatewayId}/commands`, { method: "POST", body: JSON.stringify({ orgId, type: "acl_refresh" }) }).then(load), "Permission refresh queued.")}>Refresh permissions</button>
          <button className={`${btn} !text-red-400`} onClick={() => window.confirm("Revoke this gateway? It stops working at its next request and its queued transfers are cancelled.") && act(() => j(`/api/orgs/gateway/gateways/${g.gatewayId}/revoke`, { method: "POST", body: JSON.stringify({ orgId }) }).then(load), "Revoked.")}>Revoke</button></div>}
        {open === g.gatewayId && detail && <Connectors orgId={orgId} g={detail} act={act} reload={() => loadDetail(g.gatewayId)} />}
      </div>))}
  </div>);
}

function Connectors({ orgId, g, act, reload }) {
  const [f, setF] = useState({ name: "", type: "filesystem", rootPath: "", folders: "" }); const [inv, setInv] = useState(null);
  const parse = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [p, ...r] = l.split("|"); return { path: p.trim(), label: r.join("|").trim() || p.trim() }; });
  const base = `/api/orgs/gateway/gateways/${g.gatewayId}/connectors`;
  const list = (k, fo) => act(async () => { const r = await j(`/api/orgs/gateway/gateways/${g.gatewayId}/inventory?orgId=${orgId}&connectorId=${k.connectorId}&folderId=${fo.folderId}`); setInv({ k, fo, items: r.items }); return r; });
  const approve = (k, fo, it) => act(() => j("/api/orgs/gateway/transfers", { method: "POST", body: JSON.stringify({ orgId, gatewayId: g.gatewayId, connectorId: k.connectorId, folderId: fo.folderId, path: it.path }) }), "Approved. The gateway sends it encrypted at its next check-in.");
  return (<div className="mt-3 space-y-2">
    {g.connectors.map((k) => <div key={k.connectorId} className="border-t border-[var(--inaya-overlay-10)] pt-2"><div className="flex flex-wrap items-center gap-2"><b>{k.name}</b><span className={muted}>{k.type} · {k.rootPath}</span>{k.enabled === false && <span className="text-amber-300">disabled</span>}<button className={`${btn} !text-red-400`} onClick={() => window.confirm("Remove this connector and its file listing?") && act(() => j(`${base}/${k.connectorId}?orgId=${orgId}`, { method: "DELETE" }).then(reload), "Removed.")}>Remove</button></div>
      {k.folders.map((fo) => <div key={fo.folderId} className="ml-3 flex flex-wrap items-center gap-2"><span>{fo.label} <span className={muted}>({fo.path})</span></span><button className={btn} onClick={() => list(k, fo)}>List files</button></div>)}</div>)}
    {inv && <div className={`${card} p-2`}><p className="font-bold">{inv.fo.label}: files the gateway has listed (administrator view, recorded in the audit trail)</p>{inv.items.length === 0 ? <p className={muted}>Nothing listed yet.</p> : inv.items.map((it) => <div key={it.path} className="flex gap-3 border-t border-[var(--inaya-overlay-10)] py-1"><span className="flex-1 break-all">{it.isDir ? "📁 " : ""}{it.path}</span><span className={muted}>{it.isDir ? "" : bytes(it.size)}</span>{!it.isDir && <button className={btn} onClick={() => approve(inv.k, inv.fo, it)}>Approve transfer</button>}</div>)}</div>}
    <div className="border-t border-[var(--inaya-overlay-10)] pt-2 space-y-1"><p className="font-bold">Add a connector</p>
      <div className="flex flex-wrap gap-2"><input aria-label="Connector name" className={`${field} !w-44`} placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <select aria-label="Connector type" className={`${field} !w-auto`} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="filesystem">Local folder</option><option value="smb">SMB share (UNC path or mount)</option><option value="nfs">NFS mount</option></select>
        <input aria-label="Root path" className={`${field} !w-72`} placeholder="Root path as the gateway sees it, e.g. D:\Shares" value={f.rootPath} onChange={(e) => setF({ ...f, rootPath: e.target.value })} /></div>
      <textarea aria-label="Approved folders" className={`${field} h-16`} placeholder={"Approved folders, one per line: relative path | label\nfinance | Finance"} value={f.folders} onChange={(e) => setF({ ...f, folders: e.target.value })} />
      <button className={accent} disabled={!f.name || !f.rootPath} onClick={() => act(async () => { const r = await j(base, { method: "POST", body: JSON.stringify({ orgId, name: f.name, type: f.type, rootPath: f.rootPath, folders: parse(f.folders) }) }); setF({ name: "", type: "filesystem", rootPath: "", folders: "" }); reload(); return r; }, "Connector saved. The gateway learns it at its next check-in.")}>Save connector</button></div>
  </div>);
}

function Permissions({ orgId, act }) {
  const [h, setH] = useState(null); const [maps, setMaps] = useState([]); const [changes, setChanges] = useState([]); const [folders, setFolders] = useState([]); const [perm, setPerm] = useState(null); const [mapForm, setMapForm] = useState({ principal: "", email: "" }); const [who, setWho] = useState("");
  const load = useCallback(async () => { try { setH(await j(`/api/orgs/gateway/mapping-health?orgId=${orgId}`)); setMaps((await j(`/api/orgs/gateway/mappings?orgId=${orgId}`)).mappings); setChanges((await j(`/api/orgs/gateway/permission-changes?orgId=${orgId}`)).changes); const gs = (await j(`/api/orgs/gateway/gateways?orgId=${orgId}`)).gateways.filter((g) => g.status !== "REVOKED"); const all = []; for (const g of gs) { const d = await j(`/api/orgs/gateway/gateways/${g.gatewayId}?orgId=${orgId}`); for (const k of d.connectors) for (const f of k.folders) all.push({ folderId: f.folderId, label: `${g.label} / ${k.name} / ${f.label}` }); } setFolders(all); } catch (e) { act(() => { throw e; }); } }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const mapTo = (principal, email) => act(() => j("/api/orgs/gateway/mappings", { method: "POST", body: JSON.stringify({ orgId, principal, email }) }).then(load), email ? "Mapped." : "Mapping removed.");
  const show = (id) => act(async () => { const r = await j(`/api/orgs/gateway/folders/${id}/permissions?orgId=${orgId}${who ? `&email=${encodeURIComponent(who)}` : ""}`); setPerm({ id, ...r }); return r; });
  if (!h) return <p className={muted}>Loading…</p>;
  return (<div className="space-y-2">
    <div className={`${card} p-3`}><div className="flex items-center gap-2"><b>Mapping health</b><Pill s={h.state} /></div>
      <p className={muted}>{h.folders} folder(s) read · {h.mapped} of {h.principals} directory accounts mapped{h.groups ? ` · ${h.groups} group(s) apply through their members` : ""} · {h.staleSnapshots} stale snapshot(s) · {h.permissionSyncFailures} read failure(s) · {h.permissionChanges7d} permission change(s) in 7 days</p>
      {h.unmapped.length > 0 && <p className="text-amber-300">Not mapped: {h.unmapped.join(", ")}. They give no one access through Inaya until mapped.</p>}
      {h.mappedToNonMembers.length > 0 && <p className="text-amber-300">Mapped to someone who is no longer a member: {h.mappedToNonMembers.join(", ")}</p>}
      {h.conflicts.length > 0 && <p className="text-amber-300">Allow and deny conflicts on: {h.conflicts.map((c) => c.principal).join(", ")} (the deny wins).</p>}
      {h.suggestions.map((s) => <p key={s.principal}>Suggestion: {s.principal} may be {s.email} ({s.basis}). <button className={btn} onClick={() => mapTo(s.principal, s.email)}>Confirm</button></p>)}</div>
    <div className={`${card} p-3 space-y-1`}><b>Identity mapping</b><div className="flex flex-wrap gap-2"><input aria-label="Directory account" className={`${field} !w-64`} placeholder="CONTOSO\alice" value={mapForm.principal} onChange={(e) => setMapForm({ ...mapForm, principal: e.target.value })} /><input aria-label="Member email" className={`${field} !w-64`} placeholder="alice@example.com" value={mapForm.email} onChange={(e) => setMapForm({ ...mapForm, email: e.target.value })} /><button className={accent} disabled={!mapForm.principal || !mapForm.email} onClick={() => mapTo(mapForm.principal, mapForm.email)}>Map</button></div>
      {maps.map((m) => <div key={m.principal} className="flex gap-3 border-t border-[var(--inaya-overlay-10)] py-1"><span className="flex-1 break-all">{m.principal} → {m.email}</span><span className={muted}>{m.source}</span><button className={`${btn} !text-red-400`} onClick={() => mapTo(m.principal, null)}>Remove</button></div>)}</div>
    <div className={`${card} p-3 space-y-1`}><b>Folder permissions</b><div className="flex flex-wrap gap-2"><input aria-label="Check one person" className={`${field} !w-64`} placeholder="Optional: check what this person can do" value={who} onChange={(e) => setWho(e.target.value)} />{folders.map((f) => <button key={f.folderId} className={btn} onClick={() => show(f.folderId)}>{f.label}</button>)}</div>
      {perm && <div><p className={muted}>Snapshot {perm.snapshotAt ? when(perm.snapshotAt) : "none"} · source {perm.source || "-"}</p>
        {perm.effective && <p className="font-bold">{who}: read {perm.effective.read ? "yes" : "no"}, write {perm.effective.write ? "yes" : "no"}, delete {perm.effective.delete ? "yes" : "no"} ({perm.effective.why})</p>}
        {perm.entries.map((e, i) => <div key={i} className="flex gap-3 border-t border-[var(--inaya-overlay-10)] py-1"><span className={e.type === "deny" ? "text-red-400 font-bold" : ""}>{e.type}</span><span className="flex-1 break-all">{e.principal}{e.inherited ? " (inherited)" : ""}</span><span className={muted}>{e.rights.join(", ")}</span><span className={muted}>{e.wellKnown ? "built-in" : e.mappedTo || "unmapped"}</span></div>)}
        {perm.diagnostics.map((d, i) => <p key={i} className={d.level === "warning" ? "text-amber-300" : muted}>{d.detail}</p>)}</div>}</div>
    <div className={`${card} p-3`}><b>Recent permission changes</b>{changes.length === 0 ? <p className={muted}>None seen.</p> : changes.map((c, i) => <p key={i} className={muted}>{when(c.at)} · {c.added} added, {c.removed} removed</p>)}</div>
  </div>);
}

function Transfers({ orgId, act }) {
  const [rows, setRows] = useState(null); const load = useCallback(() => j(`/api/orgs/gateway/transfers?orgId=${orgId}`).then((d) => setRows(d.transfers)).catch((e) => { setRows([]); act(() => { throw e; }); }), [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]); if (!rows) return <p className={muted}>Loading…</p>;
  return (<div className="space-y-2"><p className={muted}>Approved files are encrypted on the gateway with a key that stays with you, then sent in parts. A dropped connection resumes where it stopped. Inaya holds ciphertext only. Restore from the gateway with <code>inaya-gateway restore</code>.</p>
    {rows.length === 0 ? <EmptyState compact icon="📦" description="No transfers yet. Approve a file from a gateway's file list." /> : rows.map((t) => <div key={t.transferId} className={`${card} p-3 flex flex-wrap items-center gap-2`}><b className="break-all">{t.path}</b><span className={muted}>{bytes(t.size)}</span><span className={`text-[10px] font-bold uppercase ${t.status === "complete" ? "text-emerald-400" : t.status === "cancelled" ? "text-red-400" : "text-amber-300"}`}>{t.status}</span>{t.partCount && <span className={muted}>{t.received}/{t.partCount} parts</span>}<span className={muted}>{when(t.createdAt)}</span><span className={`${muted} break-all`}>{t.transferId}</span>{(t.status === "requested" || t.status === "uploading") && <button className={btn} onClick={() => act(() => j(`/api/orgs/gateway/transfers/${t.transferId}/cancel`, { method: "POST", body: JSON.stringify({ orgId }) }).then(load), "Cancelled.")}>Cancel</button>}</div>)}</div>);
}

function Audit({ orgId, act }) {
  const [gs, setGs] = useState([]); const [sel, setSel] = useState(""); const [ev, setEv] = useState([]); const [ver, setVer] = useState(null);
  useEffect(() => { j(`/api/orgs/gateway/gateways?orgId=${orgId}`).then((d) => { setGs(d.gateways); if (d.gateways[0]) setSel(d.gateways[0].gatewayId); }).catch((e) => act(() => { throw e; })); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (sel) { j(`/api/orgs/gateway/gateways/${sel}/audit?orgId=${orgId}`).then((d) => setEv(d.events)).catch(() => {}); setVer(null); } }, [sel, orgId]);
  return (<div className="space-y-2"><p className={muted}>Events the gateway recorded inside your network. Each one hashes the one before it; Inaya re-checks the chain and anchors its latest value in your organization's own audit trail.</p>
    <div className="flex gap-2 items-center"><select aria-label="Gateway" className={`${field} !w-auto`} value={sel} onChange={(e) => setSel(e.target.value)}>{gs.map((g) => <option key={g.gatewayId} value={g.gatewayId}>{g.label}</option>)}</select><button className={btn} disabled={!sel} onClick={() => act(async () => { const r = await j(`/api/orgs/gateway/gateways/${sel}/audit/verify?orgId=${orgId}`); setVer(r); return r; })}>Verify chain</button>{ver && <span className={ver.valid ? "text-emerald-400" : "text-red-400"}>{ver.valid ? `Intact (${ver.checked} events)` : `Broken at event ${ver.brokenAt}`}</span>}</div>
    {ev.length === 0 ? <p className={muted}>No events yet.</p> : ev.map((e) => <div key={e.seq} className="flex gap-3 border-t border-[var(--inaya-overlay-10)] py-1"><span className={muted}>#{e.seq}</span><span className="font-bold">{e.type}</span><span className={`${muted} break-all flex-1`}>{JSON.stringify(e.detail)}</span><span className={muted}>{when(e.at)}</span></div>)}</div>);
}
