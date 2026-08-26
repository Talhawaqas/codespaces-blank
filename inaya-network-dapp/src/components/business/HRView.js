"use client";

// src/components/business/HRView.js
//
// HR tab (Phase 5) — Employees / Leave / Department Managers, backed by
// /api/orgs/hr/*. Same self-contained-view pattern as FinanceView. Any
// member can see their OWN employee record and their own leave requests
// (self-service, the SOW's "Employee" role) even with no HR access — the
// server enforces this via getAccessibleScope()/isSelfEmployeeRecord(),
// this view just renders whatever the API returns.
//
// Carries the same "Testnet / Beta" badge FinanceView does (SOW §8).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// Same duplicated encrypt/shard/pin trio as FinanceView.js — see that
// file's header comment for why this is duplicated rather than shared.
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
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function uploadShardToPinata(encryptedShard, filename, elementTag) {
  const res = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ encryptedShard, filename, elementTag }) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || data.pinata || "IPFS pinning failed.");
  return data.IpfsHash;
}
async function sha256Hex(text) {
  const enc = new TextEncoder();
  const digest = await window.crypto.subtle.digest("SHA-256", enc.encode(text));
  return "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const STATUS_COLORS = {
  ONBOARDING: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  ACTIVE: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  ON_LEAVE: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  TERMINATED: "bg-white/5 text-[#94a3b8] border-white/10",
  PENDING: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  APPROVED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  REJECTED: "bg-red-400/10 text-red-400 border-red-400/30",
  CANCELLED: "bg-white/5 text-[#94a3b8] border-white/10",
};
function StatusBadge({ status }) {
  return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_COLORS[status] || "bg-white/10 text-slate-300 border-white/15"}`}>{status?.replace(/_/g, " ")}</span>;
}

export default function HRView({ orgId, email }) {
  const [tab, setTab] = useState("employees");
  const [departments, setDepartments] = useState([]);

  useEffect(() => {
    api(`/api/orgs/departments?orgId=${orgId}`).then((d) => setDepartments(d.departments)).catch(() => {});
  }, [orgId]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex bg-[#090d16] border border-white/5 rounded-xl p-1 w-fit">
          {[["employees", "Employees"], ["leave", "Leave"], ["managers", "Department Managers"]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[#94a3b8]"}`}>{label}</button>
          ))}
        </div>
        <span className="text-[10px] font-bold uppercase px-2.5 py-1 rounded-full border bg-amber-400/10 text-amber-400 border-amber-400/30">Testnet / Beta</span>
      </div>
      {tab === "employees" && <EmployeesTab orgId={orgId} email={email} departments={departments} />}
      {tab === "leave" && <LeaveTab orgId={orgId} email={email} />}
      {tab === "managers" && <ManagersTab orgId={orgId} departments={departments} />}
    </div>
  );
}

// ============================================================
// EMPLOYEES
// ============================================================
function EmployeesTab({ orgId, email, departments }) {
  const [employees, setEmployees] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      setEmployees((await api(`/api/orgs/hr/employees?orgId=${orgId}`)).employees);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center">
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New employee</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
        {!employees ? <p className="text-[#94a3b8] font-mono text-sm">Loading…</p> : employees.length === 0 ? (
          <EmptyState compact icon="🧑‍💼" description="No employee records visible yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {employees.map((emp) => (
              <button key={emp.id} onClick={() => setSelected(emp)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-white text-sm">{emp.fullName}</span>
                  {emp.jobTitle && <p className="text-[#94a3b8] text-[12px] font-mono mt-0.5">{emp.jobTitle}</p>}
                </div>
                <StatusBadge status={emp.employmentStatus} />
              </button>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateEmployeeModal orgId={orgId} departments={departments} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <EmployeeDetailModal orgId={orgId} email={email} employee={selected} onClose={() => setSelected(null)} onChanged={() => { load(); setSelected(null); }} />}
    </div>
  );
}

function CreateEmployeeModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [fullName, setFullName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [joiningDate, setJoiningDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!departmentId || !fullName.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/hr/employees", {
        method: "POST",
        body: JSON.stringify({ orgId, departmentId, fullName: fullName.trim(), jobTitle: jobTitle.trim() || undefined, memberEmail: memberEmail.trim() || undefined, joiningDate: joiningDate || undefined }),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New employee" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-white">
          <option value="">Department…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} required placeholder="Full name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder-[#8a96ab]" />
        <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Job title (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder-[#8a96ab]" />
        <input value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} type="email" placeholder="Linked workspace login (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder-[#8a96ab]" />
        <input value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} type="date" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-white" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !departmentId || !fullName.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create employee"}</button>
      </form>
    </Modal>
  );
}

