"use client";

// NAS console, part 1: Overview, Storage, Disks, Pools, Shares, Users & Groups,
// Permissions. Every action calls a real API route that drives the real
// appliance; measured values are labelled MEASURED/DERIVED/UNKNOWN as the API
// returns them.

import { useState } from "react";
import { api, useLoad, useAction, Card, Note, Err, Btn, Input, Select, Table, Pill, fmtBytes, fmtTime, Result } from "./ui";

const q = (orgId) => `orgId=${encodeURIComponent(orgId)}`;
const body = (orgId, extra) => JSON.stringify({ orgId, ...extra });

export function ShareSelect({ shares, value, onChange }) {
  if (!shares.length) return <Note>Create a share first (Shares).</Note>;
  return <Select label="Share" value={value || ""} onChange={onChange} options={[{ value: "", label: "Choose a share…" }, ...shares.map((s) => ({ value: s._id, label: `${s.shareName} (${s.backend || "dir"})` }))]} />;
}

export function OverviewPanel({ orgId, appliance }) {
  const { data, error, reload, loading } = useLoad(`/api/orgs/nas/appliances/${appliance._id}/overview?${q(orgId)}`);
  const measure = useAction(reload);
  const cards = data?.cards ? Object.entries(data.cards) : [];
  const titles = { storageHealth: "Storage health", diskHealth: "Disk health", backupHealth: "Backup health", replicationHealth: "Replication health", securityHealth: "Security health", recoveryReadiness: "Recovery readiness", evidenceIntegrity: "Evidence integrity", digitalTwin: "Digital Twin / What-If" };
  return (
    <div className="space-y-4">
      <Card title="Is my NAS healthy? Is my data protected? Can I recover it?" right={<Btn small busy={measure.busy} onClick={() => measure.run(async () => { await api(`/api/orgs/nas/appliances/${appliance._id}/measure`, { method: "POST", body: body(orgId, {}) }); return { measured: true }; })}>Measure now</Btn>}>
        <Err error={error || measure.error} />
        {loading && <Note>Loading…</Note>}
        {data?.controlPlane && !data.controlPlane.reachableFromAppliance && <Note tone="warn">{data.controlPlane.note}</Note>}
        <Note>Last measured: {fmtTime(data?.checkedAt)}. Figures are read from the appliance; anything that cannot be measured says UNKNOWN.</Note>
      </Card>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([key, c]) => (
          <div key={key} className="rounded-lg border border-white/10 p-3 space-y-1">
            <div className="text-xs text-[var(--inaya-text-muted)]">{titles[key] || key}</div>
            <Pill value={c.status} />
            <div className="text-sm">{c.headline}</div>
            {(c.details || []).map((d, i) => <Note key={i}>{d}</Note>)}
            {c.measurement && <Note>{c.measurement}</Note>}
          </div>
        ))}
      </div>
      {data?.cards?.recoveryReadiness?.perShare?.length > 0 && (
        <Card title="Recovery readiness per share">
          <Table columns={[{ label: "Share", key: "share" }, { label: "State", render: (r) => <Pill value={r.state} /> }, { label: "Last verified backup", render: (r) => fmtTime(r.lastVerifiedBackupAt) }, { label: "Last test restore", render: (r) => fmtTime(r.lastSuccessfulDrillAt) }]} rows={data.cards.recoveryReadiness.perShare} />
          <Note>A completed backup alone is never called recoverable: a test restore must have matched the bytes.</Note>
        </Card>
      )}
      {data?.jobs && <Card title="Background jobs"><Note>{Object.entries(data.jobs.byStatus || {}).map(([k, v]) => `${k}: ${v}`).join(" · ") || "No jobs yet."}</Note></Card>}
    </div>
  );
}

