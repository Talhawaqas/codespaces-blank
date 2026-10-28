"use client";

// src/components/business/EducationView.js
//
// Education OS tab of the Business Workspace (schools and colleges). Same
// self-contained-view pattern as GovernmentView.js: its own api() helper,
// nothing from business/page.js beyond {orgId, canManage, email}. Sections
// register with useErpSection, so in ERP mode they appear in the task
// panel. Every permission is enforced server-side (src/lib/education/*);
// the UI only hides buttons a role can't use and shows the server's 403
// message plainly when a record is out of reach.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import { useErpSection } from "./erp/ErpNavContext";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { data });
  return data;
}

const panel = "bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5";
const row = "flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3";
const input = "bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]";
const primary = "text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40";
const ghost = "text-[11px] font-bold uppercase px-2 py-1 rounded-lg border border-white/10 text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] disabled:opacity-40";
const muted = "text-[var(--inaya-text-muted)] text-[12px]";
const h3 = "text-[var(--inaya-text-primary)] font-semibold text-sm mb-3";
const today = () => new Date().toISOString().slice(0, 10);
const toMinor = (major) => Math.round(Number(major || 0) * 100);
function money(minor, currency) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "PKR", maximumFractionDigits: 2 }).format((minor || 0) / 100); }
  catch { return `${currency || ""} ${((minor || 0) / 100).toFixed(2)}`; }
}
const label = (s) => String(s || "").replace(/_/g, " ");

function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setError(""); setData(await fn()); } catch (err) { setError(err.message); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return [data, load, error, setError];
}

export default function EducationView({ orgId, canManage, email }) {
  const TABS = [
    ["overview", "Overview"], ["students", "Students"], ["admissions", "Admissions"], ["attendance", "Attendance"],
    ["exams", "Exams & results"], ["fees", "Fees & payments"], ["setup", "School setup"],
  ];
  const [tab, setTab] = useErpSection("overview", TABS);
  const [options] = useLoad(() => api(`/api/orgs/education/options?orgId=${orgId}`), [orgId]);
  const [classData, reloadClasses] = useLoad(() => api(`/api/orgs/education/classes?orgId=${orgId}`), [orgId]);
  const classes = classData?.classes || [];
  const role = options?.educationRole || null;
  const ctx = { orgId, canManage, email, options, classes, reloadClasses, role, isPrincipal: canManage || role === "principal", isRegister: canManage || role === "principal" || role === "admissions", isFees: canManage || role === "principal" || role === "accounts" };

  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap" data-erp-tabs>
        {TABS.map(([key, text]) => (
          <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{text}</button>
        ))}
      </div>
      {!canManage && !role && options && (
        <p className={`${panel} ${muted}`}>You don&apos;t have an Education OS role yet. Ask the owner or an admin to give you one under School setup → Staff roles.</p>
      )}
      {tab === "overview" && <OverviewTab {...ctx} goTo={setTab} />}
      {tab === "students" && <StudentsTab {...ctx} />}
      {tab === "admissions" && <AdmissionsTab {...ctx} />}
      {tab === "attendance" && <AttendanceTab {...ctx} />}
      {tab === "exams" && <ExamsTab {...ctx} />}
      {tab === "fees" && <FeesTab {...ctx} />}
      {tab === "setup" && <SetupTab {...ctx} />}
    </div>
  );
}

// ============================================================
// OVERVIEW
// ============================================================
function OverviewTab({ orgId, goTo }) {
  const [d, , error] = useLoad(() => api(`/api/orgs/education/dashboard?orgId=${orgId}`), [orgId]);
  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!d) return <p className={muted}>Loading…</p>;
  const tiles = [
    ["Students enrolled", d.enrolled, "students"], ["Classes", d.classes, "setup"],
    d.attendance && ["Registers marked today", `${d.attendance.marked} / ${d.attendance.classes}`, "attendance"],
    d.attendance && ["Attendance today", d.attendance.rate === null ? "—" : `${d.attendance.rate}%`, "attendance"],
    d.openApplications !== null && ["Open applications", d.openApplications, "admissions"],
    d.documentsPending !== null && ["Students with documents to check", d.documentsPending, "students"],
    d.fees && ["Collected this month", money(d.fees.collectedThisMonthMinor, d.fees.currency), "fees"],
    d.fees && ["Overdue fees", money(d.fees.overdueMinor, d.fees.currency), "fees"],
    d.fees && ["Families overdue", d.fees.defaulters, "fees"],
    d.fees && ["Concessions waiting for approval", d.fees.pendingConcessions, "fees"],
  ].filter(Boolean);
  const empty = d.classes === 0;
  return (
    <div className="space-y-4">
      {empty && (
        <div className={panel}>
          <p className={h3}>Set up your school in four steps</p>
          <ol className={`${muted} list-decimal ml-5 space-y-1`}>
            <li>School setup → choose your country, currency and receipt prefix.</li>
            <li>Add an academic year, your classes and sections, and subjects.</li>
            <li>Give staff their roles (principal, admissions, accounts, teacher) and assign teachers to classes.</li>
            <li>Add students (or enrol them from Admissions), then create a fee structure and generate the month&apos;s fee invoices.</li>
          </ol>
          <button className={`${primary} mt-3`} onClick={() => goTo("setup")}>Open school setup</button>
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map(([t, v, go]) => (
          <button key={t} onClick={() => goTo(go)} className={`${panel} text-left hover:border-white/15`}>
            <p className={muted}>{t}</p>
            <p className="text-[var(--inaya-text-primary)] text-xl font-semibold mt-1">{v}</p>
          </button>
        ))}
      </div>
      {d.attendance?.unmarked?.length > 0 && (
        <div className={panel}>
          <p className={h3}>Registers not marked yet today</p>
          <p className={muted}>{d.attendance.unmarked.map((c) => (c.section ? `${c.name} ${c.section}` : c.name)).join(", ")}</p>
        </div>
      )}
      <p className={muted}>Guardian phone numbers, addresses, ID numbers and medical notes are encrypted before they are stored. Teachers only see the students in their own classes, and every time someone opens a student record it is logged.</p>
    </div>
  );
}

// ============================================================
// STUDENTS
// ============================================================
function ClassSelect({ classes, value, onChange, allLabel = "All classes", only }) {
  const list = only ? classes.filter(only) : classes;
  return (
    <select aria-label="Class" value={value} onChange={(e) => onChange(e.target.value)} className={input}>
      {allLabel !== null && <option value="">{allLabel}</option>}
      {list.map((c) => <option key={c._id} value={c._id}>{c.label}</option>)}
    </select>
  );
}