const EMPLOYEE_ACTIONS = {
  ONBOARDING: [["activate", "Activate"]],
  ACTIVE: [["placeOnLeave", "Place on leave"], ["terminate", "Terminate"]],
  ON_LEAVE: [["returnFromLeave", "Return from leave"], ["terminate", "Terminate"]],
};

function EmployeeDetailModal({ orgId, email, employee, onClose, onChanged }) {
  const [balance, setBalance] = useState(null);
  const [attachments, setAttachments] = useState(null);
  const [submitting, setSubmitting] = useState(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState(null);
  const [passkey, setPasskey] = useState("");
  const [uploading, setUploading] = useState(false);

  const isSelf = employee.memberEmail === email;

  const loadExtras = useCallback(async () => {
    try {
      setBalance(await api(`/api/orgs/hr/employees/${employee.id}/leave-balance?orgId=${orgId}`));
    } catch { setBalance(null); }
    try {
      setAttachments((await api(`/api/orgs/hr/employees/${employee.id}/attachments?orgId=${orgId}`)).attachments);
    } catch { setAttachments([]); }
  }, [orgId, employee.id]);

  useEffect(() => { loadExtras(); }, [loadExtras]);

  async function handleAction(action) {
    setSubmitting(action);
    setError("");
    try {
      await api(`/api/orgs/hr/employees/${employee.id}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(null);
    }
  }

  async function handleUploadDoc(e) {
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
      await api(`/api/orgs/hr/employees/${employee.id}/attachments`, { method: "POST", body: JSON.stringify({ orgId, filename: file.name, fileHash, sizeBytes: file.size, cidAlpha, cidBeta }) });
      setFile(null);
      setPasskey("");
      await loadExtras();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal title={employee.fullName} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <StatusBadge status={employee.employmentStatus} />
          {isSelf && <span className="text-[10px] font-bold uppercase text-[#00f2fe]">You</span>}
        </div>
        {employee.jobTitle && <p className="text-slate-300 text-sm">{employee.jobTitle}</p>}
        <p className="text-[12px] font-mono text-[#94a3b8]">Joined {new Date(employee.joiningDate).toLocaleDateString()}</p>

        {balance && (
          <div className="border-t border-white/5 pt-3 flex items-center justify-between text-xs">
            <span className="text-[#94a3b8] uppercase font-bold">Leave balance</span>
            <span className="text-white font-mono tabular-nums">{balance.remainingDays} / {balance.allocationDays} days</span>
          </div>
        )}

        {(EMPLOYEE_ACTIONS[employee.employmentStatus] || []).length > 0 && (
          <div className="flex gap-2 border-t border-white/5 pt-3">
            {EMPLOYEE_ACTIONS[employee.employmentStatus].map(([action, label]) => (
              <button key={action} disabled={!!submitting} onClick={() => handleAction(action)} className="flex-1 py-2 rounded-lg text-xs font-bold uppercase bg-white/10 text-slate-200 hover:bg-white/15 disabled:opacity-40">
                {submitting === action ? "…" : label}
              </button>
            ))}
          </div>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}

        <div className="space-y-2 border-t border-white/5 pt-3">
          <p className="text-[11px] font-bold uppercase text-[#94a3b8]">Documents</p>
          {attachments && attachments.length > 0 && (
            <div className="space-y-1">
              {attachments.map((a) => <p key={a.id} className="text-xs text-slate-300 truncate">📎 {a.filename}</p>)}
            </div>
          )}
          {attachments && attachments.length === 0 && <p className="text-[#8a96ab] text-xs italic">No documents yet.</p>}
          <form onSubmit={handleUploadDoc} className="space-y-1.5">
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} className="w-full text-[11px] text-slate-400 file:mr-2 file:py-1 file:px-2.5 file:rounded-lg file:border-0 file:text-[11px] file:font-bold file:bg-[#00f2fe]/10 file:text-[#00f2fe]" />
            <input type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} placeholder="Encryption passkey" className="w-full bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-white" />
            <button disabled={uploading || !file || !passkey} className="w-full py-1.5 rounded-lg text-[11px] font-bold uppercase bg-white/10 text-slate-200 disabled:opacity-40">{uploading ? "Uploading…" : "Upload document"}</button>
          </form>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// LEAVE
// ============================================================
function LeaveTab({ orgId, email }) {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [acting, setActing] = useState(null);

  const load = useCallback(async () => {
    try {
      setRequests((await api(`/api/orgs/hr/leave-requests?orgId=${orgId}`)).leaveRequests);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleAction(id, action) {
    setActing(`${id}:${action}`);
    setError("");
    try {
      await api(`/api/orgs/hr/leave-requests/${id}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center">
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ Request leave</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
        {!requests ? <p className="text-[#94a3b8] font-mono text-sm">Loading…</p> : requests.length === 0 ? (
          <EmptyState compact icon="🌴" description="No leave requests yet." ctaLabel="Request leave" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {requests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-white text-sm">{r.leaveType}</span>
                  <p className="text-[#94a3b8] text-[12px] font-mono mt-0.5">{new Date(r.startDate).toLocaleDateString()} – {new Date(r.endDate).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <StatusBadge status={r.status} />
                  {r.status === "PENDING" && (
                    <>
                      <button onClick={() => handleAction(r.id, "approve")} disabled={!!acting} className="text-[11px] font-bold uppercase text-emerald-400 bg-emerald-400/10 border border-emerald-400/30 px-2 py-1 rounded-lg disabled:opacity-40">✓</button>
                      <button onClick={() => handleAction(r.id, "reject")} disabled={!!acting} className="text-[11px] font-bold uppercase text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-1 rounded-lg disabled:opacity-40">✕</button>
                      <button onClick={() => handleAction(r.id, "cancel")} disabled={!!acting} className="text-[11px] font-bold uppercase text-[#94a3b8] bg-white/5 border border-white/15 px-2 py-1 rounded-lg disabled:opacity-40">Cancel</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateLeaveModal orgId={orgId} email={email} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreateLeaveModal({ orgId, email, onClose, onCreated }) {
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState("");
  const [leaveType, setLeaveType] = useState("ANNUAL");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/hr/employees?orgId=${orgId}`).then((d) => {
      setEmployees(d.employees);
      const self = d.employees.find((e) => e.memberEmail === email);
      if (self) setEmployeeId(self.id);
    }).catch(() => {});
  }, [orgId, email]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!employeeId || !startDate || !endDate) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/hr/leave-requests", {
        method: "POST",
        body: JSON.stringify({ orgId, employeeId, leaveType, startDate, endDate, reason: reason.trim() || undefined }),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Request leave" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-white">
          <option value="">Employee…</option>
          {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.fullName}{emp.memberEmail === email ? " (you)" : ""}</option>)}
        </select>
        <select value={leaveType} onChange={(e) => setLeaveType(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-white">
          <option value="ANNUAL">Annual</option>
          <option value="SICK">Sick</option>
          <option value="UNPAID">Unpaid</option>
          <option value="OTHER">Other</option>
        </select>
        <div className="grid grid-cols-2 gap-2">
          <input value={startDate} onChange={(e) => setStartDate(e.target.value)} type="date" required className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-white" />
          <input value={endDate} onChange={(e) => setEndDate(e.target.value)} type="date" required className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-white" />
        </div>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" rows={2} className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !employeeId || !startDate || !endDate} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Submitting…" : "Submit request"}</button>
      </form>
    </Modal>
  );
}

// ============================================================
// DEPARTMENT MANAGERS
// ============================================================
function ManagersTab({ orgId, departments }) {
  const [assigning, setAssigning] = useState(null);
  const [memberEmail, setMemberEmail] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function handleAssign(departmentId) {
    const targetEmail = (memberEmail[departmentId] || "").trim();
    if (!targetEmail) return;
    setAssigning(departmentId);
    setError("");
    setNotice("");
    try {
      await api(`/api/orgs/hr/departments/${departmentId}/manager`, { method: "POST", body: JSON.stringify({ orgId, memberEmail: targetEmail }) });
      setNotice(`${targetEmail} is now a Department Manager for this department.`);
      setMemberEmail((m) => ({ ...m, [departmentId]: "" }));
    } catch (err) {
      setError(err.message);
    } finally {
      setAssigning(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {notice && <p className="text-emerald-400 text-xs">{notice}</p>}
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5">
        {departments.length === 0 ? (
          <EmptyState compact icon="🏢" description="No departments yet." />
        ) : (
          <div className="space-y-3">
            {departments.map((d) => (
              <div key={d.id} className="bg-black/20 border border-white/5 rounded-lg p-3 space-y-2">
                <span className="text-white text-sm">{d.name}</span>
                <div className="flex gap-2">
                  <input
                    value={memberEmail[d.id] || ""}
                    onChange={(e) => setMemberEmail((m) => ({ ...m, [d.id]: e.target.value }))}
                    type="email"
                    placeholder="Member email"
                    className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-[#8a96ab]"
                  />
                  <button onClick={() => handleAssign(d.id)} disabled={assigning === d.id || !(memberEmail[d.id] || "").trim()} className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg disabled:opacity-40">
                    {assigning === d.id ? "…" : "Assign manager"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="text-[#8a96ab] text-[11px]">Department Managers get read access to employee records in their assigned department, without full HR access org-wide.</p>
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-[#090d16] border border-white/10 rounded-2xl p-5 w-full max-w-md max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-white font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[#94a3b8] hover:text-white text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
