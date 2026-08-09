"use client";

// app/business/page.js
//
// Business Records Management — Company -> Department -> Project ->
// Document, backed by /api/orgs/*. Deliberately a SEPARATE page from the
// main wallet-connected dApp (page.js): this feature's identity model is
// email + session cookie, not a wallet address, and mixing the two auth
// paradigms into one nav would be confusing for what's really a different
// product surface (a business/SaaS document system) that happens to reuse
// the same encrypt/shard/pin/on-chain-hash storage pipeline underneath.
//
// Document encryption/pinning intentionally duplicates the two small pure
// functions page.js already has (encryptData, and a wrapper around
// /api/upload) rather than importing from page.js — there's nothing to
// import from (they're closures inside that component, not an exported
// module), and encryptData is pure Web Crypto with no dependency on any
// wallet state, so duplicating ~15 lines here is lower-risk than
// refactoring the already-shipped upload flow just to share it.

import { useState, useEffect, useCallback } from "react";

const ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" };

// ============================================================
// Client-side crypto + pinning — see module comment above.
// ============================================================
async function encryptData(text, password) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encrypted), salt.length + iv.length);
  let binary = "";
  for (let i = 0; i < combined.byteLength; i++) binary += String.fromCharCode(combined[i]);
  return window.btoa(binary);
}

async function decryptData(base64Str, password) {
  const binaryStr = window.atob(base64Str);
  const combined = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) combined[i] = binaryStr.charCodeAt(i);
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const encrypted = combined.slice(28);
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}

// Same two-gateway fallback the wallet-connected flow uses (page.js) —
// Cloudflare's IPFS gateway first, Pinata's as a fallback.
async function fetchShardFromIPFS(cid) {
  try {
    const res = await fetch(`https://cloudflare-ipfs.com/ipfs/${cid}`);
    const json = await res.json();
    return json.shard;
  } catch {
    const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
    const json = await res.json();
    return json.shard;
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadShardToPinata(encryptedShard, filename, elementTag) {
  // No walletAddress/selectedTier passed — /api/upload skips its billing-
  // tier logic entirely when walletAddress is absent, so this is a clean,
  // unmodified reuse of the existing pinning route.
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptedShard, filename, elementTag }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || data.pinata || "IPFS pinning failed.");
  return data.IpfsHash;
}

