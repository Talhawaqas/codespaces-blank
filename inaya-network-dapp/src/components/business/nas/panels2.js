"use client";

// NAS console, part 2: Snapshots, Backup, Replication, Cloud Targets, Security,
// Hardware Health, Audit, Evidence, Digital Twin, Updates, Settings.

import { useState } from "react";
import { api, useLoad, useAction, Card, Note, Err, Btn, Input, Select, Table, Pill, fmtBytes, fmtTime, Result } from "./ui";
import { ShareSelect } from "./panels1";

const q = (orgId) => `orgId=${encodeURIComponent(orgId)}`;
const body = (orgId, extra) => JSON.stringify({ orgId, ...extra });

export function SnapshotsPanel({ orgId, shares }) {
  const [shareId, setShareId] = useState("");
  const snaps = useLoad(shareId ? `/api/orgs/nas/shares/${shareId}/snapshots?${q(orgId)}` : null, [shareId]);
  const worm = useLoad(shareId ? `/api/orgs/nas/shares/${shareId}/worm?${q(orgId)}` : null, [shareId]);
  const policy = useLoad(shareId ? `/api/orgs/nas/shares/${shareId}/snapshot-policy?${q(orgId)}` : null, [shareId]);
  const [name, setName] = useState("");
  const [immutable, setImmutable] = useState(false);
  const [days, setDays] = useState("30");
  const [mode, setMode] = useState("governance");
  const [interval, setInterval_] = useState("1440");
  const [keep, setKeep] = useState("7");
  const [wormDays, setWormDays] = useState("30");
  const act = useAction(async () => { snaps.reload(); worm.reload(); policy.reload(); });
  const share = shares.find((s) => s._id === shareId);
  return (
    <div className="space-y-4">
      <Card title="Snapshots & immutable protection"><ShareSelect shares={shares} value={shareId} onChange={setShareId} />
        <Note>Btrfs shares get copy-on-write snapshots (near-instant). Directory shares get full copies. &ldquo;Immutable&rdquo; is used only when deletion is technically blocked for the retention period (filesystem immutable flag + read-only); it is governance-grade — root on the appliance can still lift it.</Note>
      </Card>
      {shareId && (
        <>
          <Card title="Take a snapshot">
            <div className="grid gap-2 sm:grid-cols-4">
              <Input label="Name (optional)" value={name} onChange={setName} />
              <label className="flex items-end gap-2 text-xs"><input type="checkbox" checked={immutable} onChange={(e) => setImmutable(e.target.checked)} /> make immutable</label>
              {immutable && <Input label="Retention (days)" value={days} onChange={setDays} type="number" />}
              {immutable && <Select label="Lock mode" value={mode} onChange={setMode} options={[{ value: "governance", label: "Governance (owner override with reason)" }, { value: "compliance", label: "Compliance (no override)" }]} />}
            </div>
            <Btn busy={act.busy} onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/snapshots`, { method: "POST", body: body(orgId, { name: name || undefined, immutable, retentionDays: immutable ? Number(days) : undefined, lockMode: mode }) }))}>Create snapshot</Btn>
            <Err error={act.error} />
          </Card>
          <Card title="Snapshots">
            <Table columns={[{ label: "Name", key: "name" }, { label: "Kind", render: (s) => s.type }, { label: "State", render: (s) => (s.semantics?.immutable ? <Pill value="OK" label={`immutable until ${fmtTime(s.retentionUntil)}`} /> : "mutable") }, { label: "Files", key: "fileCount" }, { label: "Size", render: (s) => fmtBytes(s.totalBytes) }, { label: "Created", render: (s) => fmtTime(s.createdAt) }, { label: "", render: (s) => (
              <span className="flex flex-wrap gap-1">
                <Btn small onClick={() => act.run(async () => (await api(`/api/orgs/nas/shares/${shareId}/snapshots/${s._id}?${q(orgId)}`)))}>Verify</Btn>
                <Btn small onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/snapshots/${s._id}`, { method: "POST", body: body(orgId, {}) }), "Restore this snapshot side-by-side into .restored/ (live data is not touched)?")}>Restore copy</Btn>
                <Btn small danger onClick={() => { const reason = s.semantics?.immutable ? window.prompt("This snapshot is locked. Governance override needs a reason (10+ characters); compliance mode refuses.") : "manual delete"; if (reason) act.run(() => api(`/api/orgs/nas/shares/${shareId}/snapshots/${s._id}`, { method: "DELETE", body: body(orgId, { override: !!s.semantics?.immutable, reason }) })); }}>Delete</Btn>
              </span>) }]} rows={snaps.data?.snapshots || []} empty="No snapshots yet." />
          </Card>
          <Card title="Scheduled snapshots">
            <div className="grid gap-2 sm:grid-cols-4">
              <Input label="Every (minutes)" value={interval} onChange={setInterval_} type="number" />
              <Input label="Keep last" value={keep} onChange={setKeep} type="number" />
              <div className="flex items-end"><Btn onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/snapshot-policy`, { method: "PUT", body: body(orgId, { intervalMinutes: Number(interval), keepLast: Number(keep), immutable, retentionDays: immutable ? Number(days) : undefined }) }))}>Save policy</Btn></div>
            </div>
            {policy.data?.policy && <Note>Active: every {policy.data.policy.intervalMinutes} min, keep {policy.data.policy.keepLast}{policy.data.policy.immutable ? ", immutable" : ""}. Locked snapshots are never pruned.</Note>}
          </Card>
          <Card title="WORM (write-once) protection">
            <Note>Directories become append-only and settled files immutable until retention ends: a user, or ransomware using a share login, cannot delete or overwrite them. {worm.data?.note}</Note>
            <Note>Status: {worm.data?.appliance?.enabled ? `enabled — ${worm.data.appliance.sealedFiles} file(s) sealed, mode ${worm.data.appliance.mode}` : "off"}</Note>
            <div className="flex flex-wrap items-end gap-2">
              <Input label="Retention (days)" value={wormDays} onChange={setWormDays} type="number" width="w-40" />
              <Btn onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/worm`, { method: "PUT", body: body(orgId, { enabled: true, retentionDays: Number(wormDays), settleMinutes: 5, mode }) }), "Files become undeletable until retention ends. Continue?")}>Enable WORM</Btn>
              {share?.worm?.enabled && <Btn danger onClick={() => { const reason = window.prompt("Files are under retention. Disabling needs an owner/admin override reason (10+ characters); compliance mode refuses."); if (reason) act.run(() => api(`/api/orgs/nas/shares/${shareId}/worm`, { method: "PUT", body: body(orgId, { enabled: false, override: true, reason }) })); }}>Disable</Btn>}
            </div>
          </Card>
          <Result result={act.result} />
        </>
      )}
    </div>
  );
}

