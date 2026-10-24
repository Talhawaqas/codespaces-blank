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
import Modal from "./ui/Modal";
import StatusBadge, { STATUS_TONE } from "./ui/StatusBadge";
import FormField from "./ui/FormField";
import RecordRow, { RecordList, RecordRows } from "./ui/RecordRow";
import RecordSharingPanel from "./RecordSharingPanel";
import { useErpCreate } from "./erp/ErpNavContext";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_LABELS = { TODO: "To do", IN_PROGRESS: "In progress", BLOCKED: "Blocked", DONE: "Done", CANCELLED: "Cancelled" };
const STATUS_ORDER = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"];
// This file's own CANCELLED was violet (not the shared StatusBadge
// default of neutral -- FinanceView/HRView use neutral for the same
// status, an inconsistency the audit itself found, see
// BUSINESS_WORKSPACE_UX_AUDIT.md #3.1) -- preserved via an explicit tone
// override below so migrating to the shared component changes nothing
// visually here.
const STATUS_TONE_OVERRIDE = { CANCELLED: "special" };
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

const CLOSED = ["DONE", "CANCELLED"];
const FREQUENCY_LABELS = { DAILY: "day", WEEKLY: "week", MONTHLY: "month" };

function describeRecurrence(r) {
  if (!r) return null;
  const unit = FREQUENCY_LABELS[r.frequency];
  return r.interval > 1 ? `Every ${r.interval} ${unit}s` : `Every ${unit}`;
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
  useErpCreate("list", () => setShowCreate(true));
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

  // Subtasks are listed under their parent only when the parent is in the
  // current (filtered) list; otherwise they'd vanish, e.g. from "My tasks".
  const byId = new Map((tasks || []).map((t) => [t.id, t]));
  const childrenOf = new Map();
  for (const t of tasks || []) {
    if (t.parentTaskId && byId.has(t.parentTaskId)) childrenOf.set(t.parentTaskId, [...(childrenOf.get(t.parentTaskId) || []), t]);
  }
  const topLevel = (tasks || []).filter((t) => !(t.parentTaskId && byId.has(t.parentTaskId)));
  const openBlockerCount = (t) => (t.blockedByTaskIds || []).filter((id) => byId.has(id) && !CLOSED.includes(byId.get(id).status)).length;

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
            <StatusBadge key={s} status={`${byStatus[s]} ${STATUS_LABELS[s]}`} tone={STATUS_TONE_OVERRIDE[s] || STATUS_TONE[s]} />
          ))}
        </div>
      )}

      {error && <p className="text-red-400 text-xs">{error}</p>}

      <RecordList>
        {!tasks ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : tasks.length === 0 ? (
          <EmptyState compact icon="✅" description="No tasks match these filters." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : (
          <RecordRows>
            {topLevel.map((t) => (
              <div key={t.id} className="space-y-2">
                <TaskRow task={t} subtaskCount={(childrenOf.get(t.id) || []).length} openBlockers={openBlockerCount(t)} orphanSubtask={!!t.parentTaskId} onOpen={() => setSelectedTaskId(t.id)} />
                {(childrenOf.get(t.id) || []).map((c) => (
                  <div key={c.id} className="pl-6 border-l border-white/10 ml-3">
                    <TaskRow task={c} subtaskCount={0} openBlockers={openBlockerCount(c)} onOpen={() => setSelectedTaskId(c.id)} />
                  </div>
                ))}
              </div>
            ))}
          </RecordRows>
        )}
      </RecordList>

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

function TaskRow({ task, onOpen, subtaskCount = 0, openBlockers = 0, orphanSubtask = false }) {
  const overdue = isOverdue(task);
  const repeat = describeRecurrence(task.recurrence);
  return (
    <RecordRow
      onClick={onOpen}
      left={
        <>
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-[10px] font-bold uppercase ${PRIORITY_STYLES[task.priority]}`}>●</span>
            <span className="text-[var(--inaya-text-primary)] text-sm truncate">{task.title}</span>
            {orphanSubtask && <span className="text-[10px] font-mono text-[var(--inaya-text-muted)] shrink-0">Subtask</span>}
            {subtaskCount > 0 && <span className="text-[10px] font-mono text-[var(--inaya-text-muted)] shrink-0">{subtaskCount} subtask{subtaskCount === 1 ? "" : "s"}</span>}
            {openBlockers > 0 && <span className="text-[10px] font-bold uppercase text-amber-400 shrink-0">Blocked by {openBlockers}</span>}
            {repeat && <span className="text-[10px] font-mono text-[#00f2fe] shrink-0" title={repeat}>↻ {repeat}</span>}
          </div>
          <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5 truncate">
            {task.departmentName || task.projectName ? `${task.departmentName || ""}` : null}
            {task.assigneeEmail ? ` · ${task.assigneeEmail}` : " · Unassigned"}
            {task.dueDate ? ` · ${overdue ? "Overdue " : "Due "}${formatDueDate(task.dueDate)}` : ""}
          </p>
        </>
      }
      right={<StatusBadge status={task.status} tone={STATUS_TONE_OVERRIDE[task.status]} />}
    />
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
  const [frequency, setFrequency] = useState("");
  const [repeatEvery, setRepeatEvery] = useState(1);
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
          recurrence: frequency ? { frequency, interval: Number(repeatEvery) || 1 } : undefined,
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
          <FormField label="Department" htmlFor="task-dept" required>
            <select id="task-dept" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
              <option value="">Department…</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </FormField>
          <FormField label="Project" htmlFor="task-project" required>
            <select id="task-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} required disabled={!departmentId} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40">
              <option value="">Project…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </FormField>
        </div>
        <FormField label="Title" htmlFor="task-title" required>
          <input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="Task title" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        </FormField>
        <FormField label="Description" htmlFor="task-description" hint="Optional">
          <textarea id="task-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" rows={3} className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab] resize-none" />
        </FormField>
        <div className="grid grid-cols-2 gap-2">
          <FormField label="Priority" htmlFor="task-priority">
            <select id="task-priority" value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
              <option value="LOW">Low priority</option>
              <option value="MEDIUM">Medium priority</option>
              <option value="HIGH">High priority</option>
              <option value="URGENT">Urgent</option>
            </select>
          </FormField>
          <FormField label="Due date" htmlFor="task-due" hint="Optional">
            <input id="task-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
          </FormField>
        </div>
        <FormField label="Assignee email" htmlFor="task-assignee" hint="Optional">
          <input id="task-assignee" value={assigneeEmail} onChange={(e) => setAssigneeEmail(e.target.value)} type="email" placeholder="Optional" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        </FormField>

        <RepeatFields idPrefix="task-create" frequency={frequency} repeatEvery={repeatEvery} onFrequency={setFrequency} onRepeatEvery={setRepeatEvery} />

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
  const [notice, setNotice] = useState("");

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
    setNotice("");
    try {
      const result = await api(`/api/orgs/tasks/${taskId}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      if (result.nextTaskId) setNotice(`Next occurrence created${result.nextDueDate ? `, due ${formatDueDate(result.nextDueDate)}` : ""}.`);
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
          <StatusBadge status={task.status} tone={STATUS_TONE_OVERRIDE[task.status]} />
          <span className={`text-[11px] font-bold uppercase ${PRIORITY_STYLES[task.priority]}`}>{task.priority}</span>
          {task.dueDate && (
            <span className={`text-[11px] font-mono ${overdue ? "text-red-400" : "text-[var(--inaya-text-muted)]"}`}>
              {overdue ? "Overdue — " : "Due "}{formatDueDate(task.dueDate)}
            </span>
          )}
        </div>

        {task.description && <p className="text-[var(--inaya-text-primary)] text-sm whitespace-pre-wrap">{task.description}</p>}

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
                  className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40"
                >
                  {acting === action ? "…" : label}
                </ConfirmButton>
              ) : (
                <button
                  key={action}
                  onClick={() => handleAction(action)}
                  disabled={!!acting}
                  className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40"
                >
                  {acting === action ? "…" : label}
                </button>
              )
            )}
          </div>
        )}

        {error && <p className="text-red-400 text-xs">{error}</p>}
        {notice && <p className="text-emerald-400 text-xs">{notice}</p>}

        <TaskRelations orgId={orgId} task={task} canEdit={!!canEdit} onChanged={async () => { await load(); onChanged(); }} />

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
                  <span className="text-[var(--inaya-text-primary)]">{e.action.replaceAll("_", " ").toLowerCase()}</span>
                  {e.previousState && <span className="text-[var(--inaya-text-muted)] font-mono"> · {e.previousState} → {e.newState}</span>}
                  <div className="text-[11px] font-mono text-[#8a96ab] mt-0.5">
                    {e.actorEmail} · {new Date(e.timestamp).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <RecordSharingPanel orgId={orgId} basePath={`/api/orgs/tasks/${taskId}`} idPrefix="task-share" />
      </div>
    </Modal>
  );
}