function StudentsTab({ orgId, classes, options, isRegister, isFees, isPrincipal }) {
  const [classId, setClassId] = useState("");
  const [q, setQ] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [data, load, error, setError] = useLoad(() => api(`/api/orgs/education/students?orgId=${orgId}${classId ? `&classId=${classId}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`), [orgId, classId, q]);

  if (openId) return <StudentDetail orgId={orgId} studentId={openId} classes={classes} options={options} isRegister={isRegister} isFees={isFees} isPrincipal={isPrincipal} onBack={() => { setOpenId(null); load(); }} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ClassSelect classes={classes} value={classId} onChange={setClassId} />
        <input aria-label="Search students" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, admission no. or guardian" className={`${input} flex-1 min-w-[200px]`} />
        {isRegister && <button onClick={() => setShowCreate((v) => !v)} className={`${primary} ml-auto`}>+ Add student</button>}
      </div>
      {showCreate && <StudentForm orgId={orgId} classes={classes} options={options} onDone={() => { setShowCreate(false); load(); }} onError={setError} />}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className={panel}>
        {!data ? <p className={muted}>Loading…</p> : data.students.length === 0 ? (
          <EmptyState compact icon="🎓" description={isRegister ? "No students yet." : "No students in your classes yet."} ctaLabel={isRegister ? "Add a student" : undefined} onCta={isRegister ? () => setShowCreate(true) : undefined} />
        ) : (
          <div className="space-y-2">
            {data.students.map((s) => (
              <div key={s._id} className={row}>
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{s.fullName}</span>
                  <p className={`${muted} font-mono mt-0.5`}>{s.admissionNo} · {s.classLabel || "no class"} · {s.status}{s.primaryGuardianName ? ` · guardian ${s.primaryGuardianName}` : ""}{s.documentsPending ? ` · ${s.documentsPending} document(s) to check` : ""}</p>
                </div>
                <button onClick={() => setOpenId(s._id)} className={ghost}>Open</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StudentForm({ orgId, classes, options, onDone, onError }) {
  const [f, setF] = useState({ fullName: "", dateOfBirth: "", gender: "", classId: "", gName: "", gRelation: "father", gPhone: "", gEmail: "", idType: "", idValue: "", address: "", medicalNotes: "" });
  const [dups, setDups] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function submit(e, allowDuplicate = false) {
    e?.preventDefault();
    try {
      await api("/api/orgs/education/students", { method: "POST", body: JSON.stringify({
        orgId, fullName: f.fullName, dateOfBirth: f.dateOfBirth || null, gender: f.gender || null, classId: f.classId || null, allowDuplicate,
        guardians: f.gName ? [{ name: f.gName, relation: f.gRelation, phone: f.gPhone, email: f.gEmail, primary: true }] : [],
        identifiers: f.idType && f.idValue ? [{ type: f.idType, value: f.idValue }] : [], address: f.address || null, medicalNotes: f.medicalNotes || null,
      }) });
      onDone();
    } catch (err) {
      if (err.data?.duplicates) setDups(err.data.duplicates); else onError(err.message);
    }
  }
  return (
    <form onSubmit={submit} className={`${panel} grid grid-cols-1 md:grid-cols-3 gap-2`}>
      <input aria-label="Full name" required value={f.fullName} onChange={set("fullName")} placeholder="Student's full name" className={input} />
      <input aria-label="Date of birth" type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} className={input} />
      <select aria-label="Gender" value={f.gender} onChange={set("gender")} className={input}><option value="">Gender</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select>
      <ClassSelect classes={classes} value={f.classId} onChange={(v) => setF((x) => ({ ...x, classId: v }))} allLabel="Class (optional)" />
      <input aria-label="Guardian name" value={f.gName} onChange={set("gName")} placeholder="Guardian name" className={input} />
      <select aria-label="Relation" value={f.gRelation} onChange={set("gRelation")} className={input}>{["father", "mother", "guardian", "grandparent", "sibling", "other"].map((r) => <option key={r} value={r}>{r}</option>)}</select>
      <input aria-label="Guardian phone" value={f.gPhone} onChange={set("gPhone")} placeholder="Guardian phone, e.g. +923001234567" className={input} />
      <input aria-label="Guardian email" value={f.gEmail} onChange={set("gEmail")} placeholder="Guardian email (optional)" className={input} />
      <select aria-label="ID type" value={f.idType} onChange={set("idType")} className={input}><option value="">ID document (optional)</option>{Object.entries(options?.identifierTypes || {}).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
      <input aria-label="ID number" value={f.idValue} onChange={set("idValue")} placeholder="ID number" className={input} />
      <input aria-label="Home address" value={f.address} onChange={set("address")} placeholder="Home address (encrypted)" className={`${input} md:col-span-2`} />
      <input aria-label="Medical notes" value={f.medicalNotes} onChange={set("medicalNotes")} placeholder="Allergies or medical notes (encrypted)" className={`${input} md:col-span-3`} />
      {dups && (
        <div className="md:col-span-3 text-amber-400 text-xs">
          A student with this name and date of birth is already registered: {dups.map((d) => d.admissionNo).join(", ")}.
          <button type="button" className={`${ghost} ml-2`} onClick={() => submit(null, true)}>It&apos;s a different child, add anyway</button>
        </div>
      )}
      <div className="md:col-span-3 flex gap-2"><button className={primary} disabled={!f.fullName.trim()}>Save student</button></div>
    </form>
  );
}

function StudentDetail({ orgId, studentId, classes, options, isRegister, isFees, isPrincipal, onBack }) {
  const [s, load, error, setError] = useLoad(() => api(`/api/orgs/education/students/${studentId}?orgId=${orgId}`).then((d) => d.student), [orgId, studentId]);
  const [msg, setMsg] = useState("");
  const [links, setLinks] = useState(null);
  const [newLink, setNewLink] = useState(null);
  const [report, setReport] = useState(null);
  const [docForm, setDocForm] = useState({ type: "birth_certificate", label: "" });

  async function act(fn, done) { try { setError(""); await fn(); setMsg(done || ""); load(); } catch (err) { setError(err.message); } }
  async function loadLinks() { try { setLinks((await api(`/api/orgs/education/students/${studentId}/guardian-links?orgId=${orgId}`)).links); } catch (err) { setError(err.message); } }
  async function exportData() {
    try {
      const d = await api(`/api/orgs/education/students/${studentId}/export?orgId=${orgId}`);
      const blob = new Blob([JSON.stringify(d.export, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `student-${s.admissionNo}-data.json`; a.click(); URL.revokeObjectURL(a.href);
    } catch (err) { setError(err.message); }
  }
  async function erase() {
    const reason = window.prompt("Why is this student's personal data being erased? (for example, the guardian's written request)");
    if (!reason) return;
    const confirm = window.prompt('This removes the student\'s personal data for good. Fee records are kept under an anonymised name. Type ERASE to confirm.');
    if (confirm !== "ERASE") return;
    await act(() => api(`/api/orgs/education/students/${studentId}/erase`, { method: "POST", body: JSON.stringify({ orgId, reason, confirm }) }), "Personal data erased.");
  }

  if (error && !s) return <div className="space-y-3"><button className={ghost} onClick={onBack}>← Back</button><p className={`${panel} text-red-400 text-sm`}>{error}</p></div>;
  if (!s) return <p className={muted}>Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><button className={ghost} onClick={onBack}>← Back to students</button>{msg && <span className="text-emerald-400 text-xs">{msg}</span>}{error && <span className="text-red-400 text-xs">{error}</span>}</div>
      <div className={panel}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[var(--inaya-text-primary)] text-lg font-semibold">{s.fullName}</p>
            <p className={`${muted} font-mono`}>{s.admissionNo} · {s.classLabel || "no class"} · {s.status}{s.dateOfBirth ? ` · born ${s.dateOfBirth}` : ""}</p>
            <p className={`${muted} mt-1`}>You are seeing the {s.view === "full" ? "full record" : s.view === "teacher" ? "teacher view (ID numbers masked, no address)" : "accounts view (contact details only)"}.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isRegister && s.status !== "erased" && (
              <ClassSelect classes={classes} value={s.classId || ""} onChange={(v) => act(() => api(`/api/orgs/education/students/${studentId}`, { method: "PATCH", body: JSON.stringify({ orgId, classId: v || null }) }), "Class changed.")} allLabel="No class" />
            )}
            {isRegister && s.status === "enrolled" && <button className={ghost} onClick={() => act(() => api(`/api/orgs/education/students/${studentId}`, { method: "PATCH", body: JSON.stringify({ orgId, status: "withdrawn" }) }), "Marked as withdrawn.")}>Withdraw</button>}
            <button className={ghost} onClick={async () => { try { setReport(await api(`/api/orgs/education/students/${studentId}/report-card?orgId=${orgId}`)); } catch (err) { setError(err.message); } }}>Report card</button>
            {isPrincipal && <button className={ghost} onClick={exportData}>Export data</button>}
            {isPrincipal && s.status !== "erased" && <button className={`${ghost} text-red-400`} onClick={erase}>Erase personal data</button>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className={panel}>
          <p className={h3}>Guardians</p>
          {(s.guardians || []).length === 0 ? <p className={muted}>None recorded.</p> : s.guardians.map((g, i) => (
            <p key={i} className="text-sm text-[var(--inaya-text-primary)]">{g.name} <span className={muted}>({g.relation}{g.primary ? ", primary" : ""}) {g.phone || ""} {g.email || ""}</span></p>
          ))}
          {s.address !== undefined && <p className={`${muted} mt-2`}>Address: {s.address || "—"}</p>}
        </div>
        {s.view !== "fees" && (
          <div className={panel}>
            <p className={h3}>ID documents and medical notes</p>
            {(s.identifiers || []).map((i) => <p key={i.type} className="text-sm text-[var(--inaya-text-primary)]">{i.label}: <span className="font-mono">{i.value}</span></p>)}
            {(s.identifiers || []).length === 0 && <p className={muted}>No ID numbers recorded.</p>}
            <p className={`${muted} mt-2`}>Medical notes: {s.medicalNotes || "—"}</p>
          </div>
        )}
      </div>

      {s.view !== "fees" && (
        <div className={panel}>
          <p className={h3}>Documents</p>
          <p className={`${muted} mb-2`}>Upload the file in Documents (it is encrypted on your device), then record it here and mark it verified once checked.</p>
          {(s.documents || []).length === 0 ? <p className={muted}>No documents recorded.</p> : (
            <div className="space-y-2">{s.documents.map((d) => (
              <div key={d.id} className={row}>
                <span className="text-sm text-[var(--inaya-text-primary)] capitalize">{label(d.type)}{d.label ? ` — ${d.label}` : ""} <span className={muted}>· {d.status}{d.verifiedByEmail ? ` by ${d.verifiedByEmail}` : ""}</span></span>
                {isRegister && d.status !== "verified" && <button className={ghost} onClick={() => act(() => api(`/api/orgs/education/students/${studentId}/documents/${d.id}`, { method: "PATCH", body: JSON.stringify({ orgId, status: "verified" }) }), "Verified.")}>Mark verified</button>}
              </div>
            ))}</div>
          )}
          {isRegister && s.status !== "erased" && (
            <div className="flex flex-wrap gap-2 mt-3">
              <select aria-label="Document type" value={docForm.type} onChange={(e) => setDocForm((x) => ({ ...x, type: e.target.value }))} className={input}>{(options?.documentTypes || []).map((t) => <option key={t} value={t}>{label(t)}</option>)}</select>
              <input aria-label="Document note" value={docForm.label} onChange={(e) => setDocForm((x) => ({ ...x, label: e.target.value }))} placeholder="Note (optional)" className={input} />
              <button className={primary} onClick={() => act(() => api(`/api/orgs/education/students/${studentId}/documents`, { method: "POST", body: JSON.stringify({ orgId, ...docForm }) }), "Document added to the checklist.")}>Add to checklist</button>
            </div>
          )}
        </div>
      )}

      {(isFees || isRegister) && s.status !== "erased" && (
        <div className={panel}>
          <p className={h3}>Parent link</p>
          <p className={`${muted} mb-2`}>A read-only page for the parent showing fees, attendance and published results. It never shows ID numbers, medical notes or the address.</p>
          <div className="flex flex-wrap gap-2">
            <button className={primary} onClick={async () => { try { const r = await api(`/api/orgs/education/students/${studentId}/guardian-links`, { method: "POST", body: JSON.stringify({ orgId, days: 30 }) }); setNewLink(`${window.location.origin}${r.path}`); loadLinks(); } catch (err) { setError(err.message); } }}>Create 30-day link</button>
            <button className={ghost} onClick={loadLinks}>Show links</button>
          </div>
          {newLink && <p className="text-xs mt-2 break-all text-emerald-400">Copy this now, it won&apos;t be shown again: {newLink}</p>}
          {links && links.map((l) => (
            <div key={l._id} className={`${row} mt-2`}>
              <span className={muted}>Made {l.createdAt.slice(0, 10)} · expires {l.expiresAt.slice(0, 10)} · viewed {l.viewCount} time(s) · {l.active ? "active" : "inactive"}</span>
              {l.active && <button className={ghost} onClick={async () => { try { await api(`/api/orgs/education/guardian-links/${l._id}`, { method: "DELETE", body: JSON.stringify({ orgId }) }); loadLinks(); } catch (err) { setError(err.message); } }}>Revoke</button>}
            </div>
          ))}
        </div>
      )}

      {(isFees || isRegister) && <StatementPanel orgId={orgId} studentId={studentId} />}

      {report && (
        <div className={panel}>
          <p className={h3}>Report card {report.overall !== null ? `· overall ${report.overall}% (${report.overallGrade})` : ""}</p>
          {report.results.length === 0 ? <p className={muted}>No published results yet.</p> : report.results.map((r, i) => (
            <p key={i} className="text-sm text-[var(--inaya-text-primary)]">{r.term || "—"} · {r.subject || "—"} · {r.assessment}: {r.absent ? "absent" : `${r.marks}/${r.maxMarks}`} <span className={muted}>{r.grade || ""}</span></p>
          ))}
        </div>
      )}
    </div>
  );
}

function StatementPanel({ orgId, studentId }) {
  const [d, , error] = useLoad(() => api(`/api/orgs/education/students/${studentId}/statement?orgId=${orgId}`), [orgId, studentId]);
  return (
    <div className={panel}>
      <p className={h3}>Fee statement {d ? `· outstanding ${money(d.outstandingMinor, d.currency)}` : ""}</p>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {d && d.invoices.length === 0 && <p className={muted}>No invoices yet.</p>}
      {d && d.invoices.map((i) => <p key={i._id} className="text-sm text-[var(--inaya-text-primary)] font-mono">{i.invoiceNo} · {i.period} · due {i.dueDate} · {money(i.totalMinor, i.currency)} · paid {money(i.paidMinor, i.currency)} · {i.status}</p>)}
    </div>
  );
}

// ============================================================
// ADMISSIONS
// ============================================================
function AdmissionsTab({ orgId, classes, isRegister }) {
  const [status, setStatus] = useState("");
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ applicantName: "", dateOfBirth: "", classId: "", previousSchool: "", gName: "", gPhone: "" });
  const [data, load, error, setError] = useLoad(() => (isRegister ? api(`/api/orgs/education/applications?orgId=${orgId}${status ? `&status=${status}` : ""}`) : Promise.resolve({ applications: [] })), [orgId, status, isRegister]);
  if (!isRegister) return <p className={`${panel} ${muted}`}>Admissions are handled by the principal and the admissions office.</p>;
  const move = (id, toStatus) => api(`/api/orgs/education/applications/${id}/transition`, { method: "POST", body: JSON.stringify({ orgId, toStatus }) }).then(load).catch((e) => setError(e.message));
  const enrol = (id) => api(`/api/orgs/education/applications/${id}/enrol`, { method: "POST", body: JSON.stringify({ orgId }) }).then(load).catch((e) => setError(e.message));
  async function create(e) {
    e.preventDefault();
    try {
      await api("/api/orgs/education/applications", { method: "POST", body: JSON.stringify({ orgId, applicantName: f.applicantName, dateOfBirth: f.dateOfBirth || null, classId: f.classId || null, previousSchool: f.previousSchool, guardian: { name: f.gName, phone: f.gPhone } }) });
      setShow(false); setF({ applicantName: "", dateOfBirth: "", classId: "", previousSchool: "", gName: "", gPhone: "" }); load();
    } catch (err) { setError(err.message); }
  }
  const NEXT = { APPLIED: [["UNDER_REVIEW", "Review"], ["REJECTED", "Reject"]], UNDER_REVIEW: [["ACCEPTED", "Accept"], ["REJECTED", "Reject"]], ACCEPTED: [["WITHDRAWN", "Withdrawn"]] };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className={input}><option value="">All applications</option>{["APPLIED", "UNDER_REVIEW", "ACCEPTED", "ENROLLED", "REJECTED", "WITHDRAWN"].map((s) => <option key={s} value={s}>{label(s).toLowerCase()}</option>)}</select>
        <button className={`${primary} ml-auto`} onClick={() => setShow((v) => !v)}>+ New application</button>
      </div>
      {show && (
        <form onSubmit={create} className={`${panel} grid grid-cols-1 md:grid-cols-3 gap-2`}>
          <input aria-label="Applicant name" required value={f.applicantName} onChange={(e) => setF((x) => ({ ...x, applicantName: e.target.value }))} placeholder="Applicant's name" className={input} />
          <input aria-label="Date of birth" type="date" value={f.dateOfBirth} onChange={(e) => setF((x) => ({ ...x, dateOfBirth: e.target.value }))} className={input} />
          <ClassSelect classes={classes} value={f.classId} onChange={(v) => setF((x) => ({ ...x, classId: v }))} allLabel="Applying for class" />
          <input aria-label="Previous school" value={f.previousSchool} onChange={(e) => setF((x) => ({ ...x, previousSchool: e.target.value }))} placeholder="Previous school" className={input} />
          <input aria-label="Guardian name" required value={f.gName} onChange={(e) => setF((x) => ({ ...x, gName: e.target.value }))} placeholder="Guardian name" className={input} />
          <input aria-label="Guardian phone" value={f.gPhone} onChange={(e) => setF((x) => ({ ...x, gPhone: e.target.value }))} placeholder="Guardian phone" className={input} />
          <div className="md:col-span-3"><button className={primary}>Save application</button></div>
        </form>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className={panel}>
        {!data ? <p className={muted}>Loading…</p> : data.applications.length === 0 ? <EmptyState compact icon="📝" description="No applications yet." ctaLabel="Record an application" onCta={() => setShow(true)} /> : (
          <div className="space-y-2">{data.applications.map((a) => (
            <div key={a._id} className={row}>
              <div className="min-w-0"><span className="text-sm text-[var(--inaya-text-primary)]">{a.applicantName}</span><p className={`${muted} font-mono`}>{label(a.status).toLowerCase()} · guardian {a.guardianName} · {a.createdAt.slice(0, 10)}{a.previousSchool ? ` · from ${a.previousSchool}` : ""}</p></div>
              <div className="flex gap-2 shrink-0">
                {(NEXT[a.status] || []).map(([to, text]) => <button key={to} className={ghost} onClick={() => move(a._id, to)}>{text}</button>)}
                {a.status === "ACCEPTED" && <button className={ghost} onClick={() => enrol(a._id)}>Enrol</button>}
              </div>
            </div>
          ))}</div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// ATTENDANCE
// ============================================================
function AttendanceTab({ orgId, classes, options }) {
  const mine = classes.filter((c) => c.mine);
  const [classId, setClassId] = useState("");
  const [date, setDate] = useState(today());
  const [marks, setMarks] = useState({});
  const [msg, setMsg] = useState("");
  const effective = classId || mine[0]?._id || classes[0]?._id || "";
  const [reg, load, error, setError] = useLoad(() => (effective ? api(`/api/orgs/education/attendance/register?orgId=${orgId}&classId=${effective}&date=${date}`) : Promise.resolve(null)), [orgId, effective, date]);
  const [summary, setSummary] = useState(null);
  useEffect(() => { if (reg) setMarks(Object.fromEntries(reg.students.map((s) => [s._id, s.status || "present"]))); }, [reg]);
  async function save() {
    try { setMsg(""); const r = await api("/api/orgs/education/attendance", { method: "POST", body: JSON.stringify({ orgId, classId: effective, date, marks }) }); setMsg(`Saved ${r.saved} students.`); load(); } catch (err) { setError(err.message); }
  }
  if (!classes.length) return <p className={`${panel} ${muted}`}>Add classes under School setup first.</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <ClassSelect classes={classes} value={effective} onChange={setClassId} allLabel={null} />
        <input aria-label="Date" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} className={input} />
        <button className={ghost} onClick={async () => { try { const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10); setSummary(await api(`/api/orgs/education/attendance/summary?orgId=${orgId}&classId=${effective}&from=${from}`)); } catch (err) { setError(err.message); } }}>Last 30 days</button>
        {msg && <span className="text-emerald-400 text-xs">{msg}</span>}
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {reg && (
        <div className={panel}>
          <div className="flex items-center justify-between mb-3"><p className={h3}>Register for {reg.date} {reg.marked ? "· already marked, changes are logged" : ""}</p>
            <button className={ghost} onClick={() => setMarks(Object.fromEntries(reg.students.map((s) => [s._id, "present"])))}>All present</button></div>
          {reg.students.length === 0 ? <p className={muted}>No students enrolled in this class.</p> : (
            <div className="space-y-2">{reg.students.map((s) => (
              <div key={s._id} className={row}>
                <span className="text-sm text-[var(--inaya-text-primary)]">{s.fullName} <span className={`${muted} font-mono`}>{s.admissionNo}</span></span>
                <div className="flex gap-1">{(options?.attendanceStatuses || ["present", "absent", "late", "leave"]).map((st) => (
                  <button key={st} onClick={() => setMarks((m) => ({ ...m, [s._id]: st }))} className={`text-[11px] px-2 py-1 rounded-lg border capitalize ${marks[s._id] === st ? "border-[#00f2fe]/50 text-[#00f2fe] bg-[#00f2fe]/10" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{st}</button>
                ))}</div>
              </div>
            ))}</div>
          )}
          {reg.students.length > 0 && <button className={`${primary} mt-3`} onClick={save}>Save register</button>}
        </div>
      )}
      {summary && (
        <div className={panel}>
          <p className={h3}>Attendance over the last 30 days ({summary.days} school days recorded), lowest first</p>
          {summary.students.map((s) => <p key={s._id} className="text-sm text-[var(--inaya-text-primary)]">{s.fullName}: {s.rate === null ? "—" : `${s.rate}%`} <span className={muted}>(absent {s.absent}, late {s.late}, leave {s.leave})</span></p>)}
        </div>
      )}
    </div>
  );
}

