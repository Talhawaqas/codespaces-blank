"use client";

// src/components/business/workflows/Editor.js
//
// AI Business Operations Manager SOW section 33/53: the visual workflow editor. Palette on the left, canvas in the
// middle (pan, zoom, fit, drag, connect, reconnect, delete), the selected node's configuration on the right, and
// the workflow bar on top (name, status, version, unsaved indicator, save draft, validate, test, dry run, execute,
// publish, version history). Nothing here decides what is allowed: the palette comes from the server's node catalog
// and every check (validation, permissions, publish) runs on the server. The canvas is plain SVG + HTML, no library.

import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { api, useLoad, Btn, Err, Note, Pill, fmtTime } from "../nas/ui";

const NODE_W = 210;
const NODE_H = 66;
const COLORS = {
  trigger: "#38bdf8", data: "#34d399", transformation: "#a3e635", ai: "#c084fc", condition: "#fbbf24", action: "#fb7185", notification: "#f97316", simulation: "#2dd4bf", evidence: "#94a3b8",
};
const CATEGORY_LABEL = { trigger: "Trigger", data: "Data", transformation: "Transformation", ai: "AI", condition: "Condition", action: "Action", notification: "Notification", simulation: "Simulation", evidence: "Evidence" };

// Suggested configuration keys per node type (defaults shown when the key is added).
const HINTS = {
  "trigger.schedule": { schedule: { kind: "daily", time: "08:00", timezone: "UTC", enabled: true } },
  "trigger.event": { eventType: "invoice.overdue" }, "trigger.evidence_event": { subjectType: "INVOICE" }, "trigger.data_change": { source: "overdue_invoices", checkEveryMinutes: 60 },
  "data.overdue_invoices": { minAmount: 0, limit: 100 }, "data.employee_tasks": { onlyOverdue: false, limit: 100 }, "data.crm_sales": { limit: 100 }, "data.security_events": { days: 7 }, "data.business_brief": { period: "weekly" },
  "data.support_tickets": { url: "https://helpdesk.example.com/api/tickets", allowedHosts: ["helpdesk.example.com"], rowsPath: "tickets", credentialId: "" },
  "http.request": { url: "https://api.example.com/", method: "GET", allowedHosts: ["api.example.com"], credentialId: "", timeoutMs: 10000 },
  "transform.filter": { input: "", expression: "row.total > 1000" }, "transform.sort": { input: "", by: "total", direction: "desc" }, "transform.map": { input: "", fields: { field: "row.value * 2" } },
  "transform.aggregate": { input: "", metrics: [{ as: "total", op: "sum", field: "total" }] }, "transform.group": { input: "", by: "status" },
  "kpi.snapshot": { periodDays: 30 },
  "ai.agent": { model: "gemini-3.5-flash-lite", temperature: 0.2, maxOutputTokens: 1024, maxToolCalls: 2, systemInstructions: "", thresholds: [], tools: [], inputFrom: [], memory: { enabled: false } },
  "condition.if": { expression: "nodes.agent.output.result.urgent == true" },
  "notify.inaya": { title: "", body: "", severity: "info", audience: "managers", alertType: "alert" },
  "notify.email": { title: "", body: "", severity: "info", recipients: [], audience: "managers", alertType: "email" },
  "notify.slack": { title: "", body: "", severity: "info", credentialId: "", alertType: "slack" },
  "notify.gmail": { title: "", body: "", severity: "info", recipients: [], credentialId: "", alertType: "gmail" },
  "action.propose": { tool: "propose_invoice_decision", args: { invoiceNumber: "", action: "" }, waitForApproval: true },
  "action.report": { reportType: "daily_operations" }, "simulation.twin": { scenarioType: "SUPPLIER_UNAVAILABLE", entityName: "" }, "evidence.record": { note: "" },
};

const uid = (existing, prefix) => { let i = 1; while (existing.has(`${prefix}${i}`)) i++; return `${prefix}${i}`; };
const clone = (x) => JSON.parse(JSON.stringify(x));