export function StoragePanel({ orgId, appliance, shares }) {
  const cap = useLoad(`/api/orgs/nas/appliances/${appliance._id}/capacity?${q(orgId)}`);
  return (
    <div className="space-y-4">
      <Card title="Capacity (MEASURED)">
        <Err error={cap.error} />
        {cap.data && <Note>Appliance storage root: {fmtBytes(cap.data.nasRoot.usedBytes)} used of {fmtBytes(cap.data.nasRoot.totalBytes)} ({fmtBytes(cap.data.nasRoot.availBytes)} free).</Note>}
        <Table columns={[{ label: "Pool", key: "pool" }, { label: "Health", render: (p) => <Pill value={p.health} /> }, { label: "Level", key: "level" }, { label: "Used", render: (p) => fmtBytes(p.capacity?.usedBytes) }, { label: "Total", render: (p) => fmtBytes(p.capacity?.totalBytes) }]} rows={cap.data?.pools || []} empty="No storage pools yet (shares can also live on the appliance root filesystem)." />
        <Note>RAID / redundancy is not backup.</Note>
      </Card>
      <Card title="Share quotas">
        <Table columns={[{ label: "Share", key: "shareName" }, { label: "Backend", key: "backend" }, { label: "Hard limit", render: (s) => (s.quota?.hardBytes ? fmtBytes(s.quota.hardBytes) : "none") }, { label: "Enforced", render: (s) => (s.quota ? (s.quota.enforced ? <Pill value="OK" label="enforced by filesystem" /> : <Pill value="WARNING" label="not enforced" />) : "-") }, { label: "State", render: (s) => (s.quota ? <Pill value={s.quota.state} /> : "-") }]} rows={shares} />
        <Note>A quota is only marked enforced when the filesystem actually refuses writes past it. Directory shares on the appliance root cannot enforce quotas and say so.</Note>
      </Card>
    </div>
  );
}

export function DisksPanel({ orgId, appliance }) {
  const { data, error } = useLoad(`/api/orgs/nas/appliances/${appliance._id}/disks?${q(orgId)}`);
  return (
    <Card title="Disks">
      <Err error={error} />
      <Table columns={[{ label: "Disk", key: "name" }, { label: "Size", render: (d) => fmtBytes(d.sizeBytes) }, { label: "Model", key: "model" }, { label: "Serial", key: "serial" }, { label: "SMART", render: (d) => <span><Pill value={d.smart?.status === "PASSED" ? "OK" : d.smart?.status} label={d.smart?.status} /> <Note>{d.smart?.note || d.smart?.reason}</Note></span> }, { label: "Temperature", render: (d) => (d.temperatureC != null ? `${d.temperatureC} °C` : "UNKNOWN") }]} rows={data?.disks || []} />
      <Note>Virtual disks have no physical SMART or temperature data; those values are shown as UNKNOWN, never invented.</Note>
    </Card>
  );
}

export function PoolsPanel({ orgId, appliance }) {
  const { data, error, reload } = useLoad(`/api/orgs/nas/appliances/${appliance._id}/pools?${q(orgId)}`);
  const [name, setName] = useState("");
  const [level, setLevel] = useState("raid1");
  const [size, setSize] = useState("512");
  const [testPool, setTestPool] = useState(false);
  const act = useAction(reload);
  const poolPost = (id, payload) => api(`/api/orgs/nas/appliances/${appliance._id}/pools/${id}`, { method: "POST", body: body(orgId, payload) });
  return (
    <div className="space-y-4">
      <Card title="Create a storage pool">
        <div className="grid gap-2 sm:grid-cols-4">
          <Input id="pool-name" label="Name" value={name} onChange={setName} />
          <Select id="pool-level" label="Redundancy" value={level} onChange={setLevel} options={[{ value: "raid1", label: "RAID1 mirror (2 disks)" }, { value: "single", label: "Single disk (no redundancy)" }]} />
          <Input id="pool-size" label="Disk size (MB)" value={size} onChange={setSize} type="number" />
          <label className="flex items-end gap-2 text-xs"><input type="checkbox" checked={testPool} onChange={(e) => setTestPool(e.target.checked)} /> allow failure testing</label>
        </div>
        <Btn busy={act.busy} onClick={() => act.run(() => api(`/api/orgs/nas/appliances/${appliance._id}/pools`, { method: "POST", body: body(orgId, { name, level, memberSizeMb: Number(size), allowFailureInjection: testPool }) }))}>Create pool</Btn>
        <Err error={act.error} />
        <Note>Real Linux software RAID (mdadm) with a Btrfs filesystem on virtual disks. Single-disk pools have no redundancy.</Note>
      </Card>
      <Err error={error} />
      {(data?.pools || []).map((p) => (
        <Card key={p._id} title={`${p.name} — ${p.level}`} right={<Pill value={p.status?.health} />}>
          <Note>{p.status?.redundancy} · {fmtBytes(p.status?.capacity?.usedBytes)} used of {fmtBytes(p.status?.capacity?.totalBytes)} · checksum errors counter: {p.status?.deviceErrorCounters ?? "unknown"}</Note>
          {p.status?.md?.rebuilding && <Note tone="warn">Rebuilding: {p.status.md.rebuildPercent ?? "?"}%</Note>}
          <Note>{p.status?.reminder}</Note>
          <div className="flex flex-wrap gap-2">
            <Btn small onClick={() => act.run(() => poolPost(p._id, { action: "scrub" }))}>Scrub (verify checksums)</Btn>
            {p.level === "raid1" && p.status?.degraded && <Btn small onClick={() => act.run(() => poolPost(p._id, { action: "replace-disk", member: 1 }), "Replace the failed member and rebuild the mirror?")}>Replace disk &amp; rebuild</Btn>}
            {p.level === "raid1" && p.allowFailureInjection && !p.status?.degraded && <Btn small danger onClick={() => { const c = window.prompt('This injects a REAL disk failure. Type FAIL-DISK to continue.'); if (c) act.run(() => poolPost(p._id, { action: "simulate-disk-failure", member: 1, confirm: c })); }}>Inject disk failure (test pool)</Btn>}
            <Btn small danger onClick={() => act.run(() => api(`/api/orgs/nas/appliances/${appliance._id}/pools/${p._id}`, { method: "DELETE", body: body(orgId, {}) }), "Delete this pool and its virtual disks?")}>Delete</Btn>
          </div>
        </Card>
      ))}
      <Result result={act.result} />
    </div>
  );
}