export function BackupPanel({ orgId, shares }) {
  const [shareId, setShareId] = useState("");
  const runs = useLoad(shareId ? `/api/orgs/nas/shares/${shareId}/backup?${q(orgId)}` : null, [shareId]);
  const ready = useLoad(shareId ? `/api/orgs/nas/shares/${shareId}/recovery-drill?${q(orgId)}` : null, [shareId]);
  const targets = useLoad(`/api/orgs/nas/cloud-targets?${q(orgId)}`);
  const [target, setTarget] = useState("inaya");
  const [verify, setVerify] = useState("sample");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [interval, setInterval_] = useState("1440");
  const act = useAction(async () => { runs.reload(); ready.reload(); });
  return (
    <div className="space-y-4">
      <Card title="Backup to Inaya (and other targets)"><ShareSelect shares={shares} value={shareId} onChange={setShareId} />
        <Note>Uses Inaya&rsquo;s existing encrypted, sharded storage. Unchanged files are not uploaded again; every run reads files back to verify them. Encryption on this path is server-managed (SMB/NFS clients do not run Inaya&rsquo;s browser-side encryption).</Note>
      </Card>
      {shareId && (
        <>
          <Card title="Recovery readiness" right={ready.data && <Pill value={ready.data.state} />}>
            <Note>{ready.data?.note}</Note>
            <div className="flex gap-2">
              <Btn busy={act.busy} onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/recovery-drill`, { method: "POST", body: body(orgId, { sampleFiles: 3 }) }))}>Run a test restore (drill)</Btn>
            </div>
          </Card>
          <Card title="Run a backup now">
            <div className="grid gap-2 sm:grid-cols-3">
              <Select label="Target" value={target} onChange={setTarget} options={(targets.data?.targets || []).map((t) => ({ value: t._id, label: `${t.label}${t.verified ? "" : " (untested)"}` }))} />
              <Select label="Verification" value={verify} onChange={setVerify} options={[{ value: "sample", label: "New files + a sample" }, { value: "full", label: "Read back everything" }]} />
              <div className="flex items-end"><Btn busy={act.busy} onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/backup`, { method: "POST", body: body(orgId, { targetId: target, verify }) }))}>Back up now</Btn></div>
            </div>
            <Err error={act.error} />
          </Card>
          <Card title="Schedule">
            <div className="grid gap-2 sm:grid-cols-4">
              <Input label="Every (minutes)" value={interval} onChange={setInterval_} type="number" />
              <Input label="Only these folders (comma)" value={include} onChange={setInclude} />
              <Input label="Skip patterns (comma)" value={exclude} onChange={setExclude} placeholder="*.tmp,cache" />
              <div className="flex items-end"><Btn onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/backup-policy`, { method: "PUT", body: body(orgId, { intervalMinutes: Number(interval), includePaths: include.split(",").map((x) => x.trim()).filter(Boolean), excludePatterns: exclude.split(",").map((x) => x.trim()).filter(Boolean), targetIds: [target], verify }) }))}>Save schedule</Btn></div>
            </div>
          </Card>
          <Card title="Backup runs / recovery points">
            <Table columns={[{ label: "Started", render: (r) => fmtTime(r.startedAt) }, { label: "Status", render: (r) => <Pill value={r.status} /> }, { label: "Uploaded", key: "filesBackedUp" }, { label: "Skipped (unchanged)", key: "filesSkipped" }, { label: "Verified", key: "filesVerified" }, { label: "Failed", key: "filesFailed" }, { label: "", render: (r) => (r.recoveryPoint ? <Btn small onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/backup/${r._id}`, { method: "POST", body: body(orgId, { target: "original" }) }), "Restore this recovery point into .restored/ (live data is not overwritten)?")}>Restore copy</Btn> : null) }]} rows={runs.data?.runs || []} empty="No backups yet." />
          </Card>
          <Result result={act.result} />
        </>
      )}
    </div>
  );
}