export default function Editor({ orgId, workflow, catalog, onSaved, onClose }) {
  const wfId = workflow.workflowId;
  const [name, setName] = useState(workflow.name);
  const [def, setDef] = useState(null);
  const [saved, setSaved] = useState("");
  const [meta, setMeta] = useState(workflow);
  const [validation, setValidation] = useState(null);
  const [selected, setSelected] = useState(null);
  const [pending, setPending] = useState(null); // connection in progress { from, port }
  const [view, setView] = useState({ x: 30, y: 30, z: 1 });
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [lastRun, setLastRun] = useState(null);
  const [versions, setVersions] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const drag = useRef(null);
  const canvas = useRef(null);
  const q = `orgId=${encodeURIComponent(orgId)}`;

  const load = useCallback(async () => {
    const r = await api(`/api/orgs/workflows/${wfId}?${q}`);
    setDef(clone(r.draft)); setSaved(JSON.stringify(r.draft) + r.workflow.name); setMeta(r.workflow); setName(r.workflow.name); setValidation(r.validation);
    const v = await api(`/api/orgs/workflows/${wfId}/versions?${q}`).catch(() => ({ versions: [] }));
    setVersions(v.versions);
  }, [wfId, q]);
  useEffect(() => { load().catch((e) => setErr(e.message)); }, [load]);

  const dirty = def ? JSON.stringify(def) + name !== saved : false;
  const nodeMap = useMemo(() => new Map((def?.nodes || []).map((n) => [n.key, n])), [def]);
  const typeInfo = useMemo(() => new Map((catalog?.nodeTypes || []).map((t) => [t.type, t])), [catalog]);
  const sel = selected ? nodeMap.get(selected) : null;
  const canEdit = meta.rights?.includes("edit");

  const mutate = (fn) => setDef((d) => { const c = clone(d); fn(c); return c; });
  const errorsByNode = useMemo(() => { const m = new Map(); for (const e of validation?.errors || []) if (e.node) m.set(e.node, [...(m.get(e.node) || []), e.message]); return m; }, [validation]);

  // ---- canvas interaction
  const toWorld = (ev) => { const r = canvas.current.getBoundingClientRect(); return { x: (ev.clientX - r.left - view.x) / view.z, y: (ev.clientY - r.top - view.y) / view.z }; };
  const onMove = useCallback((ev) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "node") { const r = canvas.current.getBoundingClientRect(); const x = (ev.clientX - r.left - d.vx) / d.vz - d.dx; const y = (ev.clientY - r.top - d.vy) / d.vz - d.dy; setDef((cur) => ({ ...cur, nodes: cur.nodes.map((n) => (n.key === d.key ? { ...n, position: { x: Math.round(x), y: Math.round(y) } } : n)) })); }
    if (d.kind === "pan") setView((v) => ({ ...v, x: d.ox + ev.clientX - d.sx, y: d.oy + ev.clientY - d.sy }));
  }, []);
  const onUp = useCallback(() => { drag.current = null; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); }, [onMove]);
  const beginDrag = (d) => { drag.current = d; window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp); };
  useEffect(() => () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); }, [onMove, onUp]);
  const zoomBy = (f) => setView((v) => ({ ...v, z: Math.min(2, Math.max(0.3, v.z * f)) }));
  const fit = () => {
    if (!def?.nodes.length || !canvas.current) return;
    const xs = def.nodes.map((n) => n.position.x); const ys = def.nodes.map((n) => n.position.y);
    const w = Math.max(...xs) + NODE_W - Math.min(...xs); const h = Math.max(...ys) + NODE_H - Math.min(...ys);
    const r = canvas.current.getBoundingClientRect();
    const z = Math.min(1.2, Math.max(0.3, Math.min((r.width - 60) / w, (r.height - 60) / h)));
    setView({ z, x: 30 - Math.min(...xs) * z, y: 30 - Math.min(...ys) * z });
  };
  useEffect(() => { if (def) fit(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [!!def]);

  const addNode = (t) => {
    if (!canEdit) return;
    mutate((d) => {
      const keys = new Set(d.nodes.map((n) => n.key));
      const prefix = t.type.split(".")[1].replace(/[^a-zA-Z0-9]/g, "").replace(/^./, (c) => c.toLowerCase());
      const key = uid(keys, prefix);
      // drop the new box just below the lowest existing one, so boxes never pile up on each other
      const maxY = d.nodes.length ? Math.max(...d.nodes.map((n) => n.position.y)) : 0;
      const firstX = d.nodes.length ? Math.min(...d.nodes.map((n) => n.position.x)) : 40;
      d.nodes.push({ key, type: t.type, name: t.label, config: clone(HINTS[t.type] || {}), position: { x: firstX, y: maxY + NODE_H + 40 } });
      setSelected(key);
    });
  };
  const removeNode = (key) => { mutate((d) => { d.nodes = d.nodes.filter((n) => n.key !== key); d.edges = d.edges.filter((e) => e.from !== key && e.to !== key); }); setSelected(null); };
  const duplicateNode = (key) => mutate((d) => { const n = d.nodes.find((x) => x.key === key); const keys = new Set(d.nodes.map((x) => x.key)); const nk = uid(keys, n.key.replace(/\d+$/, "")); d.nodes.push({ ...clone(n), key: nk, name: `${n.name} copy`, position: { x: n.position.x + 30, y: n.position.y + 30 } }); setSelected(nk); });
  const removeEdge = (i) => mutate((d) => { d.edges.splice(i, 1); });
  const finishConnection = (to) => {
    if (!pending) return;
    if (pending.from !== to && !def.edges.some((e) => e.from === pending.from && e.to === to && (e.fromPort || "out") === pending.port)) mutate((d) => { d.edges.push({ from: pending.from, to, fromPort: pending.port }); });
    setPending(null);
  };
  const reconnect = (i) => { const e = def.edges[i]; mutate((d) => { d.edges.splice(i, 1); }); setPending({ from: e.from, port: e.fromPort || "out" }); };
  useEffect(() => {
    const onKey = (ev) => { if ((ev.key === "Delete" || ev.key === "Backspace") && selected && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) removeNode(selected); if (ev.key === "Escape") setPending(null); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, canEdit]);

  // ---- server actions
  const run = async (label, fn) => { setBusy(label); setErr(""); setMsg(""); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(""); } };
  const save = () => run("save", async () => {
    const r = await api(`/api/orgs/workflows/${wfId}`, { method: "PATCH", body: JSON.stringify({ orgId, name, definition: def, baseUpdatedAt: meta.draftUpdatedAt }) });
    setSaved(JSON.stringify(r.draft) + r.workflow.name); setDef(clone(r.draft)); setMeta(r.workflow); setValidation(r.validation); setMsg("Draft saved."); onSaved?.();
  });
  const validate = () => run("validate", async () => { const r = await api("/api/orgs/workflows/validate", { method: "POST", body: JSON.stringify({ orgId, definition: def }) }); setValidation(r); setMsg(r.valid ? `Valid (${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}).` : `${r.errors.length} problem(s) found.`); });
  const execute = (kind) => run(kind, async () => {
    if (dirty) await save();
    const path = kind === "test" ? "test" : "execute";
    const body = kind === "test" ? { orgId, testData: {}, useDraft: true } : { orgId, dryRun: kind === "dry" };
    const r = await api(`/api/orgs/workflows/${wfId}/${path}`, { method: "POST", body: JSON.stringify(body) });
    setLastRun(r.execution); setMsg(`${kind === "test" ? "Test run" : kind === "dry" ? "Dry run" : "Execution"} finished: ${r.execution.status}.`);
  });
  const publish = () => run("publish", async () => {
    if (dirty) await save();
    try {
      const r = await api(`/api/orgs/workflows/${wfId}/publish`, { method: "POST", body: JSON.stringify({ orgId }) });
      setMsg(`Published version ${r.version}.${r.webhookSecret ? ` Webhook secret (shown once): ${r.webhookSecret}` : ""}`); await load(); onSaved?.();
    } catch (e) {
      // put the actual reasons in the banner (and the Validation box) instead of only saying "it failed"
      const v = await api("/api/orgs/workflows/validate", { method: "POST", body: JSON.stringify({ orgId, definition: def }) }).catch(() => null);
      if (v) setValidation(v);
      throw new Error(v?.errors?.length ? `${e.message} Fix: ${v.errors.map((x) => x.message).join(" • ")}` : e.message);
    }
  }).then(() => {});
  const rollback = (version) => run("rollback", async () => { await api(`/api/orgs/workflows/${wfId}/rollback`, { method: "POST", body: JSON.stringify({ orgId, version }) }); setMsg(`Version ${version} is active again.`); await load(); onSaved?.(); });
  const publishErrors = err && /validation/i.test(err);

  if (!def) return <div className="text-sm text-[var(--inaya-text-muted)]">{err || "Loading the editor…"}</div>;

  const edgePath = (e) => {
    const a = nodeMap.get(e.from); const b = nodeMap.get(e.to);
    if (!a || !b) return null;
    const port = e.fromPort || "out";
    const ports = typeInfo.get(a.type)?.ports || ["out"];
    const idx = Math.max(0, ports.indexOf(port));
    const x1 = a.position.x + NODE_W; const y1 = a.position.y + (ports.length === 1 ? NODE_H / 2 : 20 + idx * 26);
    const x2 = b.position.x; const y2 = b.position.y + NODE_H / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return { d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  };
  const groups = {};
  for (const t of catalog?.nodeTypes || []) (groups[t.category] ||= []).push(t);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onClose} className="rounded border border-white/10 px-2 py-1 text-xs">← All workflows</button>
        <input aria-label="Workflow name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} className="min-w-[14rem] rounded border border-white/10 bg-transparent px-2 py-1 text-sm font-semibold" />
        <Pill value={meta.status} />
        <span className="text-xs text-[var(--inaya-text-muted)]">{meta.publishedVersion ? `v${meta.publishedVersion} live` : "never published"}</span>
        {dirty && <span className="rounded bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-400" role="status">Unsaved changes</span>}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Btn small busy={busy === "save"} disabled={!canEdit || !dirty} onClick={save}>Save draft</Btn>
          <Btn small busy={busy === "validate"} onClick={validate}>Validate</Btn>
          <Btn small busy={busy === "test"} onClick={() => execute("test")}>Test workflow</Btn>
          <Btn small busy={busy === "dry"} onClick={() => execute("dry")}>Dry run</Btn>
          <Btn small busy={busy === "exec"} disabled={meta.status !== "ACTIVE"} onClick={() => execute("exec")}>Execute workflow</Btn>
          <Btn small busy={busy === "publish"} disabled={!meta.rights?.includes("publish")} onClick={publish}>Publish</Btn>
          <Btn small onClick={() => setShowSettings((s) => !s)}>Settings</Btn>
        </div>
      </div>
      <Err error={err} />
      {msg && <div className="text-xs text-emerald-400" role="status">{msg}</div>}
      {publishErrors && <Note tone="warn">Publishing failed closed: fix the problems listed under the canvas.</Note>}

      {showSettings && <SettingsPanel def={def} catalog={catalog} mutate={mutate} disabled={!canEdit} />}

      <div className="grid gap-3" style={{ gridTemplateColumns: "180px minmax(0,1fr) 300px" }}>
        <aside aria-label="Node palette" className="max-h-[560px] space-y-3 overflow-auto rounded-lg border border-white/10 p-2">
          {Object.entries(groups).map(([cat, list]) => (
            <div key={cat}>
              <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: COLORS[cat] }}><span className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS[cat] }} />{CATEGORY_LABEL[cat]}</div>
              {list.map((t) => <button key={t.type} type="button" disabled={!canEdit} onClick={() => addNode(t)} title={`${t.type}${t.scope ? ` — needs the "${t.scope}" scope` : ""}`} className="mb-1 block w-full truncate rounded border border-white/10 px-2 py-1 text-left text-[11px] hover:border-white/30 disabled:opacity-40">{t.label}</button>)}
            </div>
          ))}
        </aside>

        <div className="relative">
          <div className="absolute right-2 top-2 z-10 flex gap-1">
            <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.2)} className="rounded border border-white/20 bg-black/40 px-2 text-sm">+</button>
            <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)} className="rounded border border-white/20 bg-black/40 px-2 text-sm">−</button>
            <button type="button" onClick={fit} className="rounded border border-white/20 bg-black/40 px-2 text-xs">Fit view</button>
          </div>
          {pending && <div className="absolute left-2 top-2 z-10 rounded bg-black/60 px-2 py-1 text-[11px]" role="status">Click a node to connect “{pending.from}” ({pending.port}) to it · Esc to cancel</div>}
          <div ref={canvas} role="application" aria-label="Workflow canvas" className="relative h-[560px] overflow-hidden rounded-lg border border-white/10"
            style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)", backgroundSize: `${20 * view.z}px ${20 * view.z}px`, backgroundPosition: `${view.x}px ${view.y}px`, cursor: "grab" }}
            onMouseDown={(e) => { if (e.target === e.currentTarget || e.target.dataset.bg) { setSelected(null); setPending(null); beginDrag({ kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }); } }}
            onWheel={(e) => { e.preventDefault?.(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); }}>
            <div data-bg="1" style={{ position: "absolute", inset: 0, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: "0 0" }}>
              <svg data-bg="1" width="4000" height="2000" style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
                {def.edges.map((e, i) => { const p = edgePath(e); if (!p) return null; const port = e.fromPort || "out"; return (
                  <g key={i}>
                    <path d={p.d} fill="none" stroke={port === "true" ? "#34d399" : port === "false" ? "#fb7185" : "rgba(255,255,255,0.45)"} strokeWidth="2" />
                    <g style={{ pointerEvents: "all", cursor: "pointer" }} onClick={() => canEdit && removeEdge(i)} onDoubleClick={() => canEdit && reconnect(i)}><title>Click to delete this connection, double-click to reconnect it</title><circle cx={p.mx} cy={p.my} r="8" fill="#0b1020" stroke="rgba(255,255,255,0.4)" /><text x={p.mx} y={p.my + 4} textAnchor="middle" fontSize="11" fill="#fff">×</text></g>
                  </g>
                ); })}
              </svg>
              {def.nodes.map((n) => {
                const info = typeInfo.get(n.type); const ports = info?.ports || ["out"]; const color = COLORS[info?.category] || "#888"; const problems = errorsByNode.get(n.key);
                return (
                  <div key={n.key} role="button" tabIndex={0} aria-label={`${n.name} (${info?.category || "unknown"})`} aria-pressed={selected === n.key}
                    onMouseDown={(e) => { e.stopPropagation(); if (pending) { finishConnection(n.key); return; } setSelected(n.key); if (canEdit) { const r = canvas.current.getBoundingClientRect(); beginDrag({ kind: "node", key: n.key, dx: (e.clientX - r.left - view.x) / view.z - n.position.x, dy: (e.clientY - r.top - view.y) / view.z - n.position.y, vx: view.x, vy: view.y, vz: view.z }); } }}
                    style={{ position: "absolute", left: n.position.x, top: n.position.y, width: NODE_W, height: NODE_H, borderColor: problems ? "#f87171" : selected === n.key ? color : "rgba(255,255,255,0.18)", opacity: n.disabled ? 0.45 : 1, background: "#0e1526" }}
                    className="select-none rounded-lg border-2 px-3 py-2 shadow-lg">
                    <div className="absolute left-0 top-0 h-full w-1.5 rounded-l-md" style={{ background: color }} />
                    <div className="truncate pl-1 text-[12px] font-semibold">{n.name}</div>
                    <div className="truncate pl-1 text-[10px] text-[var(--inaya-text-muted)]">{info?.label || n.type}{n.disabled ? " · disabled" : ""}</div>
                    {problems && <div className="truncate pl-1 text-[10px] text-red-400" title={problems.join("\n")}>⚠ {problems[0]}</div>}
                    {info?.category !== "trigger" && <span aria-hidden="true" className="absolute -left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border border-white/40 bg-[#0e1526]" />}
                    {ports.map((p, idx) => (
                      <button key={p} type="button" aria-label={`Connect from ${n.name} ${p}`} title={ports.length > 1 ? (p === "true" ? "Yes branch" : "No branch") : "Connect"} disabled={!canEdit}
                        onMouseDown={(e) => { e.stopPropagation(); setPending({ from: n.key, port: p }); }}
                        style={{ position: "absolute", right: -7, top: ports.length === 1 ? NODE_H / 2 - 7 : 13 + idx * 26, width: 14, height: 14, background: p === "true" ? "#34d399" : p === "false" ? "#fb7185" : color }}
                        className="rounded-full border border-black/50" />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <aside aria-label="Node configuration" className="max-h-[560px] overflow-auto rounded-lg border border-white/10 p-3">
          {sel ? <NodeConfig key={sel.key} orgId={orgId} node={sel} info={typeInfo.get(sel.type)} catalog={catalog} disabled={!canEdit}
            onChange={(patch) => mutate((d) => { Object.assign(d.nodes.find((n) => n.key === sel.key), patch); })}
            onDuplicate={() => duplicateNode(sel.key)} onDelete={() => removeNode(sel.key)} problems={errorsByNode.get(sel.key)} />
            : <div className="space-y-2 text-xs text-[var(--inaya-text-muted)]"><div className="font-semibold text-[var(--inaya-text)]">Select a node</div><p>Click a node to configure it. Drag nodes to move them. Click the coloured dot on a node’s right edge, then click another node, to connect them. Click the × on a connection to delete it (double-click to reconnect).</p><p>Nothing runs until you publish. The server validates every workflow and refuses to publish an invalid one.</p></div>}
        </aside>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-white/10 p-3">
          <div className="mb-1 flex items-center justify-between text-sm font-semibold"><span>Validation</span>{validation && <Pill value={validation.valid ? "OK" : "FAILED"} label={validation.valid ? "valid" : `${validation.errors.length} problem(s)`} />}</div>
          {!validation ? <Note>Press Validate to check the workflow.</Note> : (<ul className="space-y-1 text-xs">
            {validation.errors.map((e, i) => <li key={`e${i}`} className="text-red-400">✖ {e.message}</li>)}
            {validation.warnings.map((e, i) => <li key={`w${i}`} className="text-amber-400">⚠ {e.message}</li>)}
            {validation.valid && !validation.warnings.length && <li className="text-emerald-400">No problems.</li>}
          </ul>)}
        </div>
        <div className="rounded-lg border border-white/10 p-3">
          <div className="mb-1 text-sm font-semibold">Versions</div>
          {!versions.length ? <Note>No published versions yet.</Note> : <ul className="space-y-1 text-xs">{versions.map((v) => (
            <li key={v.version} className="flex items-center justify-between gap-2"><span>v{v.version} · {fmtTime(v.publishedAt)} · {v.publishedBy}{v.active ? " · live" : ""}</span>{!v.active && meta.rights?.includes("publish") && <button type="button" className="rounded border border-white/20 px-2 py-0.5" onClick={() => rollback(v.version)}>Activate</button>}</li>))}</ul>}
          {lastRun && <div className="mt-3 border-t border-white/10 pt-2 text-xs"><div className="font-semibold">Last run: <Pill value={lastRun.status} /> {lastRun.mode !== "production" && <span className="ml-1 rounded bg-sky-400/15 px-1.5 text-sky-300">{lastRun.mode.toUpperCase()}</span>}</div>
            <ul className="mt-1 space-y-0.5">{Object.entries(lastRun.nodeResults || {}).map(([k, r]) => <li key={k}><span className="font-mono">{k}</span> — {r.status}{r.simulated ? " (simulated)" : ""}{r.error ? `: ${r.error.message}` : ""}</li>)}</ul></div>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ node config
const CREDENTIAL_KINDS = { "notify.slack": ["slack_webhook"], "notify.gmail": ["gmail_oauth"], "http.request": ["http_bearer", "http_header", "http_basic"], "data.support_tickets": ["http_bearer", "http_header", "http_basic"] };

/** Picks a stored credential by name; the workflow only ever keeps its id. Only owners/admins can list credentials. */
function CredentialPicker({ orgId, node, disabled, onPick }) {
  const kinds = CREDENTIAL_KINDS[node.type];
  const list = useLoad(kinds ? `/api/orgs/workflows/credentials?orgId=${encodeURIComponent(orgId)}` : null);
  if (!kinds) return null;
  const options = (list.data?.credentials || []).filter((c) => kinds.includes(c.provider) && c.status === "ACTIVE");
  return (
    <label className="block"><span className="text-[var(--inaya-text-muted)]">Credential ({kinds.join(" / ")})</span>
      {list.error ? (
        <input value={node.config.credentialId || ""} disabled={disabled} onChange={(e) => onPick(e.target.value || null)} placeholder="Paste the credential id (only owners/admins can list credentials)" className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1 font-mono" />
      ) : (
        <select value={node.config.credentialId || ""} disabled={disabled} onChange={(e) => onPick(e.target.value || null)} className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1">
          <option value="">— none selected —</option>
          {options.map((c) => <option key={c.credentialId} value={c.credentialId}>{c.label} ({c.provider})</option>)}
        </select>
      )}
      {!list.error && !options.length && <span className="text-amber-400">No matching credential yet: add one under Automations → Credentials.</span>}
    </label>
  );
}

function NodeConfig({ orgId, node, info, catalog, disabled, onChange, onDuplicate, onDelete, problems }) {
  const [json, setJson] = useState(JSON.stringify(node.config || {}, null, 2));
  const [jsonErr, setJsonErr] = useState("");
  useEffect(() => { setJson(JSON.stringify(node.config || {}, null, 2)); }, [node.config]);
  const setConfig = (cfg) => onChange({ config: cfg });
  const primitives = Object.entries(node.config || {}).filter(([k, v]) => k !== "credentialId" && ["string", "number", "boolean"].includes(typeof v));
  const enums = { severity: ["info", "warning", "critical"], audience: ["managers", "all"], method: ["GET", "POST", "PUT", "PATCH", "DELETE"], reportType: catalog?.reportTypes || [], tool: catalog?.proposeTools || [], scenarioType: catalog?.twinScenarios || [], period: ["daily", "weekly", "monthly", "yearly"], direction: ["asc", "desc"] };
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between"><div className="font-semibold text-[var(--inaya-text)]">{info?.label || node.type}</div>{info && <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: `${COLORS[info.category]}22`, color: COLORS[info.category] }}>{CATEGORY_LABEL[info.category]} · {info.risk} risk</span>}</div>
      {info?.scope && <Note>Needs the “{info.scope}” data scope (declared in Settings; the person running it must hold it).</Note>}
      {problems?.map((p, i) => <div key={i} className="text-red-400">✖ {p}</div>)}
      <label className="block"><span className="text-[var(--inaya-text-muted)]">Name</span><input value={node.name} disabled={disabled} onChange={(e) => onChange({ name: e.target.value })} className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1" /></label>
      <label className="block"><span className="text-[var(--inaya-text-muted)]">Key (used in expressions as nodes.{node.key}.output…)</span><input value={node.key} disabled className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1 font-mono opacity-70" /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={!!node.disabled} disabled={disabled} onChange={(e) => onChange({ disabled: e.target.checked })} /> Disabled (skipped when the workflow runs)</label>
      <CredentialPicker orgId={orgId} node={node} disabled={disabled} onPick={(id) => setConfig({ ...node.config, credentialId: id })} />
      {primitives.map(([k, v]) => (
        <label key={k} className="block"><span className="text-[var(--inaya-text-muted)]">{k}</span>
          {typeof v === "boolean" ? <input type="checkbox" className="ml-2" checked={v} disabled={disabled} onChange={(e) => setConfig({ ...node.config, [k]: e.target.checked })} />
            : enums[k] ? <select value={v} disabled={disabled} onChange={(e) => setConfig({ ...node.config, [k]: e.target.value })} className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1">{enums[k].map((o) => <option key={o} value={o}>{o}</option>)}</select>
            : k === "body" || k === "expression" || k === "systemInstructions" ? <textarea value={v} rows={3} disabled={disabled} onChange={(e) => setConfig({ ...node.config, [k]: e.target.value })} className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1 font-mono" />
            : <input type={typeof v === "number" ? "number" : "text"} value={v} disabled={disabled} onChange={(e) => setConfig({ ...node.config, [k]: typeof v === "number" ? Number(e.target.value) : e.target.value })} className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1" />}
        </label>
      ))}
      {node.type === "ai.agent" && (
        <fieldset className="space-y-1"><legend className="text-[var(--inaya-text-muted)]">Tools the agent may call</legend>
          {(catalog?.tools || []).map((t) => <label key={t.name} className="flex items-center gap-2" title={t.description}><input type="checkbox" disabled={disabled} checked={(node.config.tools || []).includes(t.name)} onChange={(e) => setConfig({ ...node.config, tools: e.target.checked ? [...(node.config.tools || []), t.name] : (node.config.tools || []).filter((x) => x !== t.name) })} />{t.name} <span className="text-[10px] text-[var(--inaya-text-muted)]">({t.riskLevel}{t.readOnly ? "" : ", changes data"})</span></label>)}
          <label className="flex items-center gap-2"><input type="checkbox" disabled={disabled} checked={!!node.config.memory?.enabled} onChange={(e) => setConfig({ ...node.config, memory: { ...(node.config.memory || {}), enabled: e.target.checked } })} /> Use agent memory (workflow-scoped, expires)</label>
        </fieldset>
      )}
      <label className="block"><span className="text-[var(--inaya-text-muted)]">Advanced: full configuration (JSON — never put secrets here; use a credential)</span>
        <textarea value={json} rows={8} disabled={disabled} onChange={(e) => { setJson(e.target.value); try { const v = JSON.parse(e.target.value); if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Must be an object."); setJsonErr(""); setConfig(v); } catch (x) { setJsonErr(x.message); } }} className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1 font-mono" />
      </label>
      {jsonErr && <div className="text-red-400">JSON: {jsonErr}</div>}
      <div className="flex gap-2"><Btn small disabled={disabled} onClick={onDuplicate}>Duplicate</Btn><Btn small danger disabled={disabled} onClick={onDelete}>Delete node</Btn></div>
    </div>
  );
}

function SettingsPanel({ def, catalog, mutate, disabled }) {
  const s = def.settings || {};
  const set = (patch) => mutate((d) => { d.settings = { ...(d.settings || {}), ...patch }; });
  const num = (path, v) => mutate((d) => { d.settings ||= {}; const [a, b] = path.split("."); if (b) { d.settings[a] = { ...(d.settings[a] || {}), [b]: Number(v) }; } else d.settings[a] = Number(v); });
  return (
    <div className="rounded-lg border border-white/10 p-3 text-xs space-y-3">
      <div className="text-sm font-semibold">Workflow permissions & limits</div>
      <fieldset><legend className="mb-1 text-[var(--inaya-text-muted)]">Data scopes this workflow may use (the person running it must also hold each one)</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">{(catalog?.dataScopes || []).map((sc) => <label key={sc} className="flex items-center gap-1"><input type="checkbox" disabled={disabled} checked={(s.dataScopes || []).includes(sc)} onChange={(e) => set({ dataScopes: e.target.checked ? [...(s.dataScopes || []), sc] : (s.dataScopes || []).filter((x) => x !== sc) })} />{sc}</label>)}</div></fieldset>
      <div className="grid gap-3 sm:grid-cols-4">
        {[["limits.perHour", "Executions / hour"], ["limits.perDay", "Executions / day"], ["limits.concurrent", "Concurrent runs"], ["retry.maxAttempts", "Retry attempts"], ["limits.maxHttpCalls", "HTTP calls / run"], ["limits.maxToolCalls", "AI tool calls / run"], ["retention.executionDays", "Keep executions (days)"], ["retention.aiOutputDays", "Keep AI output (days)"], ["retention.memoryDays", "Keep memory (days)"]].map(([p, label]) => {
          const [a, b] = p.split("."); const val = (s[a] || {})[b];
          return <label key={p} className="block"><span className="text-[var(--inaya-text-muted)]">{label}</span><input type="number" disabled={disabled} value={val ?? ""} onChange={(e) => num(p, e.target.value)} className="mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1" /></label>;
        })}
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2"><input type="checkbox" disabled={disabled} checked={s.onNodeFailure === "continue"} onChange={(e) => set({ onNodeFailure: e.target.checked ? "continue" : "stop" })} /> Continue other branches when a node fails (the run is still marked failed)</label>
        <label className="flex items-center gap-2"><input type="checkbox" disabled={disabled} checked={!!s.failureNotification?.enabled} onChange={(e) => set({ failureNotification: { ...(s.failureNotification || {}), enabled: e.target.checked } })} /> Notify managers when the workflow fails</label>
        <label className="flex items-center gap-2"><input type="checkbox" disabled={disabled} checked={!!s.allowExternalRecipients} onChange={(e) => set({ allowExternalRecipients: e.target.checked })} /> Allow email recipients outside the organization (owner/admin only)</label>
      </div>
    </div>
  );
}
