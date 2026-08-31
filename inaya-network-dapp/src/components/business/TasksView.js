"use client";

// src/components/business/TasksView.js
//
// Tasks tab of the Business Workspace — Company -> Department -> Project ->
// Task, backed by /api/orgs/tasks/*. First full top-level view extracted
// out of business/page.js's own component tree (Dashboard/Approvals/
// Activity/AI Assistant/Browse all still live there) rather than a shared
// widget like WorkflowVisualization/AIWidget — this sets the pattern
// CRM/Procurement/Inventory should follow next: a self-contained view file
// with its own small `api()` fetch helper (duplicated on purpose, same
// reasoning business/page.js's header comment already gives for
// duplicating encryptData rather than exporting internals out of that
// file), taking {orgId, canManage, email} and nothing else from the shell.
//
// Every status change goes through POST /api/orgs/tasks/:id/transition,
// which is a thin wrapper over src/lib/task-workflow.js's atomic state
// machine — the buttons shown here are for UX clarity only, not the real
// access control (same relationship DocumentColumn's ACTIONS_BY_STATUS has
// to document-workflow.js).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import ConfirmButton from "./ConfirmButton";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_LABELS = { TODO: "To do", IN_PROGRESS: "In progress", BLOCKED: "Blocked", DONE: "Done", CANCELLED: "Cancelled" };
const STATUS_ORDER = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"];
const STATUS_STYLES = {
  TODO: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  IN_PROGRESS: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  BLOCKED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  DONE: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  CANCELLED: "bg-violet-400/10 text-violet-300 border-violet-400/30",
};
const PRIORITY_STYLES = {
  LOW: "text-[var(--inaya-text-muted)]",
  MEDIUM: "text-[#00f2fe]",
  HIGH: "text-amber-400",
  URGENT: "text-red-400",
};
// [action, label] — every transition here only requires department access
// server-side (task-workflow.js has no requiresManage), so unlike
// document actions this list isn't filtered by canManage.
const ACTIONS_BY_STATUS = {
  TODO: [["start", "Start"], ["cancel", "Cancel"]],
  IN_PROGRESS: [["block", "Block"], ["complete", "Complete"], ["cancel", "Cancel"]],
  BLOCKED: [["resume", "Resume"], ["cancel", "Cancel"]],
  DONE: [["reopen", "Reopen"]],
  CANCELLED: [],
};

function isOverdue(task) {
  return task.dueDate && new Date(task.dueDate).getTime() < Date.now() && !["DONE", "CANCELLED"].includes(task.status);
}