export function SharesPanel({ orgId, appliance, shares, reloadShares }) {
  const pools = useLoad(`/api/orgs/nas/appliances/${appliance._id}/pools?${q(orgId)}`);
  const users = useLoad(`/api/orgs/nas/users?${q(orgId)}&applianceId=${appliance._id}`);
  const [f, setF] = useState({ shareName: "", owner: "", backend: "dir", poolId: "", quotaGB: "", volumeMb: "256" });
  const act = useAction(reloadShares);
  const [sel, setSel] = useState("");
  const share = shares.find((s) => s._id === sel);
  const [nfs, setNfs] = useState("");
  const [newName, setNewName] = useState("");
  const bin = useLoad(share ? `/api/orgs/nas/shares/${share._id}/recycle-bin?${q(orgId)}` : null, [sel]);
  const patch = (payload) => api(`/api/orgs/nas/shares/${share._id}`, { method: "PATCH", body: body(orgId, payload) });
  return (
    <div className="space-y-4">
      <Card title="Create a share">
        <div className="grid gap-2 sm:grid-cols-3">
          <Input id="share-name" label="Share name" value={f.shareName} onChange={(v) => setF({ ...f, shareName: v })} />
          <Select id="share-owner" label="Owner account" value={f.owner} onChange={(v) => setF({ ...f, owner: v })} options={[{ value: "", label: "Choose…" }, ...(users.data?.nasUsers || []).map((u) => ({ value: u.unixUsername, label: u.unixUsername }))]} />
          <Select id="share-backend" label="Storage" value={f.backend} onChange={(v) => setF({ ...f, backend: v })} options={[{ value: "dir", label: "Directory (no snapshots/quotas)" }, { value: "btrfs", label: "Btrfs pool (snapshots, quotas)" }, { value: "ext4quota", label: "Quota volume (per-user quotas)" }]} />
          {f.backend === "btrfs" && <Select id="share-pool" label="Pool" value={f.poolId} onChange={(v) => setF({ ...f, poolId: v })} options={[{ value: "", label: "Choose…" }, ...(pools.data?.pools || []).map((p) => ({ value: p._id, label: p.name }))]} />}
          {f.backend === "ext4quota" && <Input label="Volume size (MB)" value={f.volumeMb} onChange={(v) => setF({ ...f, volumeMb: v })} type="number" />}
          {f.backend !== "ext4quota" && <Input label="Hard quota (GB, optional)" value={f.quotaGB} onChange={(v) => setF({ ...f, quotaGB: v })} type="number" />}
        </div>
        <Btn busy={act.busy} onClick={() => act.run(() => api("/api/orgs/nas/shares", { method: "POST", body: body(orgId, { applianceId: appliance._id, shareName: f.shareName.trim(), ownerUnixUser: f.owner, backend: f.backend, poolId: f.poolId || undefined, quotaBytes: f.quotaGB ? Number(f.quotaGB) * 1073741824 : undefined, volumeSizeMb: Number(f.volumeMb) }) }))}>Create real share</Btn>
        <Err error={act.error} />
      </Card>
      <Card title="Shares">
        <Table columns={[{ label: "Name", key: "shareName" }, { label: "Storage", key: "backend" }, { label: "NFS", render: (s) => (s.protocols?.nfs?.enabled ? "on" : "off") }, { label: "Protection", render: (s) => [s.worm?.enabled ? "WORM" : null, s.access?.lockdown?.active ? "LOCKED DOWN" : null, s.access?.enabled === false ? "disabled" : null].filter(Boolean).join(", ") || "-" }, { label: "", render: (s) => <Btn small onClick={() => setSel(s._id)}>Manage</Btn> }]} rows={shares} />
      </Card>
      {share && (
        <Card title={`Manage ${share.shareName}`}>
          <div className="flex flex-wrap gap-2">
            <Btn small onClick={() => act.run(() => patch({ enabled: share.access?.enabled === false }))}>{share.access?.enabled === false ? "Enable" : "Disable"}</Btn>
            <Btn small onClick={() => act.run(() => patch({ hidden: !share.access?.hidden }))}>{share.access?.hidden ? "Unhide" : "Hide"}</Btn>
            <Btn small danger onClick={() => act.run(() => api(`/api/orgs/nas/shares/${share._id}`, { method: "DELETE", body: body(orgId, {}) }), `Remove share ${share.shareName}? Data is kept unless purged.`)}>Delete share (keep data)</Btn>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input label="Rename to" value={newName} onChange={setNewName} />
            <div className="flex items-end"><Btn small onClick={() => act.run(() => patch({ newName }))}>Rename</Btn></div>
            <Input label="NFS client networks (comma separated, never a wildcard)" value={nfs} onChange={setNfs} placeholder="192.168.1.0/24" />
            <div className="flex items-end gap-2">
              <Btn small onClick={() => act.run(() => api(`/api/orgs/nas/shares/${share._id}/nfs`, { method: "PUT", body: body(orgId, { enabled: true, clients: nfs.split(",").map((x) => x.trim()).filter(Boolean) }) }))}>Enable NFS export</Btn>
              <Btn small onClick={() => act.run(() => api(`/api/orgs/nas/shares/${share._id}/nfs`, { method: "PUT", body: body(orgId, { enabled: false }) }))}>Disable</Btn>
            </div>
          </div>
          <h4 className="text-sm font-semibold">Recycle bin</h4>
          <Table columns={[{ label: "Original path", key: "originalPath" }, { label: "Deleted by", key: "user" }, { label: "Size", render: (e) => fmtBytes(e.sizeBytes) }, { label: "Deleted", render: (e) => fmtTime(e.deletedAt) }, { label: "", render: (e) => <span className="flex gap-2"><Btn small onClick={() => act.run(async () => { await api(`/api/orgs/nas/shares/${share._id}/recycle-bin`, { method: "POST", body: body(orgId, { recyclePath: e.recyclePath }) }); bin.reload(); return { restored: e.originalPath }; })}>Restore</Btn><Btn small danger onClick={() => act.run(async () => { await api(`/api/orgs/nas/shares/${share._id}/recycle-bin`, { method: "DELETE", body: body(orgId, { recyclePath: e.recyclePath }) }); bin.reload(); return { purged: e.originalPath }; }, "Permanently delete this file?")}>Delete forever</Btn></span> }]} rows={bin.data?.entries || []} empty="The recycle bin is empty." />
        </Card>
      )}
      <Result result={act.result} />
    </div>
  );
}