// ============================================================
// EXAMS
// ============================================================
function ExamsTab({ orgId, classes, isPrincipal }) {
  const [classId, setClassId] = useState("");
  const [open, setOpen] = useState(null);
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ classId: "", subjectId: "", name: "", term: "", maxMarks: "100", date: "" });
  const [list, load, error, setError] = useLoad(() => api(`/api/orgs/education/assessments?orgId=${orgId}${classId ? `&classId=${classId}` : ""}`), [orgId, classId]);
  const [subjects] = useLoad(() => api(`/api/orgs/education/subjects?orgId=${orgId}`), [orgId]);
  const classBy = new Map(classes.map((c) => [String(c._id), c.label]));
  if (open) return <MarksSheet orgId={orgId} assessmentId={open} isPrincipal={isPrincipal} onBack={() => { setOpen(null); load(); }} />;
  async function create(e) {
    e.preventDefault();
    try { await api("/api/orgs/education/assessments", { method: "POST", body: JSON.stringify({ orgId, ...f, subjectId: f.subjectId || null }) }); setShow(false); load(); } catch (err) { setError(err.message); }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <ClassSelect classes={classes} value={classId} onChange={setClassId} />
        <button className={`${primary} ml-auto`} onClick={() => setShow((v) => !v)}>+ New assessment</button>
      </div>
      {show && (
        <form onSubmit={create} className={`${panel} grid grid-cols-1 md:grid-cols-3 gap-2`}>
          <ClassSelect classes={classes} value={f.classId} onChange={(v) => setF((x) => ({ ...x, classId: v }))} allLabel="Class" />
          <select aria-label="Subject" value={f.subjectId} onChange={(e) => setF((x) => ({ ...x, subjectId: e.target.value }))} className={input}><option value="">Subject</option>{(subjects?.subjects || []).map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}</select>
          <input aria-label="Assessment name" required value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} placeholder="Mid-term, Unit test 2…" className={input} />
          <input aria-label="Term" value={f.term} onChange={(e) => setF((x) => ({ ...x, term: e.target.value }))} placeholder="Term (e.g. Term 1)" className={input} />
          <input aria-label="Maximum marks" type="number" min="1" value={f.maxMarks} onChange={(e) => setF((x) => ({ ...x, maxMarks: e.target.value }))} className={input} />
          <input aria-label="Date" type="date" value={f.date} onChange={(e) => setF((x) => ({ ...x, date: e.target.value }))} className={input} />
          <div className="md:col-span-3"><button className={primary} disabled={!f.classId || !f.name.trim()}>Create</button></div>
        </form>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className={panel}>
        {!list ? <p className={muted}>Loading…</p> : list.assessments.length === 0 ? <EmptyState compact icon="📊" description="No assessments yet." ctaLabel="Create one" onCta={() => setShow(true)} /> : (
          <div className="space-y-2">{list.assessments.map((a) => (
            <div key={a._id} className={row}>
              <div><span className="text-sm text-[var(--inaya-text-primary)]">{a.name}{a.subjectName ? ` · ${a.subjectName}` : ""}</span><p className={`${muted} font-mono`}>{classBy.get(String(a.classId)) || ""} · {a.term || "no term"} · out of {a.maxMarks} · {a.status === "PUBLISHED" ? "published" : "draft"}</p></div>
              <button className={ghost} onClick={() => setOpen(a._id)}>{a.status === "PUBLISHED" ? "View" : "Enter marks"}</button>
            </div>
          ))}</div>
        )}
      </div>
    </div>
  );
}

