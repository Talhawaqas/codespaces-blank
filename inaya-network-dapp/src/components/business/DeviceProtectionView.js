"use client";

// src/components/business/DeviceProtectionView.js
//
// Internxt-inspired SOW, Workstream D (Computer Backup reconciliation), §5.4: "The UI MUST NOT
// expose separate confusing modules... Instead use one logical product surface such as `Device
// Protection` with clearly separated capabilities: Backup; Sync; Cleaner; Device status."
//
// This is a UI consolidation only -- a tabbed shell around the four existing, independently-built
// views (DevicesView, EndpointBackupView, DirectSyncView, CleanerView). None of their logic moves
// here: no new collection, no new API route, no new backup/sync/device engine. Reconciling four
// scattered sidebar entries into one surface is the entire scope of this file, per §5.1's rule that
// this workstream may only audit, reconcile UX, and close genuinely missing behavior -- never
// duplicate an existing subsystem.
import { useState } from "react";
import DevicesView from "./endpoint/DevicesView";
import EndpointBackupView from "./endpoint/EndpointBackupView";
import DirectSyncView from "./DirectSyncView";
import CleanerView from "./CleanerView";

const TABS = [
  { key: "backup", label: "Backup" },
  { key: "sync", label: "Sync" },
  { key: "cleaner", label: "Cleaner" },
  { key: "devices", label: "Device status" },
];

export default function DeviceProtectionView({ orgId, canManage, deviceAdmin, storageAdmin }) {
  const [tab, setTab] = useState("backup");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-white/5 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wide whitespace-nowrap border-b-2 transition-colors ${
              tab === t.key
                ? "text-[#00f2fe] border-[#00f2fe]"
                : "text-[var(--inaya-text-muted)] border-transparent hover:text-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "backup" && <EndpointBackupView orgId={orgId} canManage={storageAdmin} />}
      {tab === "sync" && <DirectSyncView />}
      {tab === "cleaner" && <CleanerView orgId={orgId} />}
      {tab === "devices" && <DevicesView orgId={orgId} canManage={deviceAdmin} />}
    </div>
  );
}