export function ReplicationPanel({ orgId, appliance, shares }) {
  const [shareId, setShareId] = useState("");
  const policies = useLoad(shareId ? `/api/orgs/nas/shares/${shareId}/replication?${q(orgId)}` : null, [shareId]);
  const apps = useLoad(`/api/orgs/nas/appliances?${q(orgId)}`);
  const [mode, setMode] = useState("nas-to-nas");
  const [targetApp, setTargetApp] = useState("");
  const [interval, setInterval_] = useState("60");
  const act = useAction(async () => policies.reload());
  const post = (id, payload) => api(`/api/orgs/nas/replication/${id}`, { method: "POST", body: body(orgId, payload) });
  return (
    <div className="space-y-4">
      <Card title="Replication"><ShareSelect shares={shares} value={shareId} onChange={setShareId} />
        <Note tone="warn">NAS→NAS replication is real (rsync with checksums and manifest comparison) but, with a single appliance host in this environment, the target is another appliance record served by the same host. Cross-host transport is not implemented.</Note>
        <Note>NAS→Inaya replication is the backup engine on a schedule.</Note>
      </Card>
      {shareId && (
        <>
          <Card title="New replication policy">
            <div className="grid gap-2 sm:grid-cols-4">
              <Select label="Mode" value={mode} onChange={setMode} options={[{ value: "nas-to-nas", label: "NAS → NAS" }, { value: "nas-to-inaya", label: "NAS → Inaya" }]} />
              {mode === "nas-to-nas" && <Select label="Target appliance" value={targetApp} onChange={setTargetApp} options={[{ value: "", label: "Choose…" }, ...(apps.data?.appliances || []).map((a) => ({ value: a._id, label: a.name }))]} />}
              <Input label="Every (minutes)" value={interval} onChange={setInterval_} type="number" />
              <div className="flex items-end"><Btn busy={act.busy} onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/replication`, { method: "POST", body: body(orgId, { mode, targetApplianceId: targetApp || undefined, intervalMinutes: Number(interval) }) }))}>Create</Btn></div>
            </div>
            <Err error={act.error} />
          </Card>
          <Card title="Policies">
            <Table columns={[{ label: "Mode", key: "mode" }, { label: "Health", render: (p) => <Pill value={p.health} /> }, { label: "Last success", render: (p) => fmtTime(p.lastSuccessAt) }, { label: "Last error", render: (p) => p.lastError || "-" }, { label: "", render: (p) => (
              <span className="flex flex-wrap gap-1">
                <Btn small onClick={() => act.run(() => post(p._id, { action: "run" }))}>Run now</Btn>
                {p.mode === "nas-to-nas" && <Btn small onClick={() => act.run(() => post(p._id, { action: "verify" }))}>Verify replica</Btn>}
                {p.mode === "nas-to-nas" && <Btn small onClick={() => { const n = window.prompt("Name for the failover share (test failover is read-only):"); const owner = window.prompt("Owner account:"); if (n && owner) act.run(() => post(p._id, { action: "failover", mode: "test", shareName: n, ownerUnixUser: owner })); }}>Test failover</Btn>}
                <Btn small danger onClick={() => act.run(() => api(`/api/orgs/nas/replication/${p._id}`, { method: "DELETE", body: body(orgId, {}) }))}>Delete</Btn>
              </span>) }]} rows={policies.data?.policies || []} empty="No replication configured." />
          </Card>
          <Result result={act.result} />
        </>
      )}
    </div>
  );
}

export function CloudTargetsPanel({ orgId }) {
  const targets = useLoad(`/api/orgs/nas/cloud-targets?${q(orgId)}`);
  const [f, setF] = useState({ kind: "s3-compatible", label: "", endpoint: "", region: "us-east-1", bucket: "", prefix: "", accessKeyId: "", secretAccessKey: "" });
  const act = useAction(async () => targets.reload());
  return (
    <div className="space-y-4">
      <Card title="Cloud targets"><Note>One backup engine, several destinations. Inaya sovereign storage is built in. S3-compatible targets are tested with a write/read/delete probe before use. Google interoperability targets stay UNTESTED (and unusable) until their own test passes; Azure Blob is not available as an outbound target.</Note>
        <Table columns={[{ label: "Label", key: "label" }, { label: "Kind", key: "kind" }, { label: "Status", render: (t) => <Pill value={t.verified ? "OK" : "PENDING"} label={t.verified ? "tested" : "untested"} /> }, { label: "Last success", render: (t) => fmtTime(t.health?.lastSuccessAt) }, { label: "Bytes sent", render: (t) => fmtBytes(t.health?.bytesTransferred) }, { label: "Last error", render: (t) => t.health?.lastError || "-" }, { label: "", render: (t) => (t.builtIn ? null : (
          <span className="flex gap-1"><Btn small onClick={() => act.run(() => api(`/api/orgs/nas/cloud-targets/${t._id}`, { method: "POST", body: body(orgId, {}) }))}>Test connection</Btn><Btn small danger onClick={() => act.run(() => api(`/api/orgs/nas/cloud-targets/${t._id}`, { method: "DELETE", body: body(orgId, {}) }))}>Delete</Btn></span>)) }]} rows={targets.data?.targets || []} />
      </Card>
      <Card title="Add a target">
        <div className="grid gap-2 sm:grid-cols-3">
          <Select label="Kind" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[{ value: "s3-compatible", label: "S3-compatible (AWS S3, Filebase, Wasabi, MinIO…)" }, { value: "gcs-interop", label: "Google Cloud Storage (interoperability, untested)" }]} />
          <Input label="Label" value={f.label} onChange={(v) => setF({ ...f, label: v })} />
          <Input label="Endpoint (https)" value={f.endpoint} onChange={(v) => setF({ ...f, endpoint: v })} placeholder="https://s3.us-east-1.amazonaws.com" />
          <Input label="Bucket" value={f.bucket} onChange={(v) => setF({ ...f, bucket: v })} />
          <Input label="Folder prefix" value={f.prefix} onChange={(v) => setF({ ...f, prefix: v })} />
          <Input label="Access key id" value={f.accessKeyId} onChange={(v) => setF({ ...f, accessKeyId: v })} />
          <Input label="Secret access key" value={f.secretAccessKey} onChange={(v) => setF({ ...f, secretAccessKey: v })} type="password" />
        </div>
        <Btn busy={act.busy} onClick={() => act.run(() => api("/api/orgs/nas/cloud-targets", { method: "POST", body: body(orgId, f) }))}>Save (encrypted at rest)</Btn>
        <Err error={act.error} /><Result result={act.result?.verified !== undefined ? act.result : null} />
      </Card>
    </div>
  );
}

export function SecurityPanel({ orgId, appliance, shares }) {
  const [shareId, setShareId] = useState("");
  const events = useLoad(shareId ? `/api/orgs/nas/shares/${shareId}/threat?${q(orgId)}` : null, [shareId]);
  const locks = useLoad(`/api/orgs/nas/appliances/${appliance._id}/locks?${q(orgId)}`);
  const remote = useLoad(`/api/orgs/nas/appliances/${appliance._id}/remote-access?${q(orgId)}`);
  const [auto, setAuto] = useState(false);
  const act = useAction(async () => { events.reload(); remote.reload(); });
  const threatPost = (payload) => api(`/api/orgs/nas/shares/${shareId}/threat`, { method: "POST", body: body(orgId, payload) });
  return (
    <div className="space-y-4">
      <Card title="Ransomware / threat protection"><ShareSelect shares={shares} value={shareId} onChange={setShareId} />
        <Note>Signals are measured: files changed or deleted against a baseline, encryption-like rewrites, new suspicious extensions or ransom notes, repeated failed logons, and attempts to delete protected snapshots. The default response is protective and reversible (an immutable snapshot and an alert). A lockdown is automatic only if you enable it, only when CRITICAL, and always expires.</Note>
      </Card>
      {shareId && (
        <>
          <Card title="Actions">
            <div className="flex flex-wrap gap-2">
              <Btn onClick={() => act.run(() => threatPost({ action: "baseline" }))}>Set clean baseline</Btn>
              <Btn onClick={() => act.run(() => threatPost({ action: "scan" }))}>Scan now</Btn>
              <Btn onClick={() => act.run(() => threatPost({ action: "lift-lockdown" }))}>Lift lockdown</Btn>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> allow automatic lockdown (CRITICAL only)</label>
              <Btn onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/threat`, { method: "PUT", body: body(orgId, { enabled: true, autoSnapshot: true, autoLockdown: auto, lockdownMinutes: 60, scanIntervalMinutes: 15 }) }))}>Save threat policy</Btn>
            </div>
            <Err error={act.error} /><Result result={act.result} />
          </Card>
          <Card title="Threat events">
            <Table columns={[{ label: "Detected", render: (e) => fmtTime(e.detectedAt) }, { label: "Level", render: (e) => <Pill value={e.level} /> }, { label: "State", key: "state" }, { label: "Why", render: (e) => (e.reasons || []).join("; ") }, { label: "Protection", render: (e) => [e.protection?.snapshot?.name && `snapshot ${e.protection.snapshot.name}`, e.protection?.lockdown?.state && `lockdown ${e.protection.lockdown.state}`].filter(Boolean).join(", ") || "-" }, { label: "", render: (e) => (e.state === "OPEN" ? (
              <span className="flex gap-1">
                {e.protection?.lockdown?.state === "RECOMMENDED" && <Btn small danger onClick={() => act.run(() => api(`/api/orgs/nas/threat-events/${e._id}`, { method: "POST", body: body(orgId, { action: "approve-lockdown", minutes: 60 }) }), "Make this share read-only for 60 minutes?")}>Approve lockdown</Btn>}
                <Btn small onClick={() => act.run(() => api(`/api/orgs/nas/threat-events/${e._id}`, { method: "POST", body: body(orgId, { action: "resolve", resolution: "CONTAINED" }) }))}>Mark contained</Btn>
                <Btn small onClick={() => act.run(() => api(`/api/orgs/nas/threat-events/${e._id}`, { method: "POST", body: body(orgId, { action: "resolve", resolution: "FALSE_POSITIVE" }) }))}>False positive</Btn>
              </span>) : null) }]} rows={events.data?.events || []} empty="No threat events." />
          </Card>
        </>
      )}
      <Card title="Remote access">
        <Note>Current: <b>{remote.data?.remoteAccess?.label || remote.data?.remoteAccess?.mode}</b>. {remote.data?.warning}</Note>
        <div className="flex flex-wrap gap-2">
          {[["LOCAL_ONLY", "Local only"], ["PRIVATE_NETWORK", "Private network"], ["GATEWAY", "Via Inaya gateway"]].map(([m, l]) => <Btn key={m} small onClick={() => act.run(() => api(`/api/orgs/nas/appliances/${appliance._id}/remote-access`, { method: "PUT", body: body(orgId, { mode: m }) }), `Switch to ${l}? This is enforced on the appliance and audited.`)}>{l}</Btn>)}
        </div>
      </Card>
      <Card title="Open files & sessions (MEASURED)">
        <Table columns={[{ label: "File", key: "path" }, { label: "Sharing", key: "sharemode" }, { label: "Oplock", key: "oplock" }]} rows={locks.data?.locks || []} empty="No files are currently open." />
        <Note>{(locks.data?.sessions || []).length} SMB session(s).</Note>
      </Card>
    </div>
  );
}

