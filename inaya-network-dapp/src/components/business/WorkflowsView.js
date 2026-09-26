"use client";

// src/components/business/WorkflowsView.js
//
// AI Business Operations Manager SOW section 52: Business Workspace > Automations, with Workflows, Templates,
// Executions, Evaluations, Health and Credentials. Every panel calls the real /api/orgs/workflows routes;
// nothing is simulated in the browser, and permissions are decided by the server (the UI only hides what the
// server would refuse).

import { useState } from "react";
import EmptyState from "../EmptyState";
import { api, useLoad, useAction, Card, Note, Err, Btn, Input, Select, Pill, Table, fmtTime } from "./nas/ui";
import Editor from "./workflows/Editor";
import { ExecutionsPanel, EvaluationsPanel, HealthPanel, CredentialsPanel, TemplatesPanel, CopilotPanel } from "./workflows/panels";

const TABS = [["workflows", "Workflows"], ["templates", "Templates"], ["executions", "Executions"], ["evaluations", "Evaluations"], ["health", "Automation health"], ["credentials", "Credentials"]];

export default function WorkflowsView({ orgId, canManage }) {
  const [tab, setTab] = useState("workflows");
  const [editing, setEditing] = useState(null);
  const q = `orgId=${encodeURIComponent(orgId)}`;
  const list = useLoad(`/api/orgs/workflows?${q}`);
  const catalog = useLoad("/api/orgs/workflows/catalog?" + q);
  const [name, setName] = useState("");
  const create = useAction(async (r) => { setName(""); await list.reload(); if (r?.workflow) setEditing(r.workflow); });
  const del = useAction(list.reload);

  if (editing) {
    return <Editor orgId={orgId} workflow={editing} catalog={catalog.data} onSaved={list.reload} onClose={() => { setEditing(null); list.reload(); }} />;
  }

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Automations</h2>
        <p className="text-sm text-[var(--inaya-text-muted)]">Build, schedule and audit business workflows that combine your data, an AI Operations Manager, rules and notifications. Anything that changes a business record goes through human approval first.</p>
      </header>
      <nav aria-label="Automation sections" className="flex flex-wrap gap-1">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined}
            className={`rounded border px-3 py-1.5 text-xs font-medium ${tab === id ? "border-[var(--inaya-accent)] text-[var(--inaya-accent)]" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{label}</button>
        ))}
      </nav>

      {tab === "workflows" && (
        <div className="space-y-4">
          <Card title="New workflow">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[16rem] flex-1"><Input id="wf-new-name" label="Name" value={name} onChange={setName} placeholder="Daily Operations" /></div>
              <Btn busy={create.busy} disabled={name.trim().length < 2} onClick={() => create.run(() => api("/api/orgs/workflows", { method: "POST", body: JSON.stringify({ orgId, name: name.trim() }) }))}>Create blank</Btn>
            </div>
            <Err error={create.error} />
            <Note>Or start from a template, or describe what you want and let the copilot draft it (you review and publish it yourself).</Note>
          </Card>
          <CopilotPanel orgId={orgId} onDrafted={(wf) => { list.reload(); setEditing(wf); }} />
          <Err error={list.error} />
          <Card title="Your workflows" right={<Btn small onClick={list.reload} busy={list.loading}>Refresh</Btn>}>
            {!list.data?.workflows?.length ? <EmptyState title="No workflows yet" description="Create one above or start from a template." /> : (
              <Table columns={[
                { key: "name", label: "Name", render: (w) => <button type="button" className="text-left font-medium underline-offset-2 hover:underline" onClick={() => setEditing(w)}>{w.name}</button> },
                { key: "status", label: "Status", render: (w) => <Pill value={w.status} /> },
                { key: "ver", label: "Live version", render: (w) => (w.publishedVersion ? `v${w.publishedVersion}` : "—") },
                { key: "risk", label: "Risk", render: (w) => <Pill value={w.riskLevel === "high" ? "CRITICAL" : w.riskLevel === "medium" ? "WARNING" : "OK"} label={w.riskLevel} /> },
                { key: "next", label: "Next run", render: (w) => (w.schedule?.enabled ? fmtTime(w.schedule.nextRunAt) : "—") },
                { key: "last", label: "Last run", render: (w) => fmtTime(w.lastExecutionAt) },
                { key: "act", label: "", render: (w) => (
                  <span className="flex gap-1">
                    <Btn small onClick={() => setEditing(w)}>Open</Btn>
                    {w.status === "ACTIVE" && w.rights.includes("publish") && <Btn small onClick={() => del.run(() => api(`/api/orgs/workflows/${w.workflowId}/disable`, { method: "POST", body: JSON.stringify({ orgId }) }))}>Disable</Btn>}
                    {w.status === "DISABLED" && w.rights.includes("publish") && <Btn small onClick={() => del.run(() => api(`/api/orgs/workflows/${w.workflowId}/enable`, { method: "POST", body: JSON.stringify({ orgId }) }))}>Enable</Btn>}
                    <ExportButton orgId={orgId} w={w} />
                    {w.rights.includes("edit") && <Btn small danger onClick={() => del.run(() => api(`/api/orgs/workflows/${w.workflowId}`, { method: "DELETE", body: JSON.stringify({ orgId }) }), `Delete "${w.name}"? Its history and evidence are kept.`)}>Delete</Btn>}
                  </span>) },
              ]} rows={list.data.workflows} />
            )}
            <Err error={del.error} />
          </Card>
          <ImportCard orgId={orgId} onDone={(wf) => { list.reload(); if (wf) setEditing(wf); }} />
        </div>
      )}
      {tab === "templates" && <TemplatesPanel orgId={orgId} onCreated={(wf) => { list.reload(); setEditing(wf); }} />}
      {tab === "executions" && <ExecutionsPanel orgId={orgId} workflows={list.data?.workflows || []} />}
      {tab === "evaluations" && <EvaluationsPanel orgId={orgId} workflows={list.data?.workflows || []} />}
      {tab === "health" && <HealthPanel orgId={orgId} />}
      {tab === "credentials" && <CredentialsPanel orgId={orgId} canManage={canManage} />}
    </div>
  );
}

function ExportButton({ orgId, w }) {
  const act = useAction();
  return <Btn small busy={act.busy} onClick={() => act.run(async () => {
    const r = await api(`/api/orgs/workflows/${w.workflowId}/export?orgId=${encodeURIComponent(orgId)}`);
    const blob = new Blob([JSON.stringify(r.export, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${w.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.workflow.json`; a.click(); URL.revokeObjectURL(a.href);
  })}>Export</Btn>;
}

function ImportCard({ orgId, onDone }) {
  const [text, setText] = useState("");
  const act = useAction((r) => onDone(r?.workflow));
  return (
    <Card title="Import a workflow">
      <textarea aria-label="Workflow JSON" value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder='Paste an exported "inaya.workflow/1" file' className="w-full rounded border border-white/10 bg-transparent px-2 py-1 font-mono text-xs" />
      <div className="flex items-center gap-2"><Btn busy={act.busy} disabled={!text.trim()} onClick={() => act.run(() => api("/api/orgs/workflows/import", { method: "POST", body: JSON.stringify({ orgId, payload: JSON.parse(text) }) }))}>Import as draft</Btn><Err error={act.error} /></div>
      <Note>Exports never contain credentials. An imported workflow is a draft: it must pass validation and be published explicitly.</Note>
    </Card>
  );
}
