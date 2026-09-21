"use client";

// src/components/business/DirectSyncView.js
//
// Modular Enterprise Adoption Features SOW, Feature 1 -- Inaya DirectSync.
// All real logic (folder watching, hashing, the local SQLite queue, the
// upload/verify path) lives natively in inaya-desktop's Rust backend
// (src-tauri/src/directsync.rs) -- this view is a thin control surface
// that calls those Tauri commands via window.__TAURI__.core.invoke(),
// the exact same pattern the existing passkey/Drive-mount commands
// already use (see lib.rs's injected poller scripts for the precedent).
// DirectSync is a native desktop capability with no meaningful web-only
// equivalent (there is no folder to watch inside a browser tab), so this
// view degrades to an honest "requires the desktop app" message rather
// than pretending to offer folder sync from a browser.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

function isDesktop() {
  return typeof window !== "undefined" && !!window.__TAURI__;
}

async function invoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

const STATE_STYLES = {
  DONE: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  QUEUED: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  UPLOADING: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  FAILED: "bg-red-400/10 text-red-400 border-red-400/30",
  LOCALLY_DELETED: "border-white/10 text-[var(--inaya-text-muted)]",
};

function CredentialPanel({ configured, onChanged }) {
  const [endpoint, setEndpoint] = useState(typeof window !== "undefined" ? `${window.location.origin}/api/s3` : "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await invoke("directsync_store_credential", { endpoint: endpoint.trim(), accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() });
      setAccessKeyId("");
      setSecretAccessKey("");
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError("");
    try {
      await invoke("directsync_clear_credential");
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (configured) {
    return (
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-2">
        <p className="text-[var(--inaya-text-primary)] font-bold text-sm">Destination</p>
        <p className="text-[var(--inaya-text-muted)] text-xs">An S3-compatible credential is configured. DirectSync uploads through the same S3-compatible API Inaya Drive and every other S3 client already use.</p>
        <button onClick={clear} disabled={busy} className="text-[10px] font-bold uppercase text-red-400 disabled:opacity-40">Revoke credential &amp; stop all watchers</button>
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>
    );
  }

  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-3">
      <div>
        <p className="text-[var(--inaya-text-primary)] font-bold text-sm">Destination Setup</p>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">
          Generate an S3-compatible credential from <span className="text-[var(--inaya-text-primary)]">S3-Compatible Storage</span> in this workspace, then paste it here once — the secret is only ever shown once at creation, the same as everywhere else it's issued.
        </p>
      </div>
      <form onSubmit={save} className="flex flex-wrap items-center gap-2">
        <input placeholder="Endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] flex-1 min-w-[220px]" />
        <input placeholder="Access Key ID" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input type="password" placeholder="Secret Access Key" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button type="submit" disabled={busy || !endpoint.trim() || !accessKeyId.trim() || !secretAccessKey.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}

function FolderRow({ folder, onChanged }) {
  const [queue, setQueue] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadQueue = useCallback(async () => {
    try {
      setQueue(await invoke("directsync_list_queue", { folderId: folder.id }));
    } catch (err) {
      setError(String(err));
    }
  }, [folder.id]);

  useEffect(() => {
    if (expanded) loadQueue();
  }, [expanded, loadQueue]);

  async function togglePause() {
    setBusy(true);
    setError("");
    try {
      await invoke(folder.enabled ? "directsync_pause_folder" : "directsync_resume_folder", { folderId: folder.id });
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await invoke("directsync_remove_folder", { folderId: folder.id });
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    setBusy(true);
    setError("");
    try {
      await invoke("directsync_retry_failed", { folderId: folder.id });
      loadQueue();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const failedCount = queue ? queue.filter((q) => q.state === "FAILED").length : 0;

  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-[var(--inaya-text-primary)] font-bold truncate">{folder.local_path}</p>
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full border shrink-0 ${folder.enabled ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>
              {folder.enabled ? "WATCHING" : "PAUSED"}
            </span>
          </div>
          <p className="text-[11px] text-[var(--inaya-text-muted)] font-mono truncate">→ {folder.bucket}{folder.prefix ? `/${folder.prefix}` : ""}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={togglePause} disabled={busy} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40">{folder.enabled ? "Pause" : "Resume"}</button>
          <button onClick={remove} disabled={busy} className="text-[10px] font-bold uppercase text-red-400 disabled:opacity-40">Remove</button>
          <button onClick={() => setExpanded((v) => !v)} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">{expanded ? "Hide" : "Queue"}</button>
        </div>
      </div>
      {error && <p className="text-red-400 text-[11px]">{error}</p>}
      {expanded && (
        <div className="space-y-1">
          {failedCount > 0 && (
            <button onClick={retryFailed} disabled={busy} className="text-[10px] font-bold uppercase px-2 py-1 rounded-md bg-red-400/10 text-red-400 border border-red-400/30 disabled:opacity-40">
              Retry {failedCount} failed file(s)
            </button>
          )}
          {!queue ? (
            <p className="text-[var(--inaya-text-muted)] font-mono text-xs">Loading…</p>
          ) : queue.length === 0 ? (
            <p className="text-[var(--inaya-text-muted)] text-[11px]">No files tracked yet.</p>
          ) : (
            queue.slice(0, 50).map((q) => (
              <div key={q.id} className="bg-black/30 border border-white/10 rounded-md p-2 text-[11px] font-mono flex items-center justify-between gap-2">
                <span className="text-[var(--inaya-text-muted)] truncate">{q.local_path.split(/[\\/]/).pop()}</span>
                {q.state === "FAILED" && q.last_error && <span className="text-red-400 truncate flex-1 text-[10px]">{q.last_error}</span>}
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full border shrink-0 ${STATE_STYLES[q.state] || "border-white/10 text-[var(--inaya-text-muted)]"}`}>{q.state}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function AddFolderForm({ configured, onChanged }) {
  const [localPath, setLocalPath] = useState("");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function choose() {
    setError("");
    try {
      const picked = await invoke("directsync_pick_folder");
      if (picked) setLocalPath(picked);
    } catch (err) {
      setError(String(err));
    }
  }

  async function add(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await invoke("directsync_add_folder", { localPath: localPath.trim(), bucket: bucket.trim(), prefix: prefix.trim() });
      setLocalPath(""); setBucket(""); setPrefix("");
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!configured) {
    return <p className="text-[var(--inaya-text-muted)] text-[11px]">Configure a destination above before adding a folder to watch.</p>;
  }

  return (
    <form onSubmit={add} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={choose} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30">Choose Folder…</button>
        <span className="text-[11px] text-[var(--inaya-text-muted)] font-mono truncate max-w-[260px]">{localPath || "No folder selected"}</span>
        <input placeholder="Destination bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input placeholder="Prefix (optional)" value={prefix} onChange={(e) => setPrefix(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button type="submit" disabled={busy || !localPath || !bucket.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">
          {busy ? "Adding…" : "Start Watching"}
        </button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </form>
  );
}

export default function DirectSyncView() {
  const [configured, setConfigured] = useState(null);
  const [folders, setFolders] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [conf, list] = await Promise.all([invoke("directsync_credential_configured"), invoke("directsync_list_folders")]);
      setConfigured(conf);
      setFolders(list);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => { if (isDesktop()) load(); }, [load]);

  if (!isDesktop()) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">DirectSync</h3>
          <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">Automatic local-folder backup into Inaya.</p>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
          <EmptyState compact icon="🖥️" description="DirectSync watches a real folder on your computer, so it only runs inside the Inaya Desktop app, not a browser tab." />
          <a href="/business/download" className="mt-3 inline-flex items-center gap-2 text-[11px] font-bold uppercase text-[#00f2fe]">Get the Desktop App (Windows / Linux) →</a>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">DirectSync</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">
          Watches local folders on this computer and automatically, incrementally backs up changes into Inaya — duplicate-safe, resumable, and running in the background as long as this app is open.
        </p>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}

      {configured === null || folders === null ? (
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
      ) : (
        <>
          <CredentialPanel configured={configured} onChanged={load} />

          <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-4">
            <p className="text-[var(--inaya-text-primary)] font-bold text-sm">Watched Folders</p>
            {folders.length === 0 ? (
              <EmptyState compact icon="📁" description="No folders are being watched yet." />
            ) : (
              <div className="space-y-1.5">
                {folders.map((f) => <FolderRow key={f.id} folder={f} onChanged={load} />)}
              </div>
            )}
            <div className="border-t border-white/5 pt-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-2">Add a folder</p>
              <AddFolderForm configured={configured} onChanged={load} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