async function sha256Hex(text) {
  const enc = new TextEncoder();
  const digest = await window.crypto.subtle.digest("SHA-256", enc.encode(text));
  return "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function BusinessPage() {
  const [sessionLoading, setSessionLoading] = useState(true);
  const [session, setSession] = useState(null); // { email, orgs: [{orgId, orgName, role, departmentIds}] }
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [notice, setNotice] = useState("");

  const refreshSession = useCallback(async () => {
    try {
      const res = await fetch("/api/orgs/session");
      if (res.status === 401) {
        setSession(null);
        return;
      }
      const data = await res.json();
      setSession(data);
      setSelectedOrgId((prev) => prev || data.orgs?.[0]?.orgId || null);
    } catch {
      setSession(null);
    } finally {
      setSessionLoading(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("orgLoggedIn")) setNotice("Signed in.");
    if (params.get("orgLoginError")) setNotice("That sign-in link is invalid or has expired — request a new one below.");
    if (params.get("orgLoggedIn") || params.get("orgLoginError")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    refreshSession();
  }, [refreshSession]);

  async function handleLogout() {
    await api("/api/orgs/logout", { method: "POST" });
    setSession(null);
    setSelectedOrgId(null);
  }

  if (sessionLoading) {
    return <Shell><p className="text-[#64748b] font-mono text-sm">Loading…</p></Shell>;
  }

  if (!session?.authenticated) {
    return (
      <Shell>
        <AuthScreen notice={notice} onAuthed={refreshSession} />
      </Shell>
    );
  }

  const currentMembership = session.orgs.find((o) => o.orgId === selectedOrgId) || session.orgs[0];

  return (
    <Shell>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight">Business Records</h1>
          <p className="text-[#64748b] text-xs font-mono mt-1">{session.email}</p>
        </div>
        <div className="flex items-center gap-3">
          {session.orgs.length > 1 && (
            <select
              value={selectedOrgId || ""}
              onChange={(e) => setSelectedOrgId(e.target.value)}
              className="bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
            >
              {session.orgs.map((o) => (
                <option key={o.orgId} value={o.orgId}>{o.orgName}</option>
              ))}
            </select>
          )}
          <button onClick={handleLogout} className="text-xs font-bold uppercase bg-white/5 border border-white/10 px-3 py-2 rounded-lg text-slate-300 hover:bg-white/10">
            Sign out
          </button>
        </div>
      </div>

      {currentMembership && <OrgWorkspace key={currentMembership.orgId} membership={currentMembership} />}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-6xl mx-auto">{children}</div>
    </div>
  );
}

// ============================================================
// AUTH SCREEN
// ============================================================
function AuthScreen({ notice, onAuthed }) {
  const [mode, setMode] = useState("signin"); // 'signin' | 'create'
  const [email, setEmail] = useState("");
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [fallbackUrl, setFallbackUrl] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setMessage("");
    setFallbackUrl("");
    try {
      if (mode === "create") {
        const data = await api("/api/orgs/create", { method: "POST", body: JSON.stringify({ orgName, ownerEmail: email }) });
        setMessage(data.emailSent ? "Company created — check your email for a sign-in link." : "Company created.");
        if (data.loginUrl) setFallbackUrl(data.loginUrl);
      } else {
        const data = await api("/api/orgs/login/request", { method: "POST", body: JSON.stringify({ email }) });
        setMessage("If that email has an account, a sign-in link is on its way — check your inbox.");
        if (data.loginUrl) setFallbackUrl(data.loginUrl);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-md mx-auto mt-16">
      <h1 className="text-2xl font-extrabold text-white text-center mb-1">Business Records</h1>
      <p className="text-[#64748b] text-sm text-center mb-8">Encrypted document management for your company, built on Inaya's storage infrastructure.</p>

      {notice && <div className="bg-amber-400/10 border border-amber-400/20 text-amber-300 text-xs rounded-lg p-3 mb-4">{notice}</div>}

      <div className="flex bg-[#090d16] border border-white/5 rounded-xl p-1 mb-6">
        <button onClick={() => setMode("signin")} className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg ${mode === "signin" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[#64748b]"}`}>Sign in</button>
        <button onClick={() => setMode("create")} className={`flex-1 py-2 text-xs font-bold uppercase rounded-lg ${mode === "create" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[#64748b]"}`}>Create a company</button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {mode === "create" && (
          <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required placeholder="Company name" className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#475569]" />
        )}
        <input value={email} onChange={(e) => setEmail(e.target.value)} required type="email" placeholder="you@company.com" className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#475569]" />
        <button disabled={submitting} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
          {submitting ? "Working…" : mode === "create" ? "Create company" : "Send sign-in link"}
        </button>
      </form>

      {error && <p className="text-red-400 text-xs mt-4">{error}</p>}
      {message && <p className="text-emerald-400 text-xs mt-4">{message}</p>}
      {fallbackUrl && (
        <div className="mt-3 bg-black/20 border border-white/10 rounded-xl p-4">
          <p className="text-slate-400 text-xs mb-2">Email delivery isn't fully set up yet — use this link directly:</p>
          <a href={fallbackUrl} className="text-[#00f2fe] underline text-xs break-all">{fallbackUrl}</a>
        </div>
      )}
    </div>
  );
}

// ============================================================
// ORG WORKSPACE (departments -> projects -> documents, + team management)
// ============================================================
function OrgWorkspace({ membership }) {
  const { orgId, role, departmentIds } = membership;
  const canManage = role === "owner" || role === "admin";

  const [view, setView] = useState("documents"); // 'documents' | 'team'
  const [departments, setDepartments] = useState([]);
  const [selectedDeptId, setSelectedDeptId] = useState(null);
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [error, setError] = useState("");

  const loadDepartments = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/departments?orgId=${orgId}`);
      setDepartments(data.departments);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { loadDepartments(); }, [loadDepartments]);

  const loadProjects = useCallback(async (deptId) => {
    try {
      const data = await api(`/api/orgs/projects?orgId=${orgId}&departmentId=${deptId}`);
      setProjects(data.projects);
    } catch (err) {
      setError(err.message);
      setProjects([]);
    }
  }, [orgId]);

  useEffect(() => {
    setSelectedProjectId(null);
    setDocuments([]);
    if (selectedDeptId) loadProjects(selectedDeptId);
  }, [selectedDeptId, loadProjects]);

  const loadDocuments = useCallback(async (deptId, projectId) => {
    try {
      const data = await api(`/api/orgs/documents?orgId=${orgId}&departmentId=${deptId}&projectId=${projectId}`);
      setDocuments(data.documents);
    } catch (err) {
      setError(err.message);
      setDocuments([]);
    }
  }, [orgId]);

  useEffect(() => {
    if (selectedDeptId && selectedProjectId) loadDocuments(selectedDeptId, selectedProjectId);
  }, [selectedDeptId, selectedProjectId, loadDocuments]);

  const visibleDepartments = canManage ? departments : departments.filter((d) => departmentIds.includes(d.id));

  return (
    <div>
      <div className="flex gap-2 mb-6">
        <button onClick={() => setView("documents")} className={`text-xs font-bold uppercase px-4 py-2 rounded-lg ${view === "documents" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[#64748b] bg-white/5"}`}>Documents</button>
        {canManage && (
          <button onClick={() => setView("team")} className={`text-xs font-bold uppercase px-4 py-2 rounded-lg ${view === "team" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[#64748b] bg-white/5"}`}>Team</button>
        )}
      </div>

      {error && <p className="text-red-400 text-xs mb-4">{error}</p>}

      {view === "team" ? (
        <TeamView orgId={orgId} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <DepartmentColumn
            orgId={orgId}
            departments={visibleDepartments}
            selectedDeptId={selectedDeptId}
            onSelect={setSelectedDeptId}
            canManage={canManage}
            onCreated={loadDepartments}
          />
          {selectedDeptId && (
            <ProjectColumn
              orgId={orgId}
              departmentId={selectedDeptId}
              projects={projects}
              selectedProjectId={selectedProjectId}
              onSelect={setSelectedProjectId}
              canManage={canManage}
              onCreated={() => loadProjects(selectedDeptId)}
            />
          )}
          {selectedProjectId && (
            <DocumentColumn
              orgId={orgId}
              departmentId={selectedDeptId}
              projectId={selectedProjectId}
              documents={documents}
              canManage={canManage}
              onUploaded={() => loadDocuments(selectedDeptId, selectedProjectId)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Column({ title, children, action }) {
  return (
    <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#64748b]">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function DepartmentColumn({ orgId, departments, selectedDeptId, onSelect, canManage, onCreated }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    try {
      await api("/api/orgs/departments", { method: "POST", body: JSON.stringify({ orgId, name }) });
      setName("");
      setCreating(false);
      onCreated();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Column title="Departments" action={canManage && <button onClick={() => setCreating((v) => !v)} className="text-[10px] font-bold text-[#00f2fe]">+ New</button>}>
      {creating && (
        <form onSubmit={handleCreate} className="mb-3 flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Finance" autoFocus className="flex-1 bg-black/30 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white" />
          <button className="text-[10px] font-bold text-[#00f2fe] bg-[#00f2fe]/10 px-2 rounded-lg">Add</button>
        </form>
      )}
      {error && <p className="text-red-400 text-[10px] mb-2">{error}</p>}
      {departments.length === 0 ? (
        <p className="text-[#475569] text-xs italic">No departments yet.</p>
      ) : (
        <div className="space-y-1">
          {departments.map((d) => (
            <button key={d.id} onClick={() => onSelect(d.id)} className={`w-full text-left px-3 py-2 rounded-lg text-sm ${selectedDeptId === d.id ? "bg-[#00f2fe]/10 text-[#00f2fe]" : "text-slate-300 hover:bg-white/5"}`}>
              {d.name}
            </button>
          ))}
        </div>
      )}
    </Column>
  );
}

function ProjectColumn({ orgId, departmentId, projects, selectedProjectId, onSelect, canManage, onCreated }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    try {
      await api("/api/orgs/projects", { method: "POST", body: JSON.stringify({ orgId, departmentId, name }) });
      setName("");
      setCreating(false);
      onCreated();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Column title="Projects" action={canManage && <button onClick={() => setCreating((v) => !v)} className="text-[10px] font-bold text-[#00f2fe]">+ New</button>}>
      {creating && (
        <form onSubmit={handleCreate} className="mb-3 flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 Audit" autoFocus className="flex-1 bg-black/30 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white" />
          <button className="text-[10px] font-bold text-[#00f2fe] bg-[#00f2fe]/10 px-2 rounded-lg">Add</button>
        </form>
      )}
      {error && <p className="text-red-400 text-[10px] mb-2">{error}</p>}
      {projects.length === 0 ? (
        <p className="text-[#475569] text-xs italic">No projects yet.</p>
      ) : (
        <div className="space-y-1">
          {projects.map((p) => (
            <button key={p.id} onClick={() => onSelect(p.id)} className={`w-full text-left px-3 py-2 rounded-lg text-sm ${selectedProjectId === p.id ? "bg-[#00f2fe]/10 text-[#00f2fe]" : "text-slate-300 hover:bg-white/5"}`}>
              {p.name}
            </button>
          ))}
        </div>
      )}
    </Column>
  );
}

// Phase 2 — workflow status display + transition actions. Every action
// button just calls POST /api/orgs/documents/:id/transition; all the real
// enforcement (role, current state, org/department scoping) happens
// server-side in src/lib/document-workflow.js — these buttons are shown/
// hidden for UX clarity only, not as the actual access control.
const STATUS_STYLES = {
  DRAFT: "bg-white/5 text-[#94a3b8] border-white/10",
  PENDING: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  UNDER_REVIEW: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  APPROVED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  REJECTED: "bg-red-400/10 text-red-400 border-red-400/30",
  ARCHIVED: "bg-violet-400/10 text-violet-300 border-violet-400/30",
};

// [action, label, whoCanSeeIt] — "member" means visible to anyone with
// department access, "manage" means owner/admin only (matches
// TRANSITIONS' requiresManage in document-workflow.js exactly).
const ACTIONS_BY_STATUS = {
  DRAFT: [["submit", "Submit for review", "member"]],
  PENDING: [["startReview", "Start review", "manage"]],
  UNDER_REVIEW: [["approve", "Approve", "manage"], ["reject", "Reject", "manage"]],
  REJECTED: [["revise", "Revise", "member"]],
  APPROVED: [["archive", "Archive", "manage"]],
  ARCHIVED: [["restore", "Restore", "manage"]],
};

const ACCESS_LEVEL_HINTS = {
  PRIVATE: "Only you and people you explicitly grant access to",
  DEPARTMENT: "Anyone in this department",
  PROJECT: "Anyone added to this project",
};

function DocumentColumn({ orgId, departmentId, projectId, documents, canManage, onUploaded }) {
  const [file, setFile] = useState(null);
  const [passkey, setPasskey] = useState("");
  const [accessLevel, setAccessLevel] = useState("DEPARTMENT");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  async function handleUpload(e) {
    e.preventDefault();
    if (!file || !passkey) return;
    setUploading(true);
    setError("");
    try {
      const dataUrl = await readFileAsDataURL(file);
      const cipherText = await encryptData(dataUrl, passkey);
      const fileHash = await sha256Hex(cipherText);
      const midpoint = Math.ceil(cipherText.length / 2);

      const [cidAlpha, cidBeta] = await Promise.all([
        uploadShardToPinata(cipherText.slice(0, midpoint), file.name, "Alpha"),
        uploadShardToPinata(cipherText.slice(midpoint), file.name, "Beta"),
      ]);

      await api("/api/orgs/documents", {
        method: "POST",
        body: JSON.stringify({ orgId, departmentId, projectId, filename: file.name, fileHash, sizeBytes: file.size, cidAlpha, cidBeta, accessLevel }),
      });

      setFile(null);
      setPasskey("");
      onUploaded();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Column title="Documents">
      <form onSubmit={handleUpload} className="mb-4 space-y-2">
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} className="w-full text-[10px] text-slate-400 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-[10px] file:font-bold file:bg-[#00f2fe]/10 file:text-[#00f2fe]" />
        <input type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} placeholder="Encryption passkey" className="w-full bg-black/30 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white" />
        <select value={accessLevel} onChange={(e) => setAccessLevel(e.target.value)} className="w-full bg-black/30 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white">
          <option value="PRIVATE">Private</option>
          <option value="DEPARTMENT">Department</option>
          <option value="PROJECT">Project</option>
        </select>
        <p className="text-[9px] text-[#64748b]">{ACCESS_LEVEL_HINTS[accessLevel]}</p>
        <button disabled={uploading || !file || !passkey} className="w-full text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] py-2 rounded-lg disabled:opacity-40">
          {uploading ? "Encrypting & uploading…" : "Upload document"}
        </button>
      </form>
      {error && <p className="text-red-400 text-[10px] mb-2">{error}</p>}
      {documents.length === 0 ? (
        <p className="text-[#475569] text-xs italic">No documents yet.</p>
      ) : (
        <div className="space-y-2">
          {documents.map((d) => (
            <DocumentCard key={d.id} doc={d} orgId={orgId} canManage={canManage} onChanged={onUploaded} />
          ))}
        </div>
      )}
    </Column>
  );
}

function DocumentCard({ doc, orgId, canManage, onChanged }) {
  const [acting, setActing] = useState("");
  const [error, setError] = useState("");
  const [showActivity, setShowActivity] = useState(false);
  const [activity, setActivity] = useState(null);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [showDownload, setShowDownload] = useState(false);
  const [downloadPasskey, setDownloadPasskey] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [showPermissions, setShowPermissions] = useState(false);
  const [showShare, setShowShare] = useState(false);

  const availableActions = (ACTIONS_BY_STATUS[doc.status] || []).filter(([, , who]) => who === "member" || canManage);
  const canManageThisDoc = canManage || doc.yourAccessLevel === "MANAGE";

  async function loadActivity() {
    setLoadingActivity(true);
    try {
      const data = await api(`/api/orgs/documents/${doc.id}/activity?orgId=${orgId}`);
      setActivity(data.activity);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingActivity(false);
    }
  }

  async function handleAction(action) {
    setActing(action);
    setError("");
    try {
      await api(`/api/orgs/documents/${doc.id}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      onChanged();
      // The history panel, if open, would otherwise keep showing the
      // pre-transition snapshot — refetch so a new action's entry shows up
      // immediately instead of only after closing and reopening it.
      if (showActivity) loadActivity();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  function toggleActivity() {
    if (showActivity) {
      setShowActivity(false);
      return;
    }
    setShowActivity(true);
    loadActivity();
  }

  async function handleDownload() {
    if (!downloadPasskey) return;
    setDownloading(true);
    setError("");
    try {
      const info = await api(`/api/orgs/documents/${doc.id}/retrieve?orgId=${orgId}`);
      const [shardA, shardB] = await Promise.all([fetchShardFromIPFS(info.cidAlpha), fetchShardFromIPFS(info.cidBeta)]);
      const dataUrl = await decryptData(shardA + shardB, downloadPasskey);
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = info.filename;
      a.click();
      setShowDownload(false);
      setDownloadPasskey("");
    } catch (err) {
      setError(err.message || "Could not decrypt — check the passkey.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-white truncate">{doc.filename}</div>
          <div className="text-[10px] text-[#64748b] font-mono mt-0.5">{(doc.sizeBytes / 1024).toFixed(1)} KB · {doc.uploadedByEmail}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${STATUS_STYLES[doc.status] || STATUS_STYLES.DRAFT}`}>
            {doc.status.replace("_", " ")}
          </span>
          <span className="text-[8px] font-mono text-[#64748b]">{doc.accessLevel}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        {availableActions.map(([action, label]) => (
          <button
            key={action}
            onClick={() => handleAction(action)}
            disabled={!!acting}
            className="text-[9px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 disabled:opacity-40"
          >
            {acting === action ? "…" : label}
          </button>
        ))}
        <button onClick={() => setShowDownload((v) => !v)} className="text-[9px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10">
          Download
        </button>
        {canManageThisDoc && (
          <>
            <button onClick={() => setShowPermissions((v) => !v)} className="text-[9px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10">
              Permissions
            </button>
            <button onClick={() => setShowShare((v) => !v)} className="text-[9px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10">
              Share
            </button>
          </>
        )}
        <button onClick={toggleActivity} className="text-[9px] font-bold uppercase px-2 py-1 rounded-md text-[#64748b] hover:text-slate-300 ml-auto">
          {showActivity ? "Hide history" : "History"}
        </button>
      </div>

      {error && <p className="text-red-400 text-[10px] mt-1.5">{error}</p>}

      {showDownload && (
        <div className="mt-2 border-t border-white/5 pt-2 flex gap-2">
          <input
            type="password"
            value={downloadPasskey}
            onChange={(e) => setDownloadPasskey(e.target.value)}
            placeholder="Encryption passkey"
            className="flex-1 bg-black/30 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white"
          />
          <button onClick={handleDownload} disabled={downloading || !downloadPasskey} className="text-[9px] font-bold uppercase px-3 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
            {downloading ? "…" : "Go"}
          </button>
        </div>
      )}

      {showPermissions && <PermissionsPanel documentId={doc.id} orgId={orgId} ownerEmail={doc.uploadedByEmail} />}
      {showShare && <SharePanel documentId={doc.id} orgId={orgId} />}

      {showActivity && (
        <div className="mt-2 border-t border-white/5 pt-2 space-y-1">
          {loadingActivity ? (
            <p className="text-[#475569] text-[10px] italic">Loading…</p>
          ) : activity && activity.length > 0 ? (
            activity.map((e) => (
              <div key={e.eventId} className="text-[10px] font-mono text-[#64748b]">
                <span className="text-slate-300">{e.action}</span>
                {e.previousState && <span> · {e.previousState} → {e.newState}</span>}
                <span> · {e.actorId} · {new Date(e.timestamp).toLocaleString()}</span>
                {e.metadata?.note && <span className="italic"> — "{e.metadata.note}"</span>}
              </div>
            ))
          ) : (
            <p className="text-[#475569] text-[10px] italic">No activity recorded.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// PERMISSIONS PANEL — "people with access" per the SOW's mockup
// ============================================================
function PermissionsPanel({ documentId, orgId, ownerEmail }) {
  const [grants, setGrants] = useState(null);
  const [error, setError] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newLevel, setNewLevel] = useState("VIEW");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/documents/${documentId}/permissions?orgId=${orgId}`);
      setGrants(data.grants);
    } catch (err) {
      setError(err.message);
    }
  }, [documentId, orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api(`/api/orgs/documents/${documentId}/permissions`, { method: "POST", body: JSON.stringify({ orgId, email: newEmail, level: newLevel }) });
      setNewEmail("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleChange(email, level) {
    setError("");
    try {
      await api(`/api/orgs/documents/${documentId}/permissions`, { method: "POST", body: JSON.stringify({ orgId, email, level }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRevoke(email) {
    setError("");
    try {
      await api(`/api/orgs/documents/${documentId}/permissions`, { method: "DELETE", body: JSON.stringify({ orgId, email }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="mt-2 border-t border-white/5 pt-2">
      <p className="text-[9px] font-bold uppercase text-[#64748b] mb-1.5">People with access</p>
      <div className="flex items-center justify-between text-[10px] py-1">
        <span className="text-slate-300 truncate">{ownerEmail}</span>
        <span className="text-[#64748b] font-mono">Owner</span>
      </div>
      {grants === null ? (
        <p className="text-[#475569] text-[10px] italic">Loading…</p>
      ) : (
        grants.map((g) => (
          <div key={g.email} className="flex items-center justify-between gap-2 text-[10px] py-1">
            <span className="text-slate-300 truncate">{g.email}</span>
            <div className="flex items-center gap-1 shrink-0">
              <select value={g.level} onChange={(e) => handleChange(g.email, e.target.value)} className="bg-black/30 border border-white/10 rounded px-1 py-0.5 text-[9px] text-white">
                <option value="VIEW">View</option>
                <option value="EDIT">Edit</option>
                <option value="MANAGE">Manage</option>
              </select>
              <button onClick={() => handleRevoke(g.email)} className="text-red-400 hover:text-red-300 text-[9px] font-bold uppercase px-1.5">Revoke</button>
            </div>
          </div>
        ))
      )}
      <form onSubmit={handleAdd} className="flex items-center gap-1.5 mt-2">
        <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} type="email" required placeholder="Add person by email" className="flex-1 bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-[10px] text-white" />
        <select value={newLevel} onChange={(e) => setNewLevel(e.target.value)} className="bg-black/30 border border-white/10 rounded px-1 py-1 text-[9px] text-white">
          <option value="VIEW">View</option>
          <option value="EDIT">Edit</option>
          <option value="MANAGE">Manage</option>
        </select>
        <button disabled={submitting} className="text-[9px] font-bold uppercase px-2 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">+ Add</button>
      </form>
      {error && <p className="text-red-400 text-[10px] mt-1">{error}</p>}
    </div>
  );
}

// ============================================================
// SHARE PANEL — secure share link creation + active shares + revoke
// ============================================================
function SharePanel({ documentId, orgId }) {
  const [shares, setShares] = useState(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [preset, setPreset] = useState("24h");
  const [maxUses, setMaxUses] = useState("");
  const [newShareUrl, setNewShareUrl] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/documents/${documentId}/shares?orgId=${orgId}`);
      setShares(data.shares);
    } catch (err) {
      setError(err.message);
    }
  }, [documentId, orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    setError("");
    setNewShareUrl("");
    try {
      const body = { orgId, expirationPreset: preset };
      if (maxUses) body.maxUses = Number(maxUses);
      const data = await api(`/api/orgs/documents/${documentId}/shares`, { method: "POST", body: JSON.stringify(body) });
      setNewShareUrl(data.shareUrl);
      setMaxUses("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(shareId) {
    setError("");
    try {
      await api(`/api/orgs/documents/${documentId}/shares/${shareId}/revoke`, { method: "POST", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="mt-2 border-t border-white/5 pt-2">
      <p className="text-[9px] font-bold uppercase text-[#64748b] mb-1.5">Secure sharing</p>
      <form onSubmit={handleCreate} className="flex items-center gap-1.5">
        <select value={preset} onChange={(e) => setPreset(e.target.value)} className="bg-black/30 border border-white/10 rounded px-1.5 py-1 text-[9px] text-white">
          <option value="1h">Expires in 1 hour</option>
          <option value="24h">Expires in 24 hours</option>
          <option value="7d">Expires in 7 days</option>
          <option value="30d">Expires in 30 days</option>
        </select>
        <input value={maxUses} onChange={(e) => setMaxUses(e.target.value)} type="number" min="1" placeholder="Max uses (optional)" className="w-28 bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-[10px] text-white" />
        <button disabled={creating} className="text-[9px] font-bold uppercase px-2 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
          {creating ? "…" : "Create link"}
        </button>
      </form>

      {newShareUrl && (
        <div className="mt-2 bg-black/20 border border-white/10 rounded-lg p-2">
          <p className="text-[9px] text-[#64748b] mb-1">Share this link — it won't be shown again:</p>
          <p className="text-[10px] text-[#00f2fe] break-all font-mono">{newShareUrl}</p>
        </div>
      )}

      {error && <p className="text-red-400 text-[10px] mt-1">{error}</p>}

      <div className="mt-2 space-y-1">
        {shares === null ? (
          <p className="text-[#475569] text-[10px] italic">Loading…</p>
        ) : shares.length === 0 ? (
          <p className="text-[#475569] text-[10px] italic">No share links yet.</p>
        ) : (
          shares.map((s) => (
            <div key={s.shareId} className="flex items-center justify-between gap-2 text-[10px] bg-black/20 rounded px-2 py-1">
              <span className="text-slate-300">
                {s.status} · {s.useCount}{s.maxUses !== null ? `/${s.maxUses}` : ""} uses · expires {new Date(s.expiresAt).toLocaleString()}
              </span>
              {s.status === "active" && (
                <button onClick={() => handleRevoke(s.shareId)} className="text-red-400 hover:text-red-300 text-[9px] font-bold uppercase shrink-0">Revoke</button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================
// TEAM VIEW
// ============================================================
function TeamView({ orgId }) {
  const [members, setMembers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteDeptIds, setInviteDeptIds] = useState([]);
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);

  const load = useCallback(async () => {
    try {
      const [membersData, deptData] = await Promise.all([
        api(`/api/orgs/members?orgId=${orgId}`),
        api(`/api/orgs/departments?orgId=${orgId}`),
      ]);
      setMembers(membersData.members);
      setDepartments(deptData.departments);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleInvite(e) {
    e.preventDefault();
    setInviting(true);
    setError("");
    setInviteResult(null);
    try {
      const data = await api("/api/orgs/invite", {
        method: "POST",
        body: JSON.stringify({ orgId, email: inviteEmail, role: inviteRole, departmentIds: inviteDeptIds }),
      });
      setInviteResult(data);
      setInviteEmail("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setInviting(false);
    }
  }

  function toggleDept(id) {
    setInviteDeptIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#64748b] mb-4">Invite someone</h3>
        <form onSubmit={handleInvite} className="space-y-3">
          <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required type="email" placeholder="colleague@company.com" className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white" />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm text-white">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <div>
            <p className="text-[10px] text-[#64748b] uppercase mb-1.5">Departments</p>
            <div className="flex flex-wrap gap-1.5">
              {departments.map((d) => (
                <button type="button" key={d.id} onClick={() => toggleDept(d.id)} className={`text-[10px] px-2.5 py-1 rounded-full border ${inviteDeptIds.includes(d.id) ? "bg-[#00f2fe]/15 border-[#00f2fe]/40 text-[#00f2fe]" : "border-white/10 text-slate-400"}`}>
                  {d.name}
                </button>
              ))}
            </div>
          </div>
          <button disabled={inviting} className="w-full py-2 rounded-lg text-xs font-bold uppercase bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
            {inviting ? "Sending…" : "Send invite"}
          </button>
        </form>
        {error && <p className="text-red-400 text-xs mt-3">{error}</p>}
        {inviteResult && (
          <div className="mt-3 bg-black/20 border border-white/10 rounded-lg p-3">
            <p className="text-slate-400 text-xs mb-1">{inviteResult.emailSent ? "Invite emailed." : "Share this invite link:"}</p>
            <a href={inviteResult.inviteUrl} className="text-[#00f2fe] underline text-[10px] break-all">{inviteResult.inviteUrl}</a>
          </div>
        )}
      </div>

      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#64748b] mb-4">Members</h3>
        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.email} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg p-2.5">
              <div className="min-w-0">
                <div className="text-xs text-white truncate">{m.email}</div>
                <div className="text-[10px] text-[#64748b] font-mono">{ROLE_LABELS[m.role]} · {m.status === "active" ? "Active" : "Invited"}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