export function HealthPanel({ orgId, appliance }) {
  const measure = useAction();
  const [state, setState] = useState(null);
  const run = () => measure.run(async () => { const r = await api(`/api/orgs/nas/appliances/${appliance._id}/measure`, { method: "POST", body: body(orgId, {}) }); setState(r.state); return { measuredInMs: r.state.measuredInMs }; });
  const m = state?.metrics;
  const row = (label, v) => <tr key={label} className="border-t border-white/5"><td className="py-1 pr-3">{label}</td><td className="py-1 pr-3">{v?.text}</td><td className="py-1"><Pill value={v?.label === "MEASURED" ? "OK" : "PENDING"} label={v?.label || "UNKNOWN"} /></td></tr>;
  const rows = m ? [
    ["CPU", { text: `${m.cpuPercent?.value}%`, label: m.cpuPercent?.measurement }],
    ["Memory", { text: `${fmtBytes(m.memory?.availableBytes)} free of ${fmtBytes(m.memory?.totalBytes)}`, label: m.memory?.measurement }],
    ["Load average", { text: (m.loadAverage?.values || []).join(" / "), label: m.loadAverage?.measurement }],
    ["Uptime", { text: `${Math.round((m.uptimeSeconds?.value || 0) / 60)} min`, label: m.uptimeSeconds?.measurement }],
    ["Disk activity (window)", { text: `${m.diskIo?.readOps} reads / ${m.diskIo?.writeOps} writes`, label: m.diskIo?.measurement }],
    ["SMB sessions", { text: String(m.smbSessions?.value ?? "unknown"), label: m.smbSessions?.measurement }],
    ["Temperature", { text: m.thermal?.celsius != null ? `${m.thermal.celsius} °C` : m.thermal?.reason, label: m.thermal?.measurement }],
    ["Fans", { text: m.fans?.reason, label: m.fans?.measurement }],
    ["UPS", { text: m.ups?.reason, label: m.ups?.measurement }],
    ["Storage latency", { text: m.storageLatency?.reason, label: m.storageLatency?.measurement }],
  ] : [];
  return (
    <div className="space-y-4">
      <Card title="Hardware & resource health" right={<Btn small busy={measure.busy} onClick={run}>Measure now</Btn>}>
        <Err error={measure.error} />
        {!state && <Note>Press &ldquo;Measure now&rdquo;. Nothing is estimated: each value is MEASURED, DERIVED, ESTIMATED or UNKNOWN.</Note>}
        {state && <table className="w-full text-left text-sm"><tbody>{rows.map(([l, v]) => row(l, v))}</tbody></table>}
        {state && <Note>Can the appliance reach Inaya? {state.controlPlane?.reachable ? "Yes" : "No"} ({state.controlPlane?.host}). {state.controlPlane?.meaning}</Note>}
      </Card>
    </div>
  );
}