function MarksSheet({ orgId, assessmentId, isPrincipal, onBack }) {
  const [d, load, error, setError] = useLoad(() => api(`/api/orgs/education/assessments/${assessmentId}?orgId=${orgId}`), [orgId, assessmentId]);
  const [vals, setVals] = useState({});
  const [msg, setMsg] = useState("");
  useEffect(() => { if (d) setVals(Object.fromEntries(d.rows.map((r) => [r.studentId, r.absent ? "AB" : r.marks ?? ""]))); }, [d]);
  if (!d) return <div className="space-y-2"><button className={ghost} onClick={onBack}>← Back</button>{error ? <p className="text-red-400 text-xs">{error}</p> : <p className={muted}>Loading…</p>}</div>;
  const published = d.assessment.status === "PUBLISHED";
  const entries = () => d.rows.map((r) => { const v = String(vals[r.studentId] ?? "").trim().toUpperCase(); return { studentId: r.studentId, absent: v === "AB", marks: v === "AB" || v === "" ? null : Number(v) }; });
  async function save() { try { setMsg(""); const r = await api(`/api/orgs/education/assessments/${assessmentId}/marks`, { method: "PUT", body: JSON.stringify({ orgId, entries: entries() }) }); setMsg(`Saved ${r.saved}.`); load(); } catch (err) { setError(err.message); } }
  async function publish() { if (!window.confirm("Publish these results? Marks are locked after publishing; changes then need a reason.")) return; try { await api(`/api/orgs/education/assessments/${assessmentId}/publish`, { method: "POST", body: JSON.stringify({ orgId }) }); load(); } catch (err) { setError(err.message); } }
  async function amend(r) {
    const v = window.prompt(`New mark for ${r.fullName} (out of ${d.assessment.maxMarks}, or AB for absent)`); if (v === null) return;
    const reason = window.prompt("Reason for changing a published mark"); if (!reason) return;
    try { const up = v.trim().toUpperCase(); await api(`/api/orgs/education/assessments/${assessmentId}/amend`, { method: "POST", body: JSON.stringify({ orgId, studentId: r.studentId, absent: up === "AB", marks: up === "AB" ? null : Number(up), reason }) }); load(); } catch (err) { setError(err.message); }
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><button className={ghost} onClick={onBack}>← Back</button>{msg && <span className="text-emerald-400 text-xs">{msg}</span>}{error && <span className="text-red-400 text-xs">{error}</span>}</div>
      <div className={panel}>
        <p className={h3}>{d.assessment.name}{d.assessment.subjectName ? ` · ${d.assessment.subjectName}` : ""} · out of {d.assessment.maxMarks} · {published ? "published (locked)" : "draft"}</p>
        <p className={`${muted} mb-3`}>Type AB for absent. Parents only see results after they are published.</p>
        <div className="space-y-2">{d.rows.map((r) => (
          <div key={r.studentId} className={row}>
            <span className="text-sm text-[var(--inaya-text-primary)]">{r.fullName} <span className={`${muted} font-mono`}>{r.admissionNo}</span>{r.amended && <span className="text-amber-400 text-[11px] ml-2">amended</span>}</span>
            {published ? (
              <span className="flex items-center gap-2 text-sm text-[var(--inaya-text-primary)]">{r.absent ? "AB" : r.marks ?? "—"}{isPrincipal && <button className={ghost} onClick={() => amend(r)}>Amend</button>}</span>
            ) : (
              <input aria-label={`Marks for ${r.fullName}`} value={vals[r.studentId] ?? ""} onChange={(e) => setVals((x) => ({ ...x, [r.studentId]: e.target.value }))} className={`${input} w-24 text-right`} />
            )}
          </div>
        ))}</div>
        {!published && d.rows.length > 0 && <div className="flex gap-2 mt-3"><button className={primary} onClick={save}>Save marks</button>{isPrincipal && <button className={ghost} onClick={publish}>Publish results</button>}</div>}
      </div>
    </div>
  );
}