export function UsersPanel({ orgId, appliance }) {
  const users = useLoad(`/api/orgs/nas/users?${q(orgId)}&applianceId=${appliance._id}`);
  const groups = useLoad(`/api/orgs/nas/appliances/${appliance._id}/groups?${q(orgId)}`);
  const identity = useLoad(`/api/orgs/nas/appliances/${appliance._id}/identity?${q(orgId)}`);
  const [email, setEmail] = useState("");
  const [svc, setSvc] = useState("");
  const [grp, setGrp] = useState("");
  const [attempts, setAttempts] = useState("5");
  const [minutes, setMinutes] = useState("15");
  const [secret, setSecret] = useState(null);
  const act = useAction(async (r) => { users.reload(); groups.reload(); if (r?.initialPassword || r?.newPassword) setSecret(r.initialPassword || r.newPassword); });
  const userPost = (id, payload) => api(`/api/orgs/nas/users/${id}`, { method: "POST", body: body(orgId, payload) });
  return (
    <div className="space-y-4">
      <Card title="NAS logins">
        <div className="grid gap-2 sm:grid-cols-2">
          <Input id="nas-email" label="Organization member email" value={email} onChange={setEmail} placeholder="member@company.com" />
          <div className="flex items-end"><Btn busy={act.busy} onClick={() => act.run(() => api("/api/orgs/nas/users", { method: "POST", body: body(orgId, { applianceId: appliance._id, memberEmail: email.trim() }) }))}>Create login</Btn></div>
          <Input label="Service account name" value={svc} onChange={setSvc} placeholder="backup-agent" />
          <div className="flex items-end"><Btn busy={act.busy} onClick={() => act.run(() => api("/api/orgs/nas/users", { method: "POST", body: body(orgId, { applianceId: appliance._id, kind: "service", name: svc }) }))}>Create service account</Btn></div>
        </div>
        {secret && <div className="rounded border border-amber-400/40 p-2 text-sm">Password (shown once — copy it now): <code className="select-all">{secret}</code> <Btn small onClick={() => setSecret(null)}>Hide</Btn></div>}
        <Err error={act.error} />
        <Table columns={[{ label: "Account", key: "unixUsername" }, { label: "Person", render: (u) => u.memberEmail || <Pill value="PENDING" label="service" /> }, { label: "Password rotated", render: (u) => fmtTime(u.passwordRotatedAt) }, { label: "", render: (u) => (
          <span className="flex flex-wrap gap-1">
            <Btn small onClick={() => act.run(() => userPost(u._id, { action: "rotate-password" }))}>Rotate password</Btn>
            <Btn small onClick={() => act.run(() => userPost(u._id, { action: u.disabledAt ? "enable" : "disable" }))}>{u.disabledAt ? "Enable" : "Disable"}</Btn>
            <Btn small onClick={() => act.run(() => userPost(u._id, { action: "unlock" }))}>Unlock</Btn>
            <Btn small danger onClick={() => act.run(() => api(`/api/orgs/nas/users/${u._id}`, { method: "DELETE", body: body(orgId, {}) }), `Revoke ${u.unixUsername}? Their sessions are closed.`)}>Revoke</Btn>
          </span>) }]} rows={users.data?.nasUsers || []} empty="No NAS logins yet. Only organization members with a NAS role can get one." />
      </Card>
      <Card title="Groups">
        <div className="flex gap-2 items-end"><Input label="New group" value={grp} onChange={setGrp} /><Btn onClick={() => act.run(() => api(`/api/orgs/nas/appliances/${appliance._id}/groups`, { method: "POST", body: body(orgId, { name: grp }) }))}>Create</Btn></div>
        <Table columns={[{ label: "Group", key: "unixGroup" }, { label: "Members", render: (g) => (g.members || []).length }, { label: "Add member", render: (g) => (
          <select className="rounded border border-white/10 bg-transparent px-1 py-0.5 text-xs" defaultValue="" onChange={(e) => e.target.value && act.run(() => api(`/api/orgs/nas/groups/${g._id}`, { method: "POST", body: body(orgId, { nasUserId: e.target.value, action: "add" }) }))}>
            <option value="">choose…</option>{(users.data?.nasUsers || []).map((u) => <option key={u._id} value={u._id}>{u.unixUsername}</option>)}
          </select>) }]} rows={groups.data?.groups || []} empty="No groups." />
      </Card>
      <Card title="Brute-force protection">
        <div className="grid gap-2 sm:grid-cols-3">
          <Input label="Lock after failed logons" value={attempts} onChange={setAttempts} type="number" />
          <Input label="Lockout minutes" value={minutes} onChange={setMinutes} type="number" />
          <div className="flex items-end"><Btn onClick={() => act.run(() => api(`/api/orgs/nas/appliances/${appliance._id}/lockout-policy`, { method: "PUT", body: body(orgId, { attempts: Number(attempts), durationMinutes: Number(minutes) }) }))}>Apply</Btn></div>
        </div>
        <Note>Enforced by Samba on the appliance. Management access is protected by your Inaya sign-in (SMB/NFS cannot use MFA).</Note>
      </Card>
      {identity.data && <Card title="Enterprise identity (honest status)"><ul className="text-xs space-y-1">{Object.entries(identity.data.capabilities).map(([k, v]) => <li key={k}><b>{k}:</b> {v}</li>)}</ul></Card>}
    </div>
  );
}