function formatDueDate(dueDate) {
  if (!dueDate) return null;
  return new Date(dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function TasksView({ orgId, canManage, email }) {
  const [departments, setDepartments] = useState([]);
  const [filterDeptId, setFilterDeptId] = useState("");
  const [filterProjects, setFilterProjects] = useState([]);
  const [filterProjectId, setFilterProjectId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);

  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState(null);

  useEffect(() => {
    api(`/api/orgs/departments?orgId=${orgId}`).then((d) => setDepartments(d.departments)).catch((err) => setError(err.message));
  }, [orgId]);

  useEffect(() => {
    if (!filterDeptId) {
      setFilterProjects([]);
      setFilterProjectId("");
      return;
    }
    api(`/api/orgs/projects?orgId=${orgId}&departmentId=${filterDeptId}`)
      .then((d) => { setFilterProjects(d.projects); setError(""); })
      .catch((err) => { setFilterProjects([]); setError(`Couldn't load projects: ${err.message}`); });
    setFilterProjectId("");
  }, [orgId, filterDeptId]);

  const loadTasks = useCallback(async () => {
    try {
      const params = new URLSearchParams({ orgId });
      if (filterDeptId) params.set("departmentId", filterDeptId);
      if (filterProjectId) params.set("projectId", filterProjectId);
      if (statusFilter) params.set("status", statusFilter);
      if (mineOnly) params.set("assigneeEmail", email);
      if (overdueOnly) params.set("overdue", "true");
      const data = await api(`/api/orgs/tasks?${params.toString()}`);
      setTasks(data.tasks);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, filterDeptId, filterProjectId, statusFilter, mineOnly, overdueOnly, email]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const byStatus = {};
  if (tasks) for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <select value={filterDeptId} onChange={(e) => setFilterDeptId(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">All departments</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={filterProjectId} onChange={(e) => setFilterProjectId(e.target.value)} disabled={!filterDeptId} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40">
          <option value="">All projects</option>
          {filterProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Any status</option>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <button
          onClick={() => setMineOnly((v) => !v)}
          className={`text-[11px] font-bold uppercase px-2.5 py-2 rounded-lg border ${mineOnly ? "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30" : "bg-black/45 text-[var(--inaya-text-muted)] border-white/15"}`}
        >
          My tasks
        </button>
        <button
          onClick={() => setOverdueOnly((v) => !v)}
          className={`text-[11px] font-bold uppercase px-2.5 py-2 rounded-lg border ${overdueOnly ? "bg-red-400/10 text-red-400 border-red-400/30" : "bg-black/45 text-[var(--inaya-text-muted)] border-white/15"}`}
        >
          Overdue
        </button>
        <button
          onClick={() => setShowCreate(true)}
          className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg"
        >
          + New task
        </button>
      </div>

      {tasks && tasks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {STATUS_ORDER.filter((s) => byStatus[s]).map((s) => (
            <span key={s} className={`text-[11px] font-bold uppercase px-2.5 py-1 rounded-full border ${STATUS_STYLES[s]}`}>
              {byStatus[s]} {STATUS_LABELS[s]}
            </span>
          ))}
        </div>
      )}

      {error && <p className="text-red-400 text-xs">{error}</p>}

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!tasks ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : tasks.length === 0 ? (
          <EmptyState compact icon="✅" description="No tasks match these filters." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} onOpen={() => setSelectedTaskId(t.id)} />
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateTaskModal
          orgId={orgId}
          departments={departments}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadTasks(); }}
        />
      )}

      {selectedTaskId && (
        <TaskDetailModal
          orgId={orgId}
          taskId={selectedTaskId}
          canManage={canManage}
          email={email}
          onClose={() => setSelectedTaskId(null)}
          onChanged={loadTasks}
        />
      )}
    </div>
  );
}

function TaskRow({ task, onOpen }) {
  const overdue = isOverdue(task);
  return (
    <button onClick={onOpen} className="w-full flex items-start justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-bold uppercase ${PRIORITY_STYLES[task.priority]}`}>●</span>
          <span className="text-[var(--inaya-text-primary)] text-sm truncate">{task.title}</span>
        </div>
        <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5 truncate">
          {task.departmentName || task.projectName ? `${task.departmentName || ""}` : null}
          {task.assigneeEmail ? ` · ${task.assigneeEmail}` : " · Unassigned"}
          {task.dueDate ? ` · ${overdue ? "Overdue " : "Due "}${formatDueDate(task.dueDate)}` : ""}
        </p>
      </div>
      <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${STATUS_STYLES[task.status]}`}>
        {STATUS_LABELS[task.status]}
      </span>
    </button>
  );
}

function CreateTaskModal({ orgId, departments, onClose, onCreated }) {
  const [departmentId, setDepartmentId] = useState("");
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [assigneeEmail, setAssigneeEmail] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!departmentId) { setProjects([]); setProjectId(""); return; }
    api(`/api/orgs/projects?orgId=${orgId}&departmentId=${departmentId}`).then((d) => { setProjects(d.projects); setError(""); }).catch((err) => { setProjects([]); setError(`Couldn't load projects: ${err.message}`); });
    setProjectId("");
  }, [orgId, departmentId]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!projectId || !title.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/tasks", {
        method: "POST",
        body: JSON.stringify({
          orgId, projectId, title: title.trim(),
          description: description.trim() || undefined,
          priority,
          assigneeEmail: assigneeEmail.trim() || undefined,
          dueDate: dueDate || undefined,
        }),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal onClose={onClose} title="New task">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
            <option value="">Department…</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required disabled={!departmentId} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40">
            <option value="">Project…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="Task title" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" rows={3} className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab] resize-none" />
        <div className="grid grid-cols-2 gap-2">
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
            <option value="LOW">Low priority</option>
            <option value="MEDIUM">Medium priority</option>
            <option value="HIGH">High priority</option>
            <option value="URGENT">Urgent</option>
          </select>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
        </div>
        <input value={assigneeEmail} onChange={(e) => setAssigneeEmail(e.target.value)} type="email" placeholder="Assignee email (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />

        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !projectId || !title.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
          {submitting ? "Creating…" : "Create task"}
        </button>
      </form>
    </Modal>
  );
}