// ============================================================
// FEES
// ============================================================
function FeesTab({ orgId, classes, options, isFees, isPrincipal, email }) {
  const SUB = [["invoices", "Invoices"], ["defaulters", "Overdue"], ["payments", "Payments"], ["structures", "Fee structures"], ["concessions", "Concessions"]];
  const [sub, setSub] = useState("invoices");
  const [settings] = useLoad(() => api(`/api/orgs/education/settings?orgId=${orgId}`).then((d) => d.settings), [orgId]);
  if (!isFees) return <p className={`${panel} ${muted}`}>Fees are handled by accounts staff and the principal.</p>;
  const currency = settings?.currency || "PKR";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1">{SUB.map(([k, t]) => <button key={k} onClick={() => setSub(k)} className={`text-[11px] font-bold uppercase px-3 py-1.5 rounded-lg border ${sub === k ? "border-[#00f2fe]/40 text-[#00f2fe]" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{t}</button>)}</div>
      <p className={muted}>Amounts are in {currency}. Fees are recorded here, not collected online. Payments can&apos;t be deleted, only reversed by the principal with a reason.</p>
      {sub === "invoices" && <InvoicesPanel orgId={orgId} classes={classes} options={options} currency={currency} isPrincipal={isPrincipal} />}
      {sub === "defaulters" && <DefaultersPanel orgId={orgId} classes={classes} />}
      {sub === "payments" && <PaymentsPanel orgId={orgId} isPrincipal={isPrincipal} schoolName={settings?.schoolName} />}
      {sub === "structures" && <StructuresPanel orgId={orgId} classes={classes} options={options} currency={currency} isPrincipal={isPrincipal} />}
      {sub === "concessions" && <ConcessionsPanel orgId={orgId} options={options} currency={currency} isPrincipal={isPrincipal} email={email} />}
    </div>
  );
}