export function AuditPanel({ orgId, appliance }) {
  const ev = useLoad(`/api/orgs/nas/appliances/${appliance._id}/evidence?${q(orgId)}`);
  return (
    <Card title="Audit — every consequential NAS action">
      <Note>Each event is written to your organization&rsquo;s existing cryptographic audit chain (no separate NAS audit chain).</Note>
      <Table columns={[{ label: "When", render: (e) => fmtTime(e.createdAt) }, { label: "Action", key: "action" }, { label: "By", render: (e) => e.actor?.email }, { label: "Result", key: "result" }, { label: "Audit chain #", render: (e) => e.auditRef?.seq ?? "-" }]} rows={ev.data?.events || []} />
    </Card>
  );
}

export function EvidencePanel({ orgId, appliance }) {
  const ev = useLoad(`/api/orgs/nas/appliances/${appliance._id}/evidence?${q(orgId)}&verify=1`);
  const comp = useLoad(null);
  const state = useLoad(`/api/orgs/nas/appliances/${appliance._id}/state?${q(orgId)}`);
  const act = useAction(async () => { ev.reload(); state.reload(); });
  const v = ev.data?.verification;
  return (
    <div className="space-y-4">
      <Card title="Evidence verification" right={<Btn small onClick={ev.reload}>Re-verify</Btn>}>
        {v && <div className="space-y-1"><Pill value={v.verified ? "OK" : "CRITICAL"} label={v.verified ? "all evidence verified" : "problem found"} /><Note>{v.rowsChecked} records re-checked against the audit chain (chain {v.auditChain?.valid ? "intact" : "BROKEN"}, {v.auditChain?.entries} entries).</Note>{(v.problems || []).map((p, i) => <Note key={i} tone="bad">{p.action}: {p.problem}</Note>)}</div>}
      </Card>
      <Card title="Cryptographic proof of NAS state" right={<Btn small busy={act.busy} onClick={() => act.run(() => api(`/api/orgs/nas/appliances/${appliance._id}/state`, { method: "POST", body: body(orgId, { commit: true }) }))}>Commit current state</Btn>}>
        {state.data?.committed === false && <Note>{state.data.note}</Note>}
        {state.data?.committed && <><Pill value={state.data.matches ? "OK" : "ATTENTION"} label={state.data.matches ? "matches the last commitment" : "differs from the last commitment"} /><Note>Committed {fmtTime(state.data.committedAt)} · hash {String(state.data.recordedHash).slice(0, 16)}… · recorded in the audit chain: {state.data.recordedInAuditChain ? "yes" : "NO"}</Note>{(state.data.differences || []).map((d, i) => <Note key={i} tone="warn">{d.component}: {d.change}</Note>)}</>}
      </Card>
      <Card title="Compliance evidence package"><Note>Included in the organization&rsquo;s evidence export under &ldquo;nasEvidence&rdquo;. It lists technical controls only; it makes no certification claim.</Note>
        <Btn small onClick={() => act.run(() => api(`/api/orgs/nas/appliances/${appliance._id}/compliance?${q(orgId)}`))}>Preview package</Btn><Result result={act.result?.appliances ? { appliances: act.result.appliances.length, disclaimer: act.result.disclaimer } : null} /><Result result={comp.data} />
      </Card>
    </div>
  );
}