function RepeatFields({ idPrefix, frequency, repeatEvery, onFrequency, onRepeatEvery }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <FormField label="Repeat" htmlFor={`${idPrefix}-repeat`} hint="Next one is created when this is completed">
        <select id={`${idPrefix}-repeat`} value={frequency} onChange={(e) => onFrequency(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="">Doesn&apos;t repeat</option>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
        </select>
      </FormField>
      <FormField label="Every" htmlFor={`${idPrefix}-every`}>
        <input id={`${idPrefix}-every`} type="number" min={1} max={12} value={repeatEvery} disabled={!frequency} onChange={(e) => onRepeatEvery(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40" />
      </FormField>
    </div>
  );
}

const smallButton = "text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10 disabled:opacity-40";
const sectionTitle = "text-[11px] font-bold uppercase tracking-wider text-[var(--inaya-text-muted)] mb-2";

function TaskRelations({ orgId, task, canEdit, onChanged }) {
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [editingBlockers, setEditingBlockers] = useState(false);
  const [projectTasks, setProjectTasks] = useState(null);
  const [blockerIds, setBlockerIds] = useState(task.blockedByTaskIds || []);
  const [frequency, setFrequency] = useState(task.recurrence?.frequency || "");
  const [repeatEvery, setRepeatEvery] = useState(task.recurrence?.interval || 1);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setBlockerIds(task.blockedByTaskIds || []);
    setFrequency(task.recurrence?.frequency || "");
    setRepeatEvery(task.recurrence?.interval || 1);
  }, [task]);

  async function run(label, fn) {
    setBusy(label);
    setError("");
    try { await fn(); await onChanged(); } catch (err) { setError(err.message); } finally { setBusy(""); }
  }

  const addSubtask = (e) => {
    e.preventDefault();
    if (!subtaskTitle.trim()) return;
    run("subtask", async () => {
      await api("/api/orgs/tasks", { method: "POST", body: JSON.stringify({ orgId, projectId: task.projectId, parentTaskId: task.id, title: subtaskTitle.trim() }) });
      setSubtaskTitle("");
    });
  };

  async function openBlockerEditor() {
    setEditingBlockers(true);
    if (!projectTasks) {
      try {
        const data = await api(`/api/orgs/tasks?orgId=${orgId}&projectId=${task.projectId}`);
        setProjectTasks(data.tasks.filter((t) => t.id !== task.id));
      } catch (err) { setError(err.message); }
    }
  }

  const saveBlockers = () => run("blockers", async () => {
    await api(`/api/orgs/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ orgId, blockedByTaskIds: blockerIds }) });
    setEditingBlockers(false);
  });

  const saveRepeat = () => run("repeat", () => api(`/api/orgs/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ orgId, recurrence: frequency ? { frequency, interval: Number(repeatEvery) || 1 } : null }),
  }));

  const subtasks = task.subtasks || [];
  const blockers = task.blockers || [];
  const repeatChanged = frequency !== (task.recurrence?.frequency || "") || (frequency && Number(repeatEvery) !== (task.recurrence?.interval || 1));

  return (
    <div className="space-y-4">
      {!task.parentTaskId && (
        <div>
          <h4 className={sectionTitle}>Subtasks</h4>
          {subtasks.length === 0 ? (
            <p className="text-[#8a96ab] text-xs italic">No subtasks.</p>
          ) : (
            <div className="space-y-1.5">
              {subtasks.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className={`truncate ${CLOSED.includes(s.status) ? "text-[var(--inaya-text-muted)] line-through" : "text-[var(--inaya-text-primary)]"}`}>{s.title}</span>
                  <StatusBadge status={s.status} tone={STATUS_TONE_OVERRIDE[s.status]} />
                </div>
              ))}
            </div>
          )}
          <form onSubmit={addSubtask} className="flex gap-2 mt-2">
            <label htmlFor={`subtask-${task.id}`} className="sr-only">New subtask title</label>
            <input id={`subtask-${task.id}`} value={subtaskTitle} onChange={(e) => setSubtaskTitle(e.target.value)} placeholder="Add a subtask" className="flex-1 min-w-0 bg-black/45 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
            <button disabled={!!busy || !subtaskTitle.trim()} className={smallButton}>{busy === "subtask" ? "…" : "Add"}</button>
          </form>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className={sectionTitle.replace(" mb-2", "")}>Blocked by</h4>
          {canEdit && !editingBlockers && <button type="button" onClick={openBlockerEditor} className={smallButton}>Edit</button>}
        </div>
        {!editingBlockers ? (
          blockers.length === 0 ? (
            <p className="text-[#8a96ab] text-xs italic">Nothing — this task can start any time.</p>
          ) : (
            <div className="space-y-1.5">
              {blockers.map((b) => (
                <div key={b.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-[var(--inaya-text-primary)]">{b.title}</span>
                  <StatusBadge status={b.status} tone={STATUS_TONE_OVERRIDE[b.status]} />
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="space-y-2">
            {!projectTasks ? (
              <p className="text-[var(--inaya-text-muted)] font-mono text-xs">Loading project tasks…</p>
            ) : projectTasks.length === 0 ? (
              <p className="text-[#8a96ab] text-xs italic">No other tasks in this project.</p>
            ) : (
              <div className="max-h-40 overflow-y-auto space-y-1 bg-black/20 border border-white/5 rounded-lg p-2">
                {projectTasks.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-xs text-[var(--inaya-text-primary)]">
                    <input type="checkbox" checked={blockerIds.includes(t.id)} onChange={(e) => setBlockerIds((ids) => (e.target.checked ? [...ids, t.id] : ids.filter((id) => id !== t.id)))} />
                    <span className="truncate">{t.title}</span>
                    <span className="ml-auto text-[10px] font-mono text-[var(--inaya-text-muted)]">{STATUS_LABELS[t.status]}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={saveBlockers} disabled={!!busy} className={smallButton}>{busy === "blockers" ? "Saving…" : "Save"}</button>
              <button type="button" onClick={() => { setEditingBlockers(false); setBlockerIds(task.blockedByTaskIds || []); }} className={smallButton}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {!task.parentTaskId && (
        <div>
          <h4 className={sectionTitle}>Repeat</h4>
          {canEdit ? (
            <div className="space-y-2">
              <RepeatFields idPrefix={`task-${task.id}`} frequency={frequency} repeatEvery={repeatEvery} onFrequency={setFrequency} onRepeatEvery={setRepeatEvery} />
              {repeatChanged && <button type="button" onClick={saveRepeat} disabled={!!busy} className={smallButton}>{busy === "repeat" ? "Saving…" : "Save repeat"}</button>}
            </div>
          ) : (
            <p className="text-xs text-[var(--inaya-text-primary)]">{describeRecurrence(task.recurrence) || "Doesn't repeat."}</p>
          )}
        </div>
      )}

      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}

// Local Modal removed -- now imports the shared ./ui/Modal.
