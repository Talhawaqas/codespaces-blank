"use client";

// src/components/business/GuidedTaskPanel.js
//
// AI-Powered Business Workspace SOW — the step-tracker UI for a guided
// task. Self-contained (same convention as AIActionRequestsView.js): owns
// its own fetch calls to /api/orgs/guided-tasks/*, and only reports the
// resulting task state back up via onTaskChange so the parent (page.js)
// can keep one source of truth shared between the compact AIWidget dock
// and the full-page AI Assistant view.
//
// Completion auto-detection: listens for the global "inaya:guided-nav"
// CustomEvent (fired by page.js on every activeView change) and, for
// workflows with one, the current step's own named event (e.g.
// "inaya:guided-po-created", fired by ProcurementView.js at the real
// success point). Every step also has a manual "I did this" fallback —
// the SOW explicitly allows guided completion to be received, not only
// auto-detected, and it's what makes every catalog workflow usable on day
// one regardless of how much instrumentation a given view has.

import { useEffect, useState } from "react";

function renderInstruction(text) {
  return text.split("**").map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>));
}

export default function GuidedTaskPanel({ orgId, task, onTaskChange, compact = false }) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!task || task.status !== "ACTIVE" || !task.currentStep) return undefined;
    const completion = task.currentStep.completion;

    function handleNav(e) {
      if (completion.type !== "nav") return;
      const view = e.detail?.view;
      if (completion.match === "any" || completion.view === view) stepComplete("client-event");
    }
    function handleCustomEvent() {
      stepComplete("client-event");
    }

    window.addEventListener("inaya:guided-nav", handleNav);
    if (completion.type === "custom-event" && completion.eventName) {
      window.addEventListener(completion.eventName, handleCustomEvent);
    }
    return () => {
      window.removeEventListener("inaya:guided-nav", handleNav);
      if (completion.type === "custom-event" && completion.eventName) {
        window.removeEventListener(completion.eventName, handleCustomEvent);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.taskId, task?.currentStepIndex, task?.status]);

  if (!task) return null;

  async function stepComplete(source) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orgs/guided-tasks/${task.taskId}/step-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, fromStepIndex: task.currentStepIndex, source }),
      });
      const data = await res.json();
      if (!res.ok) return;
      if (data.task.status === "COMPLETED") onTaskChange(null);
      else onTaskChange({ ...data.task, currentStep: data.currentStep, label: task.label, totalSteps: task.totalSteps });
    } catch {
      // A dropped network call here just leaves the panel showing the same
      // step — the user can retry "I did this," or the next real nav/event
      // will retry automatically. Nothing to advance past silently.
    } finally {
      setBusy(false);
    }
  }

  async function patchAction(action) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orgs/guided-tasks/${task.taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, action }),
      });
      const data = await res.json();
      if (!res.ok) return;
      if (action === "cancel") onTaskChange(null);
      else onTaskChange({ ...data.task, currentStep: data.currentStep, label: task.label, totalSteps: task.totalSteps });
    } catch {
      // ignore — panel stays as-is, buttons remain clickable to retry
    } finally {
      setBusy(false);
    }
  }

  const stepNumber = task.currentStepIndex + 1;

  return (
    <div className={`bg-violet-400/[0.06] border border-violet-400/25 rounded-xl ${compact ? "p-3 mb-3" : "p-4 mb-4"} font-mono`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-violet-300/80 truncate">{task.label}</div>
          <div className="text-[10px] text-[#8a96ab]">
            Step {stepNumber} of {task.totalSteps} {task.status === "PAUSED" ? "· Paused" : ""}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {task.status === "ACTIVE" ? (
            <button onClick={() => patchAction("pause")} disabled={busy} className="text-[10px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-[#8a96ab] disabled:opacity-40">Pause</button>
          ) : (
            <button onClick={() => patchAction("resume")} disabled={busy} className="text-[10px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-[#8a96ab] disabled:opacity-40">Resume</button>
          )}
          <button onClick={() => patchAction("restart")} disabled={busy} className="text-[10px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-[#8a96ab] disabled:opacity-40">Restart</button>
          <button onClick={() => patchAction("cancel")} disabled={busy} className="text-[10px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-[#8a96ab] disabled:opacity-40">Cancel</button>
        </div>
      </div>

      <div className="w-full h-1 rounded-full bg-white/5 mb-2.5 overflow-hidden">
        <div className="h-full bg-gradient-to-r from-violet-400 to-[#00f2fe]" style={{ width: `${Math.min(100, (stepNumber / task.totalSteps) * 100)}%` }} />
      </div>

      {task.currentStep && (
        <p className="text-xs text-[var(--inaya-text-primary)] leading-relaxed mb-2.5">{renderInstruction(task.currentStep.instruction)}</p>
      )}

      {task.status === "ACTIVE" && task.currentStep && (
        <button
          onClick={() => stepComplete("manual-confirm")}
          disabled={busy}
          className="w-full text-xs font-semibold rounded-lg py-2 bg-gradient-to-r from-violet-400 to-[#00f2fe] text-[#060913] disabled:opacity-50"
        >
          ✓ I did this
        </button>
      )}
    </div>
  );
}