const SCENARIOS = [
  { value: "NAS_APPLIANCE_UNAVAILABLE", label: "What if this NAS goes offline?", entity: "appliance" },
  { value: "NAS_DISK_FAILED", label: "What if a disk in a pool fails?", entity: "pool" },
  { value: "NAS_DATASET_ENCRYPTED", label: "What if this share is encrypted by ransomware?", entity: "share" },
  { value: "NAS_USER_ACCESS_REVOKED", label: "What if this employee loses access?", entity: "user" },
  { value: "NAS_CAPACITY_EXHAUSTED", label: "What if the NAS reaches 95% full?", entity: "appliance" },
];

export function TwinPanel({ orgId, appliance, shares }) {
  const pools = useLoad(`/api/orgs/nas/appliances/${appliance._id}/pools?${q(orgId)}`);
  const users = useLoad(`/api/orgs/nas/users?${q(orgId)}&applianceId=${appliance._id}`);
  const [type, setType] = useState(SCENARIOS[0].value);
  const [entity, setEntity] = useState("");
  const act = useAction();
  const sc = SCENARIOS.find((s) => s.value === type);
  const opts = sc.entity === "appliance" ? [{ value: appliance._id, label: appliance.name }] : sc.entity === "pool" ? (pools.data?.pools || []).map((p) => ({ value: p._id, label: p.name })) : sc.entity === "share" ? shares.map((s) => ({ value: s._id, label: s.shareName })) : (users.data?.nasUsers || []).map((u) => ({ value: u._id, label: u.unixUsername }));
  const r = act.result;
  return (
    <div className="space-y-4">
      <Card title="Digital Twin — What-If (simulation only, nothing on the live NAS changes)">
        <div className="grid gap-2 sm:grid-cols-3">
          <Select label="Scenario" value={type} onChange={(v) => { setType(v); setEntity(""); }} options={SCENARIOS} />
          <Select label={sc.entity} value={entity} onChange={setEntity} options={[{ value: "", label: "Choose…" }, ...opts]} />
          <div className="flex items-end"><Btn busy={act.busy} onClick={() => act.run(() => api("/api/orgs/digital-twin/simulate", { method: "POST", body: body(orgId, { scenarioType: type, entityId: entity || (sc.entity === "appliance" ? appliance._id : ""), params: type === "NAS_CAPACITY_EXHAUSTED" ? { percent: 95 } : {} }) }))}>Simulate</Btn></div>
        </div>
        <Err error={act.error} />
      </Card>
      {r && (
        <Card title={`Result: ${r.scenario?.subject?.name || r.scenario?.type}`}>
          <Note>{r.disclaimer}</Note>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><h4 className="text-xs font-semibold">Current state</h4><pre className="text-xs overflow-auto">{JSON.stringify(r.currentState, null, 1)}</pre></div>
            <div><h4 className="text-xs font-semibold">Simulated state</h4><pre className="text-xs overflow-auto">{JSON.stringify(r.simulatedState, null, 1)}</pre></div>
          </div>
          <h4 className="text-xs font-semibold">Impact</h4><pre className="max-h-64 overflow-auto text-xs">{JSON.stringify(r.directImpact, null, 1)}</pre>
          <h4 className="text-xs font-semibold">Unknowns (not guessed)</h4>
          <ul className="text-xs list-disc pl-4">{(r.unknowns || []).map((u, i) => <li key={i}><b>{u.area}</b>: {u.reason}</li>)}</ul>
        </Card>
      )}
    </div>
  );
}

