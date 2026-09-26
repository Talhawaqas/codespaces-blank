"use client";

// Panels for the Automations section: templates, executions (with node-level inspection, explain and evidence
// passport), evaluations, automation health / metrics, credentials, and the workflow copilot.

import { useState } from "react";
import EmptyState from "../../EmptyState";
import { api, useLoad, useAction, Card, Note, Err, Btn, Input, Select, Pill, Table, fmtTime } from "../nas/ui";

const dur = (ms) => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// ----------------------------------------------------------------- templates
export function TemplatesPanel({ orgId, onCreated }) {
  const t = useLoad(`/api/orgs/workflows/templates?orgId=${encodeURIComponent(orgId)}`);
  const act = useAction((r) => onCreated(r?.workflow));
  return (
    <div className="space-y-3">
      <Err error={t.error || act.error} />
      {!t.data?.templates?.length ? <EmptyState title="No templates available" description="Templates are shown only when you hold the permissions they need." /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {t.data.templates.map((x) => (
            <Card key={x.id} title={x.name} right={<Pill value={x.riskLevel === "high" ? "CRITICAL" : x.riskLevel === "medium" ? "WARNING" : "OK"} label={`${x.riskLevel} risk`} />}>
              <p className="text-sm">{x.description}</p>
              <p className="text-xs text-[var(--inaya-text-muted)]">Category: {x.category} · {x.nodeCount} steps · needs: {x.requiredPermissions.join(", ") || "nothing special"}</p>
              {x.requiredIntegrations.length > 0 && <p className="text-xs text-amber-400">Integrations: {x.requiredIntegrations.join(", ")}</p>}
              <p className="text-[11px] text-[var(--inaya-text-muted)]">v{x.version} · by {x.author} · {x.verification}</p>
              <Btn busy={act.busy} onClick={() => act.run(() => api(`/api/orgs/workflows/templates/${x.id}/create`, { method: "POST", body: JSON.stringify({ orgId, name: `${x.name} ${new Date().toISOString().slice(5, 16).replace("T", " ")}` }) }))}>Use this template</Btn>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- copilot
export function CopilotPanel({ orgId, onDrafted }) {
  const [prompt, setPrompt] = useState("");
  const act = useAction((r) => r?.workflow && onDrafted(r.workflow));
  const review = act.result?.review;
  return (
    <Card title="Workflow copilot">
      <textarea aria-label="Describe the workflow" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-sm"
        placeholder="Every morning at 8 AM, check overdue invoices above $10,000, compare them with the supplier and purchase order status, identify urgent cases, and send me a report." />
      <div className="flex items-center gap-2"><Btn busy={act.busy} disabled={prompt.trim().length < 15} onClick={() => act.run(() => api("/api/orgs/workflows/copilot", { method: "POST", body: JSON.stringify({ orgId, prompt }) }))}>Draft it</Btn><Err error={act.error} /></div>
      {review && (
        <div className="rounded border border-white/10 p-2 text-xs space-y-1" role="status">
          <div className="font-semibold">Draft created — review before you publish</div>
          <div>Steps: {review.nodes} · risk: {review.riskLevel} · permissions needed: {review.permissionsNeeded.join(", ") || "none"}</div>
          {review.problems.length > 0 && <ul className="text-red-400">{review.problems.map((p, i) => <li key={i}>✖ {p}</li>)}</ul>}
        </div>
      )}
      <Note>The copilot only writes a draft. It never publishes, and the server validates it exactly like a workflow you built by hand.</Note>
    </Card>
  );
}

// ---------------------------------------------------------------- executions
export function ExecutionsPanel({ orgId, workflows }) {
  const [wf, setWf] = useState("");
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState("production");
  const [open, setOpen] = useState(null);
  const q = `orgId=${encodeURIComponent(orgId)}&mode=${mode}${wf ? `&workflowId=${wf}` : ""}${status ? `&status=${status}` : ""}`;
  const list = useLoad(`/api/orgs/workflows/executions?${q}`);
  if (open) return <ExecutionDetail orgId={orgId} executionId={open} onBack={() => { setOpen(null); list.reload(); }} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Select id="ex-wf" label="Workflow" value={wf} onChange={setWf} options={[{ value: "", label: "All I can see" }, ...workflows.map((w) => ({ value: w.workflowId, label: w.name }))]} />
        <Select id="ex-status" label="Status" value={status} onChange={setStatus} options={[{ value: "", label: "Any" }, ...["QUEUED", "RUNNING", "WAITING", "WAITING_APPROVAL", "PAUSED", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]]} />
        <Select id="ex-mode" label="Kind" value={mode} onChange={setMode} options={[{ value: "production", label: "Production" }, { value: "test", label: "Test runs" }, { value: "dry_run", label: "Dry runs" }, { value: "all", label: "All" }]} />
        <Btn small onClick={list.reload} busy={list.loading}>Refresh</Btn>
      </div>
      <Err error={list.error} />
      {!list.data?.executions?.length ? <EmptyState title="No executions" description="Executions appear here when a workflow runs." /> : (
        <Table columns={[
          { key: "wf", label: "Workflow", render: (e) => <button type="button" className="text-left font-medium hover:underline" onClick={() => setOpen(e.executionId)}>{e.workflowName} v{e.workflowVersion}</button> },
          { key: "id", label: "Execution", render: (e) => <span className="font-mono text-[11px]">{e.executionId.slice(-8)}</span> },
          { key: "trig", label: "Trigger", render: (e) => `${e.trigger?.type}${e.mode !== "production" ? ` (${e.mode})` : ""}` },
          { key: "start", label: "Started", render: (e) => fmtTime(e.startedAt || e.createdAt) },
          { key: "dur", label: "Duration", render: (e) => dur(e.durationMs) },
          { key: "st", label: "Status", render: (e) => <Pill value={e.status} /> },
          { key: "nodes", label: "Nodes", render: (e) => `${e.nodesExecuted}${e.failedNode ? ` · failed: ${e.failedNode}` : ""}` },
          { key: "retry", label: "Retries", render: (e) => e.retryCount },
          { key: "ai", label: "AI decision", render: (e) => (e.summary?.aiDecision ? `${e.summary.aiDecision.classification}${e.summary.aiDecision.urgent ? " (urgent)" : ""}` : "—") },
          { key: "notif", label: "Sent", render: (e) => e.summary?.notificationsSent ?? 0 },
          { key: "act", label: "Actions", render: (e) => e.summary?.actionsProposed ?? 0 },
          { key: "appr", label: "Approval", render: (e) => e.summary?.approvalState || "—" },
        ]} rows={list.data.executions} />
      )}
    </div>
  );
}

function ExecutionDetail({ orgId, executionId, onBack }) {
  const q = `orgId=${encodeURIComponent(orgId)}`;
  const ex = useLoad(`/api/orgs/workflows/executions/${executionId}?${q}`);
  const [why, setWhy] = useState(null);
  const [passport, setPassport] = useState(null);
  const [nodeOpen, setNodeOpen] = useState(null);
  const act = useAction(ex.reload);
  const e = ex.data?.execution;
  const post = (action) => act.run(() => api(`/api/orgs/workflows/executions/${executionId}/${action}`, { method: "POST", body: JSON.stringify({ orgId }) }));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2"><button type="button" onClick={onBack} className="rounded border border-white/10 px-2 py-1 text-xs">← Executions</button>{e && <><span className="text-sm font-semibold">{e.workflowName} v{e.workflowVersion}</span><Pill value={e.status} />{e.mode !== "production" && <span className="rounded bg-sky-400/15 px-1.5 text-xs text-sky-300">{e.mode.toUpperCase()} — nothing was sent or changed</span>}</>}</div>
      <Err error={ex.error || act.error} />
      {e && (
        <>
          <Card title="Summary" right={<span className="flex flex-wrap gap-1">
            {["QUEUED", "WAITING", "WAITING_APPROVAL", "RUNNING", "PAUSED"].includes(e.status) && <Btn small onClick={() => post("cancel")}>Cancel</Btn>}
            {["FAILED", "EXPIRED"].includes(e.status) && !e.deadLetter && <Btn small onClick={() => post("retry")}>Retry from failed node</Btn>}
            <Btn small onClick={async () => setWhy((await api(`/api/orgs/workflows/executions/${executionId}/explain?${q}`)).explanation)}>Why did it do this?</Btn>
            <Btn small onClick={async () => { try { setPassport((await api(`/api/orgs/workflows/executions/${executionId}/passport?${q}`)).passport); } catch (x) { act.setError(x.message); } }}>Evidence passport</Btn>
          </span>}>
            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
              <div><dt className="text-[var(--inaya-text-muted)]">Execution</dt><dd className="font-mono">{e.executionId}</dd></div>
              <div><dt className="text-[var(--inaya-text-muted)]">Trigger</dt><dd>{e.trigger?.type}{e.trigger?.scheduledFor ? ` (${fmtTime(e.trigger.scheduledFor)})` : ""}</dd></div>
              <div><dt className="text-[var(--inaya-text-muted)]">Ran as</dt><dd>{e.runAs}</dd></div>
              <div><dt className="text-[var(--inaya-text-muted)]">Started</dt><dd>{fmtTime(e.startedAt)}</dd></div>
              <div><dt className="text-[var(--inaya-text-muted)]">Duration</dt><dd>{dur(e.durationMs)}</dd></div>
              <div><dt className="text-[var(--inaya-text-muted)]">Retries</dt><dd>{e.retryCount}</dd></div>
            </dl>
            {e.errors?.length > 0 && <div className="mt-2 text-xs text-red-400">{e.errors.map((x, i) => <div key={i}>✖ {x.message}</div>)}{e.summary?.partial && <div>Partial run: some steps finished before the failure.</div>}</div>}
          </Card>
          <Card title="Nodes">
            <ul className="space-y-1">
              {Object.entries(e.nodeResults || {}).map(([k, r]) => (
                <li key={k} className="rounded border border-white/10 p-2 text-xs">
                  <button type="button" className="flex w-full items-center justify-between gap-2 text-left" aria-expanded={nodeOpen === k} onClick={() => setNodeOpen(nodeOpen === k ? null : k)}>
                    <span><span className="font-semibold">{r.name || k}</span> <span className="font-mono text-[10px] text-[var(--inaya-text-muted)]">{r.type}</span></span>
                    <span className="flex items-center gap-2">{r.simulated && <span className="text-sky-300">simulated</span>}{r.synthetic && <span className="text-sky-300">synthetic data</span>}<span>{dur(r.durationMs)}</span><Pill value={r.status === "COMPLETED" ? "OK" : r.status === "SKIPPED" ? "MUTED" : r.status} label={r.status} /></span>
                  </button>
                  {nodeOpen === k && (
                    <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
                      <div>Action class: {r.actionClass || "—"} · attempts: {r.attempts ?? 0} · retries: {r.retryCount ?? 0}</div>
                      {r.permissionContext && <div>Permission context: {r.permissionContext.executingIdentity} ({r.permissionContext.role}){r.permissionContext.scope ? ` · scope ${r.permissionContext.scope}` : ""}</div>}
                      {r.dataSource && <div>Data source: {r.dataSource}</div>}
                      {r.skippedReason && <div>Skipped: {r.skippedReason}</div>}
                      {r.error && <div className="text-red-400">Error: {r.error.message}{r.error.retriesExhausted ? " (retries exhausted)" : ""}</div>}
                      {r.attemptLog?.length > 0 && <div>Earlier attempts: {r.attemptLog.map((a) => `#${a.attempt} ${a.error?.message || ""}`).join(" · ")}</div>}
                      <div>Input: <code>{JSON.stringify(r.inputSummary)}</code></div>
                      <div>Output summary: <code>{JSON.stringify(r.outputSummary)}</code></div>
                      {r.type === "ai.agent" && r.output?.result && <AiBlock out={r.output} />}
                      {r.type === "condition.if" && r.output && <div>Rule: <code>{r.output.expression}</code> → <b>{String(r.output.result)}</b> (branch “{r.output.branch}”)</div>}
                      {r.type?.startsWith("notify.") && r.output && <div>Delivery: <code>{JSON.stringify(r.output.deliveries || r.output.wouldSend)}</code></div>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
      {why && (
        <Card title="Why did this workflow do this?" right={<Btn small onClick={() => setWhy(null)}>Close</Btn>}>
          <ul className="list-disc space-y-1 pl-4 text-xs">{why.narrative.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <Note>Evidence rows: {why.evidence.rows.length} · verified: {String(why.evidence.verified)}. {why.notice}</Note>
        </Card>
      )}
      {passport && (
        <Card title="Evidence passport" right={<><Btn small onClick={() => { const b = new Blob([JSON.stringify(passport, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `evidence-passport-${executionId}.json`; a.click(); URL.revokeObjectURL(a.href); }}>Download JSON</Btn><Btn small onClick={() => setPassport(null)}>Close</Btn></>}>
          <div className="text-xs">Verification: <Pill value={passport.verification.verified ? "OK" : "FAILED"} label={passport.verification.verified ? "verified" : "problems found"} /> · {passport.verification.rowsChecked} evidence rows · audit chain {passport.verification.auditChainValid ? "intact" : "BROKEN"}</div>
          <div className="font-mono text-[11px] break-all">passport hash: {passport.passportHash}</div>
        </Card>
      )}
    </div>
  );
}

function AiBlock({ out }) {
  const r = out.result;
  return (
    <div className="rounded border border-white/10 p-2 space-y-1">
      <div><b>{r.classification}</b>{r.urgent ? " — urgent" : ""} · confidence {r.confidence} · model {out.model}</div>
      <div>{r.summary}</div>
      {out.explainability && <div className="text-[var(--inaya-text-muted)]">Inputs: {out.explainability.inputSources.join(", ")} · tool calls: {out.explainability.toolCalls.map((t) => `${t.tool}:${t.decision}`).join(", ") || "none"} · PII redactions: {out.explainability.piiRedactions}{out.explainability.securityFindings ? ` · removed ${out.explainability.securityFindings.promptInjectionRemoved} instruction-like text(s) from the data` : ""}</div>}
      {out.deterministic?.thresholds?.length > 0 && <div>Thresholds: {out.deterministic.thresholds.map((t) => `${t.name}: ${t.value} ${t.op} ${t.threshold}${t.exceeded ? " ✖" : " ✔"}`).join(" · ")}</div>}
      <div className="text-[10px] text-[var(--inaya-text-muted)]">The model’s reasoning is never stored or shown, only its structured answer.</div>
    </div>
  );
}

// -------------------------------------------------------------- evaluations
export function EvaluationsPanel({ orgId, workflows }) {
  const [wf, setWf] = useState(workflows[0]?.workflowId || "");
  const q = `orgId=${encodeURIComponent(orgId)}`;
  const list = useLoad(wf ? `/api/orgs/workflows/${wf}/evaluations?${q}` : null, [wf]);
  const [name, setName] = useState("");
  const [cases, setCases] = useState('[\n  {\n    "name": "Large overdue invoice is urgent",\n    "testData": { "nodes": { "invoices": { "count": 1, "totalOverdue": 15000, "over10k": 1, "invoices": [] } }, "ai": { "agent": { "urgent": true, "classification": "urgent", "confidence": 0.9, "summary": "Large overdue invoice." } } },\n    "expect": { "status": "COMPLETED", "branch": "yes" }\n  }\n]');
  const create = useAction(list.reload);
  const run = useAction(list.reload);
  return (
    <div className="space-y-3">
      <Select id="ev-wf" label="Workflow" value={wf} onChange={setWf} options={[{ value: "", label: "Choose a workflow" }, ...workflows.map((w) => ({ value: w.workflowId, label: w.name }))]} />
      {wf && (
        <>
          <Card title="Saved evaluations">
            <Err error={list.error || run.error} />
            {!list.data?.evaluations?.length ? <Note>No evaluations yet.</Note> : (
              <Table columns={[
                { key: "n", label: "Name", render: (x) => x.name }, { key: "c", label: "Cases", render: (x) => x.cases },
                { key: "l", label: "Last run", render: (x) => (x.lastRun ? `${x.lastRun.passed}/${x.lastRun.total} passed (${x.lastRun.passRate}%) · ${fmtTime(x.lastRun.at)}` : "never") },
                { key: "a", label: "", render: (x) => <Btn small busy={run.busy} onClick={() => run.run(() => api(`/api/orgs/workflows/evaluations/${x.evaluationId}/run`, { method: "POST", body: JSON.stringify({ orgId, useDraft: true }) }))}>Run (test mode)</Btn> },
              ]} rows={list.data.evaluations} />
            )}
            {run.result?.run && <RunResults run={run.result.run} />}
          </Card>
          <Card title="New evaluation">
            <Input id="ev-name" label="Name" value={name} onChange={setName} />
            <label className="block text-xs"><span className="text-[var(--inaya-text-muted)]">Cases (JSON): synthetic test data + the outcome you expect</span><textarea value={cases} onChange={(e) => setCases(e.target.value)} rows={9} className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1 font-mono text-xs" /></label>
            <Btn busy={create.busy} disabled={!name.trim()} onClick={() => create.run(() => api(`/api/orgs/workflows/${wf}/evaluations`, { method: "POST", body: JSON.stringify({ orgId, name, cases: JSON.parse(cases) }) }))}>Save evaluation</Btn>
            <Err error={create.error} />
            <Note>Evaluations run in test mode only: synthetic data, no notification is sent, no approval request is created, nothing is written to business records.</Note>
          </Card>
        </>
      )}
    </div>
  );
}

function RunResults({ run }) {
  return (
    <div className="space-y-2 text-xs" role="status">
      <div className="font-semibold">Run: {run.passed}/{run.total} passed ({run.passRate}%) · average latency {dur(run.avgLatencyMs)}</div>
      {run.results.map((r, i) => (
        <div key={i} className="rounded border border-white/10 p-2"><div className="flex items-center gap-2"><Pill value={r.passed ? "OK" : "FAILED"} label={r.passed ? "pass" : "fail"} /><span className="font-medium">{r.case}</span></div>
          {r.error && <div className="text-red-400">{r.error}</div>}
          <ul className="mt-1">{r.checks.map((c, j) => <li key={j} className={c.passed ? "" : "text-red-400"}>{c.passed ? "✔" : "✖"} {c.name}: expected <code>{JSON.stringify(c.expected)}</code>, got <code>{JSON.stringify(c.actual)}</code></li>)}</ul></div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- health
export function HealthPanel({ orgId }) {
  const q = `orgId=${encodeURIComponent(orgId)}`;
  const health = useLoad(`/api/orgs/workflows/health?${q}`);
  const metrics = useLoad(`/api/orgs/workflows/metrics?${q}&days=30`);
  const m = metrics.data; const h = health.data;
  return (
    <div className="space-y-3">
      <Err error={health.error || metrics.error} />
      {h && (
        <Card title="Automation health" right={<Pill value={h.trustDimension.status === "HEALTHY" ? "OK" : h.trustDimension.status} />}>
          <p className="text-xs text-[var(--inaya-text-muted)]">{h.summary.total} workflows · {h.summary.runningNormally} running normally · {h.summary.failing} failing · {h.summary.repeatedRetries} retrying · {h.summary.waitingApproval} waiting for approval · {h.summary.credentialProblems} with a credential problem · {h.summary.disabled} disabled</p>
          <Table columns={[
            { key: "n", label: "Workflow", render: (w) => w.name }, { key: "s", label: "State", render: (w) => <Pill value={w.state === "RUNNING_NORMALLY" ? "OK" : w.state === "FAILING" || w.state === "CREDENTIAL_PROBLEM" ? "CRITICAL" : "WARNING"} label={w.state} /> },
            { key: "ok", label: "Last success", render: (w) => fmtTime(w.lastSuccessAt) }, { key: "f", label: "Last failure", render: (w) => (w.lastFailureAt ? `${fmtTime(w.lastFailureAt)}${w.lastError ? ` — ${w.lastError.slice(0, 60)}` : ""}` : "—") },
            { key: "d", label: "Avg duration", render: (w) => dur(w.averageDurationMs) }, { key: "nx", label: "Next run", render: (w) => (w.nextRunAt ? fmtTime(w.nextRunAt) : "—") },
          ]} rows={h.workflows} empty="No workflows yet." />
        </Card>
      )}
      {m && (
        <Card title={`Metrics — last ${m.periodDays} days (${m.scope})`}>
          <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
            {[["Executions", m.totals.executions], ["Successful", m.totals.successful], ["Failed", m.totals.failed], ["Success rate", m.successRate == null ? "—" : `${m.successRate}%`], ["Average duration", dur(m.averageDurationMs)], ["AI node average", dur(m.aiNodeAverageDurationMs)], ["External API average", dur(m.externalApiAverageDurationMs)], ["Retries", m.retryCount], ["Notification delivery", m.notificationDeliveryRate == null ? "—" : `${m.notificationDeliveryRate}%`], ["Approval wait (avg)", dur(m.approvalWaitAverageMs)], ["Most failing node", m.mostFrequentlyFailingNode ? `${m.mostFrequentlyFailingNode.node} (${m.mostFrequentlyFailingNode.failures})` : "—"], ["Most used workflow", m.mostUsedWorkflow ? `${m.mostUsedWorkflow.name} (${m.mostUsedWorkflow.executions})` : "—"]].map(([k, v]) => <div key={k}><dt className="text-[var(--inaya-text-muted)]">{k}</dt><dd className="text-sm font-semibold">{v}</dd></div>)}
          </dl>
        </Card>
      )}
    </div>
  );
}

// -------------------------------------------------------------- credentials
export function CredentialsPanel({ orgId, canManage }) {
  const q = `orgId=${encodeURIComponent(orgId)}`;
  const list = useLoad(canManage ? `/api/orgs/workflows/credentials?${q}` : null);
  const [provider, setProvider] = useState("http_bearer");
  const [label, setLabel] = useState("");
  const [hosts, setHosts] = useState("");
  const [f1, setF1] = useState(""); const [f2, setF2] = useState(""); const [f3, setF3] = useState("");
  const create = useAction(async () => { setLabel(""); setF1(""); setF2(""); setF3(""); setHosts(""); await list.reload(); });
  const revoke = useAction(list.reload);
  if (!canManage) return <Note>Only an owner or admin can manage workflow credentials.</Note>;
  const fields = { http_bearer: [["token", "Token"]], http_header: [["headerName", "Header name"], ["value", "Value"]], http_basic: [["username", "Username"], ["password", "Password"]], slack_webhook: [["url", "Webhook URL"]], gmail_oauth: [["clientId", "Google OAuth client ID"], ["clientSecret", "Client secret"], ["refreshToken", "Refresh token"]] }[provider];
  const vals = [f1, f2, f3]; const setters = [setF1, setF2, setF3];
  const secret = () => Object.fromEntries(fields.map(([k], i) => [k, vals[i]]));
  return (
    <div className="space-y-3">
      <Card title="Credentials">
        <Err error={list.error || revoke.error} />
        {!list.data?.credentials?.length ? <Note>No credentials yet.</Note> : (
          <Table columns={[
            { key: "l", label: "Label", render: (c) => c.label }, { key: "p", label: "Provider", render: (c) => c.provider }, { key: "i", label: "ID", render: (c) => <span className="font-mono text-[10px]">{c.credentialId}</span> }, { key: "h", label: "Allowed hosts", render: (c) => (c.scope?.allowedHosts || []).join(", ") || "—" },
            { key: "s", label: "Status", render: (c) => <Pill value={c.status === "ACTIVE" ? "OK" : "FAILED"} label={c.status} /> }, { key: "u", label: "Used", render: (c) => `${c.usageCount}×${c.lastUsedAt ? ` · ${fmtTime(c.lastUsedAt)}` : ""}` },
            { key: "a", label: "", render: (c) => c.status === "ACTIVE" && <Btn small danger onClick={() => revoke.run(() => api(`/api/orgs/workflows/credentials/${c.credentialId}`, { method: "DELETE", body: JSON.stringify({ orgId }) }), "Revoke this credential? Workflows that use it will stop working.")}>Revoke</Btn> },
          ]} rows={list.data.credentials} />
        )}
      </Card>
      <Card title="Add a credential">
        <div className="grid gap-2 sm:grid-cols-2">
          <Select id="cred-provider" label="Type" value={provider} onChange={setProvider} options={[{ value: "http_bearer", label: "HTTP bearer token" }, { value: "http_header", label: "HTTP custom header" }, { value: "http_basic", label: "HTTP basic auth" }, { value: "slack_webhook", label: "Slack incoming webhook" }, { value: "gmail_oauth", label: "Gmail (OAuth refresh token)" }]} />
          <Input id="cred-label" label="Label" value={label} onChange={setLabel} />
          {fields.map(([k, lbl], i) => <Input key={k} id={`cred-${k}`} type="password" label={lbl} value={vals[i]} onChange={setters[i]} />)}
          {!["slack_webhook", "gmail_oauth"].includes(provider) && <Input id="cred-hosts" label="Allowed hosts (comma separated)" value={hosts} onChange={setHosts} placeholder="helpdesk.example.com" />}
        </div>
        <Btn busy={create.busy} disabled={!label.trim() || !vals.slice(0, fields.length).every(Boolean)} onClick={() => create.run(() => api("/api/orgs/workflows/credentials", { method: "POST", body: JSON.stringify({ orgId, provider, label, secret: secret(), allowedHosts: hosts.split(",").map((h) => h.trim()).filter(Boolean) }) }))}>Store credential</Btn>
        <Err error={create.error} />
        <Note>The secret is encrypted on the server and can never be read back. Workflows refer to a credential by id, every use is audited, and exports never include it.</Note>
      </Card>
    </div>
  );
}