function TaskDetailModal({ orgId, taskId, canManage, email, onClose, onChanged }) {
  const [task, setTask] = useState(null);
  const [activity, setActivity] = useState(null);
  const [acting, setActing] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/tasks/${taskId}?orgId=${orgId}`);
      setTask(data);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, taskId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api(`/api/orgs/tasks/${taskId}/activity?orgId=${orgId}`).then((d) => setActivity(d.activity)).catch(() => setActivity([]));
  }, [orgId, taskId]);

  const canEdit = task && (canManage || task.createdByEmail === email || task.assigneeEmail === email);

  async function handleAction(action) {
    setActing(action);
    setError("");
    try {
      await api(`/api/orgs/tasks/${taskId}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  if (!task) {
    return (
      <Modal onClose={onClose} title="Task">
        {error ? <p className="text-red-400 text-xs">{error}</p> : <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>}
      </Modal>
    );
  }

  const overdue = isOverdue(task);
  const availableActions = ACTIONS_BY_STATUS[task.status] || [];

  return (
    <Modal onClose={onClose} title={task.title}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_STYLES[task.status]}`}>{STATUS_LABELS[task.status]}</span>
          <span className={`text-[11px] font-bold uppercase ${PRIORITY_STYLES[task.priority]}`}>{task.priority}</span>
          {task.dueDate && (
            <span className={`text-[11px] font-mono ${overdue ? "text-red-400" : "text-[var(--inaya-text-muted)]"}`}>
              {overdue ? "Overdue — " : "Due "}{formatDueDate(task.dueDate)}
            </span>
          )}
        </div>

        {task.description && <p className="text-slate-300 text-sm whitespace-pre-wrap">{task.description}</p>}

        <div className="text-[12px] font-mono text-[var(--inaya-text-muted)] space-y-0.5">
          <p>Assignee: {task.assigneeEmail || "Unassigned"}</p>
          <p>Created by {task.createdByEmail}</p>
        </div>

        {availableActions.length > 0 && (canEdit || !canManage) && (
          <div className="flex flex-wrap gap-1.5">
            {availableActions.map(([action, label]) =>
              action === "cancel" ? (
                <ConfirmButton
                  key={action}
                  onConfirm={() => handleAction(action)}
                  disabled={!!acting}
                  className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 disabled:opacity-40"
                >
                  {acting === action ? "…" : label}
                </ConfirmButton>
              ) : (
                <button
                  key={action}
                  onClick={() => handleAction(action)}
                  disabled={!!acting}
                  className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 disabled:opacity-40"
                >
                  {acting === action ? "…" : label}
                </button>
              )
            )}
          </div>
        )}

        {error && <p className="text-red-400 text-xs">{error}</p>}

        <div>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-[var(--inaya-text-muted)] mb-2">History</h4>
          {!activity ? (
            <p className="text-[var(--inaya-text-muted)] font-mono text-xs">Loading…</p>
          ) : activity.length === 0 ? (
            <p className="text-[#8a96ab] text-xs italic">No activity yet.</p>
          ) : (
            <div className="space-y-2">
              {activity.map((e) => (
                <div key={e.eventId} className="text-xs border-b border-white/5 pb-2 last:border-0 last:pb-0">
                  <span className="text-slate-200">{e.action.replaceAll("_", " ").toLowerCase()}</span>
                  {e.previousState && <span className="text-[var(--inaya-text-muted)] font-mono"> · {e.previousState} → {e.newState}</span>}
                  <div className="text-[11px] font-mono text-[#8a96ab] mt-0.5">
                    {e.actorEmail} · {new Date(e.timestamp).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full max-w-md max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