export function UpdatesPanel({ orgId, appliance }) {
  const info = useLoad(`/api/orgs/nas/appliances/${appliance._id}/updates?${q(orgId)}`);
  const hist = useLoad(`/api/orgs/nas/appliances/${appliance._id}/update-history?${q(orgId)}`);
  const jobs = useLoad(`/api/orgs/nas/appliances/${appliance._id}/jobs?${q(orgId)}`);
  const act = useAction(async () => { info.reload(); hist.reload(); jobs.reload(); });
  const i = info.data;
  return (
    <div className="space-y-4">
      <Card title="Appliance software" right={i && <Pill value={i.updateAvailable ? "ATTENTION" : "OK"} label={i.updateAvailable ? "update available" : "up to date"} />}>
        <Err error={info.error || act.error} />
        {i && <><Note>Installed: {i.current?.version || "unknown"} · Available: {i.available?.version} · Channel: {i.channel}</Note><Note>{i.releaseMetadata?.note}</Note><Note>{i.scope}</Note></>}
        <Btn busy={act.busy} disabled={!i?.updateAvailable} onClick={() => act.run(() => api(`/api/orgs/nas/appliances/${appliance._id}/updates`, { method: "POST", body: body(orgId, {}) }), "Update the appliance agent? A configuration backup is taken first and it rolls back automatically if verification fails.")}>Update now</Btn>
      </Card>
      <Card title="Update history"><Table columns={[{ label: "When", render: (u) => fmtTime(u.createdAt) }, { label: "From → to", render: (u) => `${u.fromVersion || "?"} → ${u.toVersion}` }, { label: "Result", render: (u) => <Pill value={u.state === "COMPLETED" ? "OK" : u.state === "ROLLED_BACK" ? "ATTENTION" : u.state} label={u.state} /> }, { label: "Reason", render: (u) => u.reason || "-" }]} rows={hist.data?.updates || []} /></Card>
      <Card title="Background jobs">
        <Table columns={[{ label: "Kind", key: "kind" }, { label: "State", render: (j) => <Pill value={j.status} /> }, { label: "Attempts", render: (j) => `${j.attempts}/${j.maxAttempts}` }, { label: "Error", render: (j) => j.lastError || "-" }, { label: "", render: (j) => (
          <span className="flex gap-1">
            {["PAUSED", "FAILED", "DEGRADED", "RECOVERY_REQUIRED"].includes(j.status) && <Btn small onClick={() => act.run(() => api(`/api/orgs/nas/jobs/${j._id}`, { method: "POST", body: body(orgId, { action: "resume" }) }))}>Retry</Btn>}
            {["QUEUED", "RETRYING"].includes(j.status) && <Btn small onClick={() => act.run(() => api(`/api/orgs/nas/jobs/${j._id}`, { method: "POST", body: body(orgId, { action: "pause" }) }))}>Pause</Btn>}
            {["QUEUED", "RETRYING", "PAUSED"].includes(j.status) && <Btn small danger onClick={() => act.run(() => api(`/api/orgs/nas/jobs/${j._id}`, { method: "POST", body: body(orgId, { action: "cancel" }) }))}>Cancel</Btn>}
          </span>) }]} rows={jobs.data?.jobs || []} empty="No jobs yet." />
      </Card>
    </div>
  );
}