function InvoicesPanel({ orgId, classes, options, isPrincipal }) {
  const [filters, setFilters] = useState({ status: "", classId: "", period: "" });
  const qs = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("");
  const [d, load, error, setError] = useLoad(() => api(`/api/orgs/education/invoices?orgId=${orgId}${qs}`), [orgId, qs]);
  const [paying, setPaying] = useState(null);
  const [pay, setPay] = useState({ amount: "", method: "cash", reference: "", paidOn: today() });
  const [msg, setMsg] = useState("");
  async function record(inv) {
    try {
      const r = await api("/api/orgs/education/payments", { method: "POST", body: JSON.stringify({ orgId, invoiceId: inv._id, amountMinor: toMinor(pay.amount), method: pay.method, reference: pay.reference, paidOn: pay.paidOn }) });
      setMsg(`Receipt ${r.payment.receiptNo} recorded.`); setPaying(null); load();
    } catch (err) { setError(err.message); }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <select aria-label="Invoice status" value={filters.status} onChange={(e) => setFilters((x) => ({ ...x, status: e.target.value }))} className={input}><option value="">Any status</option>{["unpaid", "partial", "paid", "cancelled"].map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <ClassSelect classes={classes} value={filters.classId} onChange={(v) => setFilters((x) => ({ ...x, classId: v }))} />
        <input aria-label="Period" value={filters.period} onChange={(e) => setFilters((x) => ({ ...x, period: e.target.value }))} placeholder="Period, e.g. 2026-11" className={input} />
        {isPrincipal && <button className={ghost} onClick={async () => { try { const r = await api("/api/orgs/education/invoices/late-fees", { method: "POST", body: JSON.stringify({ orgId }) }); setMsg(`Late fee added to ${r.applied} overdue invoice(s).`); load(); } catch (err) { setError(err.message); } }}>Add late fees to overdue</button>}
        {msg && <span className="text-emerald-400 text-xs">{msg}</span>}
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className={panel}>
        {!d ? <p className={muted}>Loading…</p> : d.invoices.length === 0 ? <p className={muted}>No invoices. Create a fee structure, then generate invoices for a period.</p> : (
          <div className="space-y-2">{d.invoices.map((i) => (
            <div key={i._id} className="bg-black/20 border border-white/5 rounded-lg p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><span className="text-sm text-[var(--inaya-text-primary)]">{i.studentName}</span><p className={`${muted} font-mono`}>{i.invoiceNo} · {i.admissionNo} · {i.classLabel || ""} · {i.period} · due {i.dueDate}</p></div>
                <div className="flex items-center gap-2"><span className="text-sm text-[var(--inaya-text-primary)]">{money(i.paidMinor, i.currency)} / {money(i.totalMinor, i.currency)}</span><span className={`text-[11px] uppercase ${i.status === "paid" ? "text-emerald-400" : i.status === "cancelled" ? muted : "text-amber-400"}`}>{i.status}</span>
                  {["unpaid", "partial"].includes(i.status) && <button className={ghost} onClick={() => { setPaying(i._id); setPay({ amount: ((i.totalMinor - i.paidMinor) / 100).toFixed(2), method: "cash", reference: "", paidOn: today() }); }}>Record payment</button>}
                  {isPrincipal && i.status === "unpaid" && i.paidMinor === 0 && <button className={ghost} onClick={async () => { const reason = window.prompt("Reason for cancelling this invoice"); if (!reason) return; try { await api(`/api/orgs/education/invoices/${i._id}/cancel`, { method: "POST", body: JSON.stringify({ orgId, reason }) }); load(); } catch (err) { setError(err.message); } }}>Cancel</button>}
                </div>
              </div>
              {paying === i._id && (
                <div className="flex flex-wrap gap-2 mt-2">
                  <input aria-label="Amount" type="number" step="0.01" min="0.01" value={pay.amount} onChange={(e) => setPay((x) => ({ ...x, amount: e.target.value }))} className={`${input} w-32`} />
                  <select aria-label="Method" value={pay.method} onChange={(e) => setPay((x) => ({ ...x, method: e.target.value }))} className={input}>{(options?.paymentMethods || []).map((m) => <option key={m} value={m}>{label(m)}</option>)}</select>
                  <input aria-label="Reference" value={pay.reference} onChange={(e) => setPay((x) => ({ ...x, reference: e.target.value }))} placeholder={pay.method === "cash" ? "Reference (optional)" : "Bank / cheque / transaction ref"} className={input} />
                  <input aria-label="Paid on" type="date" max={today()} value={pay.paidOn} onChange={(e) => setPay((x) => ({ ...x, paidOn: e.target.value }))} className={input} />
                  <button className={primary} onClick={() => record(i)}>Save &amp; issue receipt</button>
                  <button className={ghost} onClick={() => setPaying(null)}>Close</button>
                </div>
              )}
            </div>
          ))}</div>
        )}
      </div>
    </div>
  );
}

function DefaultersPanel({ orgId, classes }) {
  const [classId, setClassId] = useState("");
  const [d, , error] = useLoad(() => api(`/api/orgs/education/defaulters?orgId=${orgId}${classId ? `&classId=${classId}` : ""}`), [orgId, classId]);
  return (
    <div className="space-y-3">
      <ClassSelect classes={classes} value={classId} onChange={setClassId} />
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className={panel}>
        {!d ? <p className={muted}>Loading…</p> : d.defaulters.length === 0 ? <p className={muted}>No overdue fees as of {d.asOf}.</p> : (
          <div className="space-y-2">{d.defaulters.map((r) => (
            <div key={r.studentId} className={row}>
              <div><span className="text-sm text-[var(--inaya-text-primary)]">{r.studentName}</span><p className={`${muted} font-mono`}>{r.admissionNo} · {r.classLabel || ""} · {r.invoices} invoice(s) · oldest due {r.oldestDue} ({r.daysOverdue} days)</p></div>
              <span className="text-amber-400 text-sm font-semibold">{money(r.outstandingMinor, r.currency)}</span>
            </div>
          ))}</div>
        )}
      </div>
    </div>
  );
}

function PaymentsPanel({ orgId, isPrincipal, schoolName }) {
  const [d, load, error, setError] = useLoad(() => api(`/api/orgs/education/payments?orgId=${orgId}`), [orgId]);
  async function printReceipt(id) {
    try {
      const { receipt: r } = await api(`/api/orgs/education/payments/${id}/receipt?orgId=${orgId}`);
      const w = window.open("", "_blank", "width=480,height=640"); if (!w) return;
      const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
      w.document.write(`<html><head><title>${esc(r.receiptNo)}</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#111}td{padding:4px 8px}h2{margin:0}</style></head><body>
        <h2>${esc(r.schoolName || schoolName)}</h2><p>Fee receipt <b>${esc(r.receiptNo)}</b>${r.status === "reversed" ? " — <b style='color:#b00'>REVERSED</b>" : ""}</p>
        <table><tr><td>Student</td><td>${esc(r.studentName)} (${esc(r.admissionNo)})</td></tr><tr><td>Invoice</td><td>${esc(r.invoiceNo)} · ${esc(r.invoice?.period)}</td></tr>
        <tr><td>Amount received</td><td><b>${esc(money(r.amountMinor, r.currency))}</b></td></tr><tr><td>Method</td><td>${esc(label(r.method))}${r.reference ? ` · ${esc(r.reference)}` : ""}</td></tr>
        <tr><td>Date</td><td>${esc(r.paidOn)}</td></tr><tr><td>Balance on invoice</td><td>${esc(money(r.invoice?.balanceMinor, r.currency))}</td></tr><tr><td>Received by</td><td>${esc(r.recordedByEmail)}</td></tr></table>
        <script>window.print()</script></body></html>`);
      w.document.close();
    } catch (err) { setError(err.message); }
  }
  return (
    <div className={panel}>
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      {!d ? <p className={muted}>Loading…</p> : d.payments.length === 0 ? <p className={muted}>No payments recorded yet.</p> : (
        <div className="space-y-2">{d.payments.map((p) => (
          <div key={p._id} className={row}>
            <div><span className="text-sm text-[var(--inaya-text-primary)]">{p.studentName} · {money(p.amountMinor, p.currency)}</span><p className={`${muted} font-mono`}>{p.receiptNo} · {p.invoiceNo} · {label(p.method)}{p.reference ? ` · ${p.reference}` : ""} · {p.paidOn} · {p.status}</p></div>
            <div className="flex gap-2">
              <button className={ghost} onClick={() => printReceipt(p._id)}>Receipt</button>
              {isPrincipal && p.status === "posted" && <button className={ghost} onClick={async () => { const reason = window.prompt("Reason for reversing this payment (e.g. cheque bounced)"); if (!reason) return; try { await api(`/api/orgs/education/payments/${p._id}/reverse`, { method: "POST", body: JSON.stringify({ orgId, reason }) }); load(); } catch (err) { setError(err.message); } }}>Reverse</button>}
            </div>
          </div>
        ))}</div>
      )}
    </div>
  );
}

function StructuresPanel({ orgId, classes, options, currency, isPrincipal }) {
  const [d, load, error, setError] = useLoad(() => api(`/api/orgs/education/fee-structures?orgId=${orgId}`), [orgId]);
  const [f, setF] = useState({ name: "", classId: "", frequency: "monthly", heads: [{ name: "Tuition", amount: "" }] });
  const [gen, setGen] = useState({ id: null, period: new Date().toISOString().slice(0, 7), dueDate: `${new Date().toISOString().slice(0, 7)}-10` });
  const [msg, setMsg] = useState("");
  const classBy = new Map(classes.map((c) => [String(c._id), c.label]));
  async function create(e) {
    e.preventDefault();
    try { await api("/api/orgs/education/fee-structures", { method: "POST", body: JSON.stringify({ orgId, name: f.name, classId: f.classId || null, frequency: f.frequency, heads: f.heads.filter((h) => h.name && h.amount).map((h) => ({ name: h.name, amountMinor: toMinor(h.amount) })) }) }); setF({ name: "", classId: "", frequency: "monthly", heads: [{ name: "Tuition", amount: "" }] }); load(); } catch (err) { setError(err.message); }
  }
  async function generate(id) {
    try { const r = await api(`/api/orgs/education/fee-structures/${id}/generate`, { method: "POST", body: JSON.stringify({ orgId, period: gen.period, dueDate: gen.dueDate }) }); setMsg(`${r.created} invoice(s) created, ${r.skipped} already existed.`); setGen((g) => ({ ...g, id: null })); } catch (err) { setError(err.message); }
  }
  return (
    <div className="space-y-3">
      {isPrincipal && (
        <form onSubmit={create} className={`${panel} space-y-2`}>
          <p className={h3}>New fee structure</p>
          <div className="flex flex-wrap gap-2">
            <input aria-label="Structure name" required value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} placeholder="e.g. Grade 5 monthly fee 2026-27" className={`${input} flex-1 min-w-[200px]`} />
            <ClassSelect classes={classes} value={f.classId} onChange={(v) => setF((x) => ({ ...x, classId: v }))} allLabel="All classes" />
            <select aria-label="Frequency" value={f.frequency} onChange={(e) => setF((x) => ({ ...x, frequency: e.target.value }))} className={input}>{(options?.frequencies || []).map((q) => <option key={q} value={q}>{label(q)}</option>)}</select>
          </div>
          {f.heads.map((h, i) => (
            <div key={i} className="flex gap-2">
              <input aria-label="Fee head" value={h.name} onChange={(e) => setF((x) => ({ ...x, heads: x.heads.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) }))} placeholder="Fee head (Tuition, Transport, Lab…)" className={`${input} flex-1`} />
              <input aria-label="Amount" type="number" step="0.01" min="0" value={h.amount} onChange={(e) => setF((x) => ({ ...x, heads: x.heads.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)) }))} placeholder={`Amount (${currency})`} className={`${input} w-40`} />
            </div>
          ))}
          <div className="flex gap-2"><button type="button" className={ghost} onClick={() => setF((x) => ({ ...x, heads: [...x.heads, { name: "", amount: "" }] }))}>+ Fee head</button><button className={primary}>Save structure</button></div>
        </form>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}{msg && <p className="text-emerald-400 text-xs">{msg}</p>}
      <div className={panel}>
        {!d ? <p className={muted}>Loading…</p> : d.structures.length === 0 ? <p className={muted}>No fee structures yet{isPrincipal ? "" : " — the principal sets these up"}.</p> : (
          <div className="space-y-2">{d.structures.map((s) => (
            <div key={s._id} className="bg-black/20 border border-white/5 rounded-lg p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><span className="text-sm text-[var(--inaya-text-primary)]">{s.name}</span><p className={`${muted} font-mono`}>{s.classId ? classBy.get(String(s.classId)) : "all classes"} · {label(s.frequency)} · {s.heads.map((h) => `${h.name} ${money(h.amountMinor, s.currency)}`).join(" + ")} = {money(s.totalMinor, s.currency)}</p></div>
                <button className={ghost} onClick={() => setGen((g) => ({ ...g, id: g.id === s._id ? null : s._id }))}>Generate invoices</button>
              </div>
              {gen.id === s._id && (
                <div className="flex flex-wrap gap-2 mt-2 items-center">
                  <input aria-label="Period" value={gen.period} onChange={(e) => setGen((g) => ({ ...g, period: e.target.value }))} placeholder="2026-11 or 2026-T1" className={input} />
                  <label className={muted}>Due <input aria-label="Due date" type="date" value={gen.dueDate} onChange={(e) => setGen((g) => ({ ...g, dueDate: e.target.value }))} className={input} /></label>
                  <button className={primary} onClick={() => generate(s._id)}>Generate for enrolled students</button>
                  <span className={muted}>Running it again for the same period never bills a student twice.</span>
                </div>
              )}
            </div>
          ))}</div>
        )}
      </div>
    </div>
  );
}