export function PermissionsPanel({ orgId, appliance, shares }) {
  const [shareId, setShareId] = useState("");
  const share = shares.find((s) => s._id === shareId);
  const users = useLoad(`/api/orgs/nas/users?${q(orgId)}&applianceId=${appliance._id}`);
  const groups = useLoad(`/api/orgs/nas/appliances/${appliance._id}/groups?${q(orgId)}`);
  const [principal, setPrincipal] = useState("");
  const [level, setLevel] = useState("read");
  const [relPath, setRelPath] = useState("");
  const [folderPrincipal, setFolderPrincipal] = useState("");
  const [perms, setPerms] = useState("---");
  const act = useAction();
  const entries = share?.access?.entries || [];
  const nameOf = (e) => (e.principalType === "group" ? (groups.data?.groups || []).find((g) => g._id === e.principalId)?.unixGroup : (users.data?.nasUsers || []).find((u) => u._id === e.principalId)?.unixUsername) || e.principalId;
  const save = (next) => act.run(() => api(`/api/orgs/nas/shares/${shareId}/access`, { method: "PUT", body: body(orgId, { entries: next.map((e) => ({ principalType: e.principalType, principalId: String(e.principalId), level: e.level })) }) }).then((r) => { if (share) share.access = r.access; return r; }));
  const options = [{ value: "", label: "Choose…" }, ...(users.data?.nasUsers || []).map((u) => ({ value: `user:${u._id}`, label: `user ${u.unixUsername}` })), ...(groups.data?.groups || []).map((g) => ({ value: `group:${g._id}`, label: `group ${g.unixGroup}` }))];
  return (
    <div className="space-y-4">
      <Card title="Who can use a share">
        <ShareSelect shares={shares} value={shareId} onChange={setShareId} />
        {share && (
          <>
            <Table columns={[{ label: "Principal", render: nameOf }, { label: "Type", key: "principalType" }, { label: "Access", render: (e) => <Pill value={e.level === "deny" ? "HIGH" : "OK"} label={e.level} /> }, { label: "", render: (e) => <Btn small danger onClick={() => save(entries.filter((x) => x !== e))}>Remove</Btn> }]} rows={entries} empty="Nobody but the owner can use this share yet." />
            <div className="grid gap-2 sm:grid-cols-3">
              <Select label="Add" value={principal} onChange={setPrincipal} options={options} />
              <Select label="Access" value={level} onChange={setLevel} options={["read", "write", "deny"]} />
              <div className="flex items-end"><Btn onClick={() => { const [t, id] = principal.split(":"); if (id) save([...entries, { principalType: t, principalId: id, level }]); }}>Save access</Btn></div>
            </div>
            <Note>Enforced by Samba on the appliance, not just in this page. Only current organization members with a NAS role (and inside any department boundary) can be added.</Note>
          </>
        )}
        <Err error={act.error} />
      </Card>
      {share && (
        <Card title="Folder-level ACL (POSIX)">
          <div className="grid gap-2 sm:grid-cols-4">
            <Input label="Folder path in the share" value={relPath} onChange={setRelPath} placeholder="Finance/Payroll" />
            <Select label="Account" value={folderPrincipal} onChange={setFolderPrincipal} options={options.filter((o) => !o.value || o.value.startsWith("user:") || o.value.startsWith("group:"))} />
            <Select label="Permission" value={perms} onChange={setPerms} options={[{ value: "---", label: "--- (explicit deny)" }, { value: "r-x", label: "r-x (read)" }, { value: "rwx", label: "rwx (full)" }]} />
            <div className="flex items-end"><Btn onClick={() => { const [t, id] = folderPrincipal.split(":"); if (id) act.run(() => api(`/api/orgs/nas/shares/${shareId}/acl`, { method: "PUT", body: body(orgId, { relPath, recursive: true, entries: [{ principalType: t, principalId: id, perms }] }) })); }}>Apply ACL</Btn></div>
          </div>
          <Result result={act.result} />
        </Card>
      )}
    </div>
  );
}