export function SettingsPanel({ orgId, appliance, shares }) {
  const net = useLoad(`/api/orgs/nas/appliances/${appliance._id}/network?${q(orgId)}`);
  const [host, setHost] = useState("");
  const [shareId, setShareId] = useState("");
  const props = useLoad(shareId ? `/api/orgs/nas/shares/${shareId}/tiering?${q(orgId)}` : null, [shareId]);
  const [tier, setTier] = useState("COLD");
  const [days, setDays] = useState("180");
  const [hold, setHold] = useState("");
  const act = useAction(async () => { net.reload(); props.reload(); });
  const post = (id, payload) => api(`/api/orgs/nas/tiering/${id}`, { method: "POST", body: body(orgId, payload) });
  return (
    <div className="space-y-4">
      <Card title="Network & discovery (MEASURED)">
        {net.data && <Note>Hostname {net.data.hostname} · {net.data.interfaces.flatMap((i) => i.addresses.map((a) => `${i.name} ${a.address}`)).join(" · ")}</Note>}
        {net.data?.discovery && <Note>mDNS: {net.data.discovery.mdns?.active ? `advertising ${net.data.discovery.hostname}` : "off"}. {net.data.discovery.lanVisibilityNote}</Note>}
        <div className="flex items-end gap-2"><Input label="Hostname (optional)" value={host} onChange={setHost} /><Btn onClick={() => act.run(() => api(`/api/orgs/nas/appliances/${appliance._id}/network`, { method: "PUT", body: body(orgId, { hostname: host || undefined, mdns: true }) }))}>Apply & advertise</Btn></div>
      </Card>
      <Card title="Storage tiering (proposals only — nothing moves silently)"><ShareSelect shares={shares} value={shareId} onChange={setShareId} />
        {shareId && (
          <>
            <div className="grid gap-2 sm:grid-cols-4">
              <Select label="Tier" value={tier} onChange={setTier} options={["WARM", "COLD"]} />
              <Input label="Files older than (days)" value={days} onChange={setDays} type="number" />
              <Input label="Legal hold folders (never moved)" value={hold} onChange={setHold} placeholder="Legal,Contracts" />
              <div className="flex items-end gap-1"><Btn small onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/tiering`, { method: "PUT", body: body(orgId, { rules: [{ tier, olderThanDays: Number(days) }], legalHoldPaths: hold.split(",").map((x) => x.trim()).filter(Boolean) }) }))}>Save policy</Btn><Btn small onClick={() => act.run(() => api(`/api/orgs/nas/shares/${shareId}/tiering`, { method: "POST", body: body(orgId, {}) }))}>Propose</Btn></div>
            </div>
            <Table columns={[{ label: "Tier", key: "tier" }, { label: "Files", render: (p) => p.files?.length ?? "-" }, { label: "Size", render: (p) => fmtBytes(p.totalBytes) }, { label: "State", render: (p) => <Pill value={p.state === "APPLIED" ? "OK" : p.state} label={p.state} /> }, { label: "Proposed by", key: "proposedBy" }, { label: "", render: (p) => (
              <span className="flex gap-1">
                {p.state === "PROPOSED" && <Btn small onClick={() => act.run(() => post(p._id, { action: "approve" }))}>Approve (not the proposer)</Btn>}
                {p.state === "APPROVED" && <Btn small onClick={() => act.run(() => post(p._id, { action: "apply" }), "Copy to Inaya, verify, then replace local files with stubs?")}>Apply</Btn>}
                {["APPLIED", "APPLIED_WITH_ERRORS"].includes(p.state) && <Btn small onClick={() => act.run(() => post(p._id, { action: "recall" }))}>Recall (reverse)</Btn>}
              </span>) }]} rows={props.data?.proposals || []} empty="No proposals." />
            <Note>A proposal must be approved by a different manager. The copy in Inaya is verified before any local file is replaced; recall restores identical bytes.</Note>
          </>
        )}
        <Err error={act.error} /><Result result={act.result} />
      </Card>
      <Card title="Deployment profile & limits">
        <ul className="text-xs list-disc pl-4 space-y-1">
          <li>Profile: Linux appliance (Samba 4.23, nfsd, mdadm RAID1, Btrfs, ext4 quotas) reached through this host&rsquo;s WSL2 distro. A physical appliance would run the same agent.</li>
          <li>Physical disk health, UPS, temperature and multi-host replication are not available on this profile and are shown as UNKNOWN / not claimed.</li>
          <li>The control plane must run where it can reach the appliance; the hosted website cannot reach a NAS behind a customer network.</li>
          <li>This is not a compliance certification; no HIPAA, ISO, SOC or FedRAMP claim is made.</li>
        </ul>
      </Card>
    </div>
  );
}