function ConcessionsPanel({ orgId, options, currency, isPrincipal, email }) {
  const [d, load, error, setError] = useLoad(() => api(`/api/orgs/education/concessions?orgId=${orgId}`), [orgId]);
  const [students] = useLoad(() => api(`/api/orgs/education/students?orgId=${orgId}&status=enrolled`), [orgId]);
  const [f, setF] = useState({ studentId: "", kind: "sibling", mode: "percent", value: "", reason: "" });
  async function create(e) {
    e.preventDefault();
    try { await api("/api/orgs/education/concessions", { method: "POST", body: JSON.stringify({ orgId, studentId: f.studentId, kind: f.kind, reason: f.reason, ...(f.mode === "percent" ? { percent: Number(f.value) } : { amountMinor: toMinor(f.value) }) }) }); setF((x) => ({ ...x, value: "", reason: "" })); load(); } catch (err) { setError(err.message); }
  }
  const decide = (id, approve) => api(`/api/orgs/education/concessions/${id}/decide`, { method: "POST", body: JSON.stringify({ orgId, approve }) }).then(load).catch((e) => setError(e.message));
  return (
    <div className="space-y-3">
      <form onSubmit={create} className={`${panel} flex flex-wrap gap-2`}>
        <select aria-label="Student" required value={f.studentId} onChange={(e) => setF((x) => ({ ...x, studentId: e.target.value }))} className={input}><option value="">Student</option>{(students?.students || []).map((s) => <option key={s._id} value={s._id}>{s.fullName} ({s.admissionNo})</option>)}</select>
        <select aria-label="Kind" value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value }))} className={input}>{(options?.concessionKinds || []).map((k) => <option key={k} value={k}>{label(k)}</option>)}</select>
        <select aria-label="Type" value={f.mode} onChange={(e) => setF((x) => ({ ...x, mode: e.target.value }))} className={input}><option value="percent">% off</option><option value="amount">Fixed amount off ({currency})</option></select>
        <input aria-label="Value" type="number" step="0.01" min="0" required value={f.value} onChange={(e) => setF((x) => ({ ...x, value: e.target.value }))} className={`${input} w-28`} />
        <input aria-label="Reason" required value={f.reason} onChange={(e) => setF((x) => ({ ...x, reason: e.target.value }))} placeholder="Reason" className={`${input} flex-1 min-w-[160px]`} />
        <button className={primary}>Request</button>
      </form>
      <p className={muted}>A concession applies to invoices generated after it is approved. The person who requests it can&apos;t approve it.</p>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className={panel}>
        {!d ? <p className={muted}>Loading…</p> : d.concessions.length === 0 ? <p className={muted}>No concessions.</p> : (
          <div className="space-y-2">{d.concessions.map((c) => (
            <div key={c._id} className={row}>
              <div><span className="text-sm text-[var(--inaya-text-primary)]">{c.studentName} · {label(c.kind)} · {c.percent !== null ? `${c.percent}%` : money(c.amountMinor, currency)}</span><p className={`${muted}`}>{c.reason} · {c.status.toLowerCase()} · requested by {c.requestedByEmail}</p></div>
              <div className="flex gap-2">
                {isPrincipal && c.status === "REQUESTED" && c.requestedByEmail !== email && <><button className={ghost} onClick={() => decide(c._id, true)}>Approve</button><button className={ghost} onClick={() => decide(c._id, false)}>Reject</button></>}
                {isPrincipal && c.status === "APPROVED" && <button className={ghost} onClick={() => api(`/api/orgs/education/concessions/${c._id}/end`, { method: "POST", body: JSON.stringify({ orgId }) }).then(load).catch((e) => setError(e.message))}>End</button>}
              </div>
            </div>
          ))}</div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// SETUP
// ============================================================
function SetupTab({ orgId, classes, reloadClasses, options, canManage, isPrincipal }) {
  const [settings, loadSettings, error, setError] = useLoad(() => api(`/api/orgs/education/settings?orgId=${orgId}`).then((d) => d.settings), [orgId]);
  const [years, loadYears] = useLoad(() => api(`/api/orgs/education/years?orgId=${orgId}`), [orgId]);
  const [subjects, loadSubjects] = useLoad(() => api(`/api/orgs/education/subjects?orgId=${orgId}`), [orgId]);
  const [staff, loadStaff] = useLoad(() => (isPrincipal ? api(`/api/orgs/education/staff-roles?orgId=${orgId}`) : Promise.resolve(null)), [orgId, isPrincipal]);
  const [msg, setMsg] = useState("");
  const [cf, setCf] = useState({ name: "", section: "", academicYearId: "", capacity: "" });
  const [yf, setYf] = useState({ name: "", startDate: "", endDate: "" });
  const [sf, setSf] = useState("");
  const [teach, setTeach] = useState({});
  const run = async (fn, done, after) => { try { setError(""); await fn(); setMsg(done); after?.(); } catch (err) { setError(err.message); } };
  if (!isPrincipal) return <p className={`${panel} ${muted}`}>School setup is managed by the principal, the owner or an admin.</p>;
  return (
    <div className="space-y-4">
      {error && <p className="text-red-400 text-xs">{error}</p>}{msg && <p className="text-emerald-400 text-xs">{msg}</p>}
      {settings && (
        <div className={panel}>
          <p className={h3}>School settings</p>
          <div className="flex flex-wrap gap-2 items-center">
            <select aria-label="Country" value={settings.country} onChange={(e) => run(() => api("/api/orgs/education/settings", { method: "PUT", body: JSON.stringify({ orgId, country: e.target.value }) }), "Country saved.", loadSettings)} className={input}>{Object.entries(options?.countries || {}).map(([k, v]) => <option key={k} value={k}>{v.name} ({v.currency})</option>)}</select>
            <select aria-label="Institution type" value={settings.institutionType} onChange={(e) => run(() => api("/api/orgs/education/settings", { method: "PUT", body: JSON.stringify({ orgId, institutionType: e.target.value }) }), "Saved.", loadSettings)} className={input}>{(options?.institutionTypes || []).map((t) => <option key={t} value={t}>{label(t)}</option>)}</select>
            <label className={muted}>Receipt prefix <input aria-label="Receipt prefix" defaultValue={settings.receiptPrefix} onBlur={(e) => e.target.value !== settings.receiptPrefix && run(() => api("/api/orgs/education/settings", { method: "PUT", body: JSON.stringify({ orgId, receiptPrefix: e.target.value }) }), "Receipt prefix saved.", loadSettings)} className={`${input} w-24`} /></label>
            <label className={muted}>Late fee ({settings.currency}) <input aria-label="Late fee" type="number" min="0" step="0.01" defaultValue={(settings.lateFeeMinor / 100).toFixed(2)} onBlur={(e) => run(() => api("/api/orgs/education/settings", { method: "PUT", body: JSON.stringify({ orgId, lateFeeMinor: toMinor(e.target.value) }) }), "Late fee saved.", loadSettings)} className={`${input} w-28`} /></label>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className={panel}>
          <p className={h3}>Academic years</p>
          <div className="flex flex-wrap gap-2 mb-2">
            <input aria-label="Year name" value={yf.name} onChange={(e) => setYf((x) => ({ ...x, name: e.target.value }))} placeholder="2026-27" className={`${input} w-28`} />
            <input aria-label="Start" type="date" value={yf.startDate} onChange={(e) => setYf((x) => ({ ...x, startDate: e.target.value }))} className={input} />
            <input aria-label="End" type="date" value={yf.endDate} onChange={(e) => setYf((x) => ({ ...x, endDate: e.target.value }))} className={input} />
            <button className={primary} onClick={() => run(() => api("/api/orgs/education/years", { method: "POST", body: JSON.stringify({ orgId, ...yf, current: true }) }), "Academic year added.", () => { setYf({ name: "", startDate: "", endDate: "" }); loadYears(); })}>Add</button>
          </div>
          {(years?.years || []).map((y) => <p key={y._id} className="text-sm text-[var(--inaya-text-primary)]">{y.name} {y.current && <span className="text-emerald-400 text-[11px]">current</span>}</p>)}
        </div>
        <div className={panel}>
          <p className={h3}>Subjects</p>
          <div className="flex gap-2 mb-2"><input aria-label="Subject" value={sf} onChange={(e) => setSf(e.target.value)} placeholder="Mathematics" className={`${input} flex-1`} /><button className={primary} onClick={() => run(() => api("/api/orgs/education/subjects", { method: "POST", body: JSON.stringify({ orgId, name: sf }) }), "Subject added.", () => { setSf(""); loadSubjects(); })}>Add</button></div>
          <p className="text-sm text-[var(--inaya-text-primary)]">{(subjects?.subjects || []).map((s) => s.name).join(", ") || <span className={muted}>No subjects yet.</span>}</p>
        </div>
      </div>
      <div className={panel}>
        <p className={h3}>Classes and teachers</p>
        <div className="flex flex-wrap gap-2 mb-3">
          <input aria-label="Class name" value={cf.name} onChange={(e) => setCf((x) => ({ ...x, name: e.target.value }))} placeholder="Grade 5, O Level 1, FSc Part 1…" className={input} />
          <input aria-label="Section" value={cf.section} onChange={(e) => setCf((x) => ({ ...x, section: e.target.value }))} placeholder="Section (A, B…)" className={`${input} w-32`} />
          <select aria-label="Academic year" value={cf.academicYearId} onChange={(e) => setCf((x) => ({ ...x, academicYearId: e.target.value }))} className={input}><option value="">Academic year</option>{(years?.years || []).map((y) => <option key={y._id} value={y._id}>{y.name}</option>)}</select>
          <input aria-label="Capacity" type="number" min="1" value={cf.capacity} onChange={(e) => setCf((x) => ({ ...x, capacity: e.target.value }))} placeholder="Seats" className={`${input} w-24`} />
          <button className={primary} onClick={() => run(() => api("/api/orgs/education/classes", { method: "POST", body: JSON.stringify({ orgId, ...cf, academicYearId: cf.academicYearId || null, capacity: cf.capacity || null }) }), "Class added.", () => { setCf({ name: "", section: "", academicYearId: cf.academicYearId, capacity: "" }); reloadClasses(); })}>Add class</button>
        </div>
        {classes.length === 0 ? <p className={muted}>No classes yet.</p> : (
          <div className="space-y-2">{classes.map((c) => (
            <div key={c._id} className={row}>
              <div><span className="text-sm text-[var(--inaya-text-primary)]">{c.label}</span><p className={muted}>{c.enrolled} enrolled{c.capacity ? ` of ${c.capacity}` : ""} · teachers: {c.teachers.map((t) => `${t.email}${t.role === "class_teacher" ? " (class teacher)" : ""}`).join(", ") || "none"}</p></div>
              <div className="flex gap-2">
                <select aria-label="Teacher" value={teach[c._id] || ""} onChange={(e) => setTeach((x) => ({ ...x, [c._id]: e.target.value }))} className={input}><option value="">Assign teacher…</option>{(staff?.members || []).filter((m) => m.educationRole === "teacher" || m.educationRole === "principal").map((m) => <option key={m.email} value={m.email}>{m.email}</option>)}</select>
                <button className={ghost} disabled={!teach[c._id]} onClick={() => run(() => api(`/api/orgs/education/classes/${c._id}/teachers`, { method: "POST", body: JSON.stringify({ orgId, email: teach[c._id], role: c.teachers.length ? "subject_teacher" : "class_teacher" }) }), "Teacher assigned.", reloadClasses)}>Assign</button>
              </div>
            </div>
          ))}</div>
        )}
      </div>
      {staff && (
        <div className={panel}>
          <p className={h3}>Staff roles</p>
          <p className={`${muted} mb-2`}>Principal: everything. Admissions: applications and the student register. Accounts: fees and payments. Teacher: attendance and marks for their assigned classes only. {canManage ? "" : "Only the owner or an admin can change roles."}</p>
          <div className="space-y-2">{staff.members.map((m) => (
            <div key={m.email} className={row}>
              <span className="text-sm text-[var(--inaya-text-primary)]">{m.email} <span className={muted}>({m.role})</span></span>
              <select aria-label={`Education role for ${m.email}`} disabled={!canManage} value={m.educationRole || ""} onChange={(e) => run(() => api("/api/orgs/education/staff-roles", { method: "PUT", body: JSON.stringify({ orgId, email: m.email, educationRole: e.target.value || null }) }), "Role saved.", loadStaff)} className={input}>
                <option value="">No education role</option>{(staff.roles || []).map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          ))}</div>
        </div>
      )}
    </div>
  );
}
