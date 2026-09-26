"use client";

// src/components/business/NasManagementView.js
//
// Sovereign NAS SOW, Workstream T: the NAS management console. All 18 sections
// the SOW lists -- Overview, Storage, Disks, Pools, Shares, Users & Groups,
// Permissions, Snapshots, Backup, Replication, Cloud Targets, Security,
// Hardware Health, Audit, Evidence, Digital Twin, Updates, Settings -- as a
// focused console (not a second Business Workspace). Every panel calls real API
// routes that drive the real appliance; nothing is simulated in the browser.

import { useState } from "react";
import EmptyState from "../EmptyState";
import { api, useLoad, useAction, Card, Note, Err, Btn, Input, Select, Pill } from "./nas/ui";
import { OverviewPanel, StoragePanel, DisksPanel, PoolsPanel, SharesPanel, UsersPanel, PermissionsPanel } from "./nas/panels1";
import { SnapshotsPanel, BackupPanel, ReplicationPanel, CloudTargetsPanel, SecurityPanel, HealthPanel, AuditPanel, EvidencePanel, TwinPanel, UpdatesPanel, SettingsPanel } from "./nas/panels2";

const SECTIONS = [
  ["overview", "Overview"], ["storage", "Storage"], ["disks", "Disks"], ["pools", "Pools"], ["shares", "Shares"], ["users", "Users & Groups"],
  ["permissions", "Permissions"], ["snapshots", "Snapshots"], ["backup", "Backup"], ["replication", "Replication"], ["cloud", "Cloud Targets"],
  ["security", "Security"], ["health", "Hardware Health"], ["audit", "Audit"], ["evidence", "Evidence"], ["twin", "Digital Twin"], ["updates", "Updates"], ["settings", "Settings"],
];

function RegisterApplianceForm({ orgId, onChanged }) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const act = useAction(onChanged);
  return (
    <Card title="Register a NAS appliance">
      <div className="grid gap-2 sm:grid-cols-3">
        <Input id="nas-app-name" label="Name" value={name} onChange={setName} />
        <Input id="nas-app-host" label="Host / IP (e.g. 172.21.35.48)" value={host} onChange={setHost} />
        <div className="flex items-end"><Btn busy={act.busy} onClick={() => act.run(() => api("/api/orgs/nas/appliances", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), backend: "wsl-local", host: host.trim() }) }))}>Register &amp; check health</Btn></div>
      </div>
      <Err error={act.error} />
      <Note>Only the wsl-local profile (Linux appliance reached through WSL2) is real and tested. A physical appliance runs the same agent behind an authenticated local API.</Note>
    </Card>
  );
}

function Console({ orgId, appliance }) {
  const [section, setSection] = useState("overview");
  const shares = useLoad(`/api/orgs/nas/shares?orgId=${encodeURIComponent(orgId)}&applianceId=${appliance._id}`);
  const props = { orgId, appliance, shares: shares.data?.shares || [], reloadShares: shares.reload };
  const panels = {
    overview: <OverviewPanel {...props} />, storage: <StoragePanel {...props} />, disks: <DisksPanel {...props} />, pools: <PoolsPanel {...props} />, shares: <SharesPanel {...props} />,
    users: <UsersPanel {...props} />, permissions: <PermissionsPanel {...props} />, snapshots: <SnapshotsPanel {...props} />, backup: <BackupPanel {...props} />, replication: <ReplicationPanel {...props} />,
    cloud: <CloudTargetsPanel {...props} />, security: <SecurityPanel {...props} />, health: <HealthPanel {...props} />, audit: <AuditPanel {...props} />, evidence: <EvidencePanel {...props} />,
    twin: <TwinPanel {...props} />, updates: <UpdatesPanel {...props} />, settings: <SettingsPanel {...props} />,
  };
  return (
    <div className="space-y-4">
      <nav aria-label="NAS sections" className="flex flex-wrap gap-1">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setSection(id)} aria-current={section === id ? "page" : undefined}
            className={`rounded border px-3 py-1.5 text-xs font-medium ${section === id ? "border-[var(--inaya-accent)] text-[var(--inaya-accent)]" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{label}</button>
        ))}
      </nav>
      <Err error={shares.error} />
      {panels[section]}
    </div>
  );
}

export default function NasManagementView({ orgId }) {
  const apps = useLoad(`/api/orgs/nas/appliances?orgId=${encodeURIComponent(orgId)}`);
  const [selected, setSelected] = useState("");
  const list = apps.data?.appliances || [];
  const appliance = list.find((a) => a._id === selected) || list[0];
  if (apps.data === null && !apps.error) return <div className="text-sm text-[var(--inaya-text-muted)]">Loading…</div>;
  return (
    <div className="space-y-6">
      <Err error={apps.error} />
      {list.length === 0 ? (
        <>
          <RegisterApplianceForm orgId={orgId} onChanged={apps.reload} />
          <EmptyState title="No NAS appliances registered" description="Register your first appliance to create real SMB/NFS shares with snapshots, backup, replication and evidence." />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64"><Select id="nas-appliance-select" label="Appliance" value={appliance?._id || ""} onChange={setSelected} options={list.map((a) => ({ value: a._id, label: a.name }))} /></div>
            <Pill value={appliance?.status} />
            <Note>{appliance?.host} · {appliance?.backend}</Note>
          </div>
          {appliance && <Console key={appliance._id} orgId={orgId} appliance={appliance} />}
          <details><summary className="cursor-pointer text-xs text-[var(--inaya-text-muted)]">Register another appliance</summary><div className="mt-2"><RegisterApplianceForm orgId={orgId} onChanged={apps.reload} /></div></details>
        </>
      )}
    </div>
  );
}
