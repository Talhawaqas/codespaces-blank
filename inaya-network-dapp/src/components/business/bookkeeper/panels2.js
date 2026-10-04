"use client";

// AI Bookkeeper console, part 2: Review queue, Reconciliation and period close, Sources, Rules, Reports (with read-only what-if), Settings.

import { useState } from "react";
import { useLoad, useAction, Card, Note, Err, Btn, Input, Select, Pill, Table, Result, fmtTime } from "../nas/ui";
import { get, send, money, pct, tone, readAsText, download } from "./helpers";
import { Stat } from "./panels";

const area = "mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1.5 text-xs font-mono";
const Secret = ({ title, value, note }) => value ? (<div className="rounded border border-amber-400/40 p-3 text-xs space-y-1" role="status"><div className="font-semibold text-amber-400">{title}</div><code className="block break-all">{value}</code><div className="text-[var(--inaya-text-muted)]">{note || "Shown once. Save it now."}</div></div>) : null;

// ------------------------------------------------------------------------------------------------------------------------------ review queue
export function ReviewPanel({ orgId, canManage }) {
  const [type, setType] = useState(""); const [sev, setSev] = useState("");
  const l = useLoad(`/api/orgs/finance/bookkeeper/review?orgId=${encodeURIComponent(orgId)}${type ? `&type=${type}` : ""}${sev ? `&severity=${sev}` : ""}&limit=100`);
  const [open, setOpen] = useState(null); const [det, setDet] = useState(null); const [f, setF] = useState({ reason: "", category: "", fields: "", target: "", note: "", to: "" });
  const act = useAction(async () => { await l.reload(); if (open) setDet((await get(orgId, `review/${open}`)).item); });
  const view = async (id) => { setOpen(id); setDet(null); setDet((await get(orgId, `review/${id}`)).item); };
  const run = (action, body, confirm) => act.run(() => send(orgId, `review/${open}/${action}`, body), confirm);
  const rec = det?.record;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Select label="Type" value={type} onChange={setType} options={[{ value: "", label: "All" }, "LOW_CONFIDENCE_EXTRACTION", "LOW_CONFIDENCE_MATCH", "DUPLICATE", "AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "OVERPAYMENT", "UNDERPAYMENT", "UNMATCHED_TRANSACTION", "UNMATCHED_RECEIPT", "ANOMALY"]} />
        <Select label="Severity" value={sev} onChange={setSev} options={[{ value: "", label: "All" }, "high", "medium"]} />
      </div>
      <Err error={l.error || act.error} />
      <Table rows={l.data?.items} empty="Nothing needs review. Items appear here when confidence is below your thresholds, when risk is high, or when a duplicate or anomaly is found." columns={[
        { label: "Raised", render: (i) => fmtTime(i.createdAt) }, { label: "Type", render: (i) => i.type.replace(/_/g, " ").toLowerCase() }, { label: "Why it stopped", render: (i) => <span className="block max-w-md">{i.reason}</span> },
        { label: "Confidence", render: (i) => pct(i.confidence) }, { label: "Severity", render: (i) => <Pill value={tone(i.severity)} label={i.severity} /> }, { label: "", render: (i) => <span className="flex gap-1">{i.waiting && <Pill value="WARNING" label="waiting for document" />}{i.assignedTo && <span className="text-xs">→ {i.assignedTo}</span>}<Btn small onClick={() => (open === i.itemId ? setOpen(null) : view(i.itemId))}>{open === i.itemId ? "Close" : "Review"}</Btn></span> }]} />
      {open && det && (
        <Card title={`${det.type.replace(/_/g, " ").toLowerCase()} — ${rec?.description || rec?.filename || ""}`}>
          <Note tone="warn">{det.reason}</Note>
          {det.detail?.explanation?.length > 0 && <div><div className="text-xs font-semibold">Why the system suggested this</div><ul className="list-disc pl-5 text-xs">{det.detail.explanation.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          {det.detail?.requiresApproval && <Note tone="warn">High risk: only a Finance Manager or an owner/admin can approve this.</Note>}
          {rec?.matches?.map((m) => <p key={m.matchId} className="text-xs">Suggested: <b>{m.targetNumber || m.targetParty || m.targetKind}</b> ({m.matchType}, {pct(m.confidence)}) {m.discrepancy ? <span className="text-amber-400">— {m.discrepancy}</span> : null}</p>)}
          {det.detail?.alternatives?.length > 0 && <p className="text-xs text-[var(--inaya-text-muted)]">Other candidates: {det.detail.alternatives.map((a) => `${a.number || a.party} (${pct(a.confidence)}) [${a.kind}:${a.id}]`).join("; ")}</p>}
          {rec && rec.fields && <Table rows={Object.entries(rec.fields).map(([k, v]) => ({ k, v: String(v.value), c: v.confidence, s: v.source }))} columns={[{ label: "Field", key: "k" }, { label: "Value", key: "v" }, { label: "Confidence", render: (r) => pct(r.c) }, { label: "Source", key: "s" }]} />}
          <div className="grid gap-3 md:grid-cols-2">
            <Input label="Reason (for reject)" value={f.reason} onChange={(v) => setF({ ...f, reason: v })} />
            {rec?.fields ? <label className="block text-xs md:col-span-2"><span className="text-[var(--inaya-text-muted)]">Correct fields (JSON, e.g. {"{ \"vendor\": \"ABC Ltd\", \"total\": \"900.00\" }"})</span><textarea className={area} rows={3} value={f.fields} onChange={(e) => setF({ ...f, fields: e.target.value })} /></label> : <Input label="Category (for edit)" value={f.category} onChange={(v) => setF({ ...f, category: v })} />}
            {!rec?.fields && <Input label="Re-match to (KIND:id, e.g. INVOICE:64f...)" value={f.target} onChange={(v) => setF({ ...f, target: v })} />}
            <Input label="Note / escalate to (email)" value={f.to} onChange={(v) => setF({ ...f, to: v })} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn busy={act.busy} onClick={() => run("approve", {}, "Approve? For a match this records the payment and proposes marking the invoice paid for approval.")}>Approve</Btn>
            <Btn busy={act.busy} disabled={!f.fields && !f.category} onClick={() => run("edit", rec?.fields ? { fields: JSON.parse(f.fields || "{}") } : { category: f.category })}>Save correction</Btn>
            {!rec?.fields && <Btn busy={act.busy} disabled={!f.target} onClick={() => { const [k, id] = f.target.split(":"); run("rematch", { targetKind: k, targetId: id }, "Re-match and confirm?"); }}>Re-match</Btn>}
            <Btn danger busy={act.busy} disabled={!f.reason} onClick={() => run("reject", { reason: f.reason })}>Reject</Btn>
            <Btn busy={act.busy} onClick={() => run("mark_duplicate", {}, "Mark this as a duplicate?")}>Mark duplicate</Btn>
            <Btn busy={act.busy} onClick={() => run("request_document", { note: f.to || "Supporting document requested" })}>Request document</Btn>
            <Btn busy={act.busy} onClick={() => run("defer", {})}>Defer 3 days</Btn>
            <Btn busy={act.busy} disabled={!f.to} onClick={() => run("escalate", { to: f.to, note: f.reason })}>Escalate</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ reconciliation + period close
export function ReconciliationPanel({ orgId, canManage }) {
  const l = useLoad(`/api/orgs/finance/bookkeeper/reconciliation?orgId=${encodeURIComponent(orgId)}`);
  const p = useLoad(`/api/orgs/finance/bookkeeper/periods?orgId=${encodeURIComponent(orgId)}`);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7)); const [scan, setScan] = useState(null); const [note, setNote] = useState("");
  const act = useAction(async () => { await l.reload(); await p.reload(); });
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} />
      <div className="flex items-center gap-2">{canManage && <Btn busy={act.busy} onClick={() => act.run(() => send(orgId, "reconcile", {}))}>Run reconciliation</Btn>}<Note>Categorizes and matches every unreconciled transaction. It never changes an invoice, expense or payment.</Note></div>
      <Table rows={l.data?.reconciliations} empty="No reconciliation run yet." columns={[{ label: "Started", render: (r) => fmtTime(r.startedAt) }, { label: "Status", render: (r) => <Pill value={tone(r.status === "COMPLETED" ? "COMPLETED" : "ATTENTION")} label={r.status} /> }, { label: "Processed", key: "processed" }, { label: "Auto-matched", key: "autoMatched" }, { label: "For review", key: "humanReview" }, { label: "Unmatched", key: "unmatched" }, { label: "Exceptions", key: "exceptions" }, { label: "Reconciled", key: "reconciled" }]} />
      <Card title="Period review checklist (optional)">
        <div className="flex items-end gap-2"><Input label="Month (YYYY-MM)" value={period} onChange={setPeriod} width="w-40" /><Btn busy={act.busy} onClick={() => act.run(async () => setScan(await get(orgId, `periods/${period}/scan`)))}>Scan</Btn>{canManage && <Btn busy={act.busy} onClick={() => act.run(async () => setScan(await send(orgId, `periods/${period}/start`)))}>Start review</Btn>}</div>
        {scan && (<div className="space-y-2"><Table rows={scan.checklist} columns={[{ label: "Check", key: "label" }, { label: "Items", key: "count" }, { label: "Status", render: (k) => <Pill value={tone(k.status)} label={k.status} /> }]} /><Note>{scan.note}</Note></div>)}
        {canManage && <div className="flex items-end gap-2"><Input label="Reason to mark reviewed with blocking items (optional)" value={note} onChange={setNote} /><Btn busy={act.busy} onClick={() => act.run(() => send(orgId, `periods/${period}/close`, { overrideNote: note || null }), "Mark this month as reviewed? This is a bookkeeping marker, not a statutory close.")}>Mark reviewed</Btn></div>}
        <Table rows={p.data?.periods} empty="No period reviews yet." columns={[{ label: "Period", key: "period" }, { label: "Status", render: (x) => <Pill value={tone(x.status)} label={x.status.replace("_", " ")} /> }, { label: "By", render: (x) => x.closedBy || x.startedBy }, { label: "Blocking at close", render: (x) => x.blockingAtClose ?? "" }]} />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ sources
export function SourcesPanel({ orgId, canAdmin, canManage }) {
  const l = useLoad(`/api/orgs/finance/bookkeeper/sources?orgId=${encodeURIComponent(orgId)}`);
  const dept = useLoad(canAdmin ? `/api/orgs/departments?orgId=${encodeURIComponent(orgId)}` : null);
  const [f, setF] = useState({ type: "BANK_ACCOUNT", name: "", departmentId: "", currency: "USD", allowedSenders: "", phoneNumberId: "", appSecret: "", accessToken: "" });
  const [secrets, setSecrets] = useState(null); const [imp, setImp] = useState({ sourceId: "", text: "", fileName: "" });
  const act = useAction(l.reload);
  const depts = dept.data?.departments || dept.data || [];
  const create = () => act.run(async () => { const r = await send(orgId, "sources", { ...f, allowedSenders: f.allowedSenders.split(/[\s,;]+/).filter(Boolean) }); setSecrets(r.secrets || null); setF({ ...f, name: "", appSecret: "", accessToken: "" }); return r; });
  const banks = (l.data?.sources || []).filter((s) => s.type === "BANK_ACCOUNT" && s.status === "ACTIVE");
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} /><Secret title="Secrets for the new source" value={secrets ? Object.entries(secrets).map(([k, v]) => `${k}: ${v}`).join("\n") : null} />
      <Table rows={l.data?.sources} empty="No sources yet." columns={[{ label: "Name", key: "name" }, { label: "Type", key: "type" }, { label: "Currency", key: "currency" }, { label: "Status", render: (s) => <Pill value={s.status === "ACTIVE" ? "OK" : "DISABLED"} label={s.status} /> }, { label: "Last sync", render: (s) => fmtTime(s.lastSyncAt) }, { label: "Verification", render: (s) => <span className="text-xs text-[var(--inaya-text-muted)]">{s.verification || ""}</span> }, { label: "Ingest URL", render: (s) => ["EMAIL_INBOX", "API"].includes(s.type) ? <code className="text-[11px]">/api/finance/bookkeeper/ingest/{s.sourceId}</code> : s.type === "WHATSAPP" ? <code className="text-[11px]">/api/finance/bookkeeper/whatsapp/{s.sourceId}</code> : "" },
        { label: "", render: (s) => canAdmin && s.status === "ACTIVE" ? <span className="flex gap-1">{["EMAIL_INBOX", "API"].includes(s.type) && <Btn small onClick={() => act.run(async () => { const r = await send(orgId, `sources/${s.sourceId}/rotate-secret`); setSecrets({ ingest: r.secret }); return r; }, "Rotate the secret? The old one stops working immediately.")}>Rotate secret</Btn>}<Btn small danger onClick={() => act.run(() => send(orgId, `sources/${s.sourceId}`, {}, "DELETE"), "Disable this source? Existing records are kept.")}>Disable</Btn></span> : null }]} />
      {canManage && banks.length > 0 && (
        <Card title="Import a bank statement (CSV or OFX/QFX)">
          <Select label="Bank account" value={imp.sourceId || banks[0].sourceId} onChange={(v) => setImp({ ...imp, sourceId: v })} options={banks.map((b) => ({ value: b.sourceId, label: `${b.name} (${b.currency})` }))} />
          <label className="block text-xs"><span className="text-[var(--inaya-text-muted)]">Statement file (up to 5 MB)</span><input type="file" accept=".csv,.ofx,.qfx,.txt" onChange={async (e) => { const fl = e.target.files?.[0]; if (fl) setImp({ ...imp, text: await readAsText(fl), fileName: fl.name }); }} className="mt-1 block text-xs" /></label>
          <Btn busy={act.busy} disabled={!imp.text} onClick={() => act.run(async () => { const r = await send(orgId, `sources/${imp.sourceId || banks[0].sourceId}/import`, { text: imp.text }); setImp({ ...imp, text: "", fileName: "" }); return r; })}>Import and reconcile</Btn>
          {act.result?.imported !== undefined && <Note>Imported {act.result.imported} new, {act.result.duplicates} already present{act.result.invalidCount ? `, ${act.result.invalidCount} rows skipped` : ""}. Re-importing the same file adds nothing.</Note>}
          <Note>Bank feeds from a live provider are not available: import statements. Duplicates are recognized, so overlapping statements are safe.</Note>
        </Card>)}
      {canAdmin && (
        <Card title="Add a source">
          <div className="grid gap-3 md:grid-cols-3">
            <Select label="Type" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={[{ value: "BANK_ACCOUNT", label: "Bank account (CSV/OFX import)" }, { value: "UPLOAD", label: "Manual uploads" }, { value: "EMAIL_INBOX", label: "Email relay (signed)" }, { value: "API", label: "API (signed)" }, { value: "WHATSAPP", label: "WhatsApp Business (unverified live)" }]} />
            <Input label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
            <Select label="Department" value={f.departmentId} onChange={(v) => setF({ ...f, departmentId: v })} options={[{ value: "", label: "Choose…" }, ...depts.map((d) => ({ value: d.id || d._id, label: d.name }))]} />
            {f.type === "BANK_ACCOUNT" && <Input label="Currency" value={f.currency} onChange={(v) => setF({ ...f, currency: v })} />}
            {["EMAIL_INBOX", "WHATSAPP"].includes(f.type) && <Input label={f.type === "WHATSAPP" ? "Allowed sender numbers (required)" : "Allowed sender emails (optional)"} value={f.allowedSenders} onChange={(v) => setF({ ...f, allowedSenders: v })} />}
            {f.type === "WHATSAPP" && <><Input label="WhatsApp phone number id" value={f.phoneNumberId} onChange={(v) => setF({ ...f, phoneNumberId: v })} /><Input label="App secret (stored encrypted)" type="password" value={f.appSecret} onChange={(v) => setF({ ...f, appSecret: v })} /><Input label="Access token (stored encrypted)" type="password" value={f.accessToken} onChange={(v) => setF({ ...f, accessToken: v })} /></>}
          </div>
          <Btn busy={act.busy} disabled={!f.name || !f.departmentId} onClick={create}>Add source</Btn>
          <Note>A source belongs to one department. Secrets are shown once and never returned again. Email and WhatsApp are not verified against a live provider; a mail service can relay into the signed endpoint.</Note>
        </Card>)}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ rules
export function RulesPanel({ orgId, canManage }) {
  const l = useLoad(`/api/orgs/finance/bookkeeper/rules?orgId=${encodeURIComponent(orgId)}`);
  const [f, setF] = useState({ name: "", vendorContains: "", descriptionContains: "", category: "", priority: "100" }); const [hist, setHist] = useState(null);
  const act = useAction(l.reload);
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} />
      <Table rows={l.data?.rules} empty="No rules yet. Approved corrections in the review queue are learned automatically, and rules give you deterministic control." columns={[{ label: "Priority", key: "priority" }, { label: "Name", key: "name" }, { label: "If", render: (r) => Object.entries(r.conditions).map(([k, v]) => `${k}: ${v}`).join(", ") }, { label: "Then", render: (r) => r.action?.category || r.kind }, { label: "Version", key: "version" }, { label: "Owner", key: "owner" }, { label: "Status", render: (r) => <Pill value={r.active ? "OK" : "DISABLED"} label={r.active ? "active" : r.proposedByAi ? "AI-proposed, inactive" : "inactive"} /> },
        { label: "", render: (r) => canManage ? <span className="flex gap-1"><Btn small onClick={() => act.run(() => send(orgId, `rules/${r.ruleId}`, { active: !r.active }, "PATCH"))}>{r.active ? "Disable" : "Activate"}</Btn><Btn small onClick={async () => setHist((await get(orgId, `rules/${r.ruleId}/history`)).history)}>History</Btn></span> : null }]} />
      {hist && <Card title="Rule history"><Result result={hist.map((h) => ({ version: h.version, change: h.change, by: h.changedBy, at: h.at, snapshot: h.snapshot }))} /></Card>}
      {canManage && (
        <Card title="Add a categorization rule">
          <div className="grid gap-3 md:grid-cols-3"><Input label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} /><Input label="Vendor contains" value={f.vendorContains} onChange={(v) => setF({ ...f, vendorContains: v })} /><Input label="Description contains" value={f.descriptionContains} onChange={(v) => setF({ ...f, descriptionContains: v })} /><Input label="Category" value={f.category} onChange={(v) => setF({ ...f, category: v })} /><Input label="Priority (1 first)" value={f.priority} onChange={(v) => setF({ ...f, priority: v })} /></div>
          <Btn busy={act.busy} disabled={!f.name || !f.category || (!f.vendorContains && !f.descriptionContains)} onClick={() => act.run(() => send(orgId, "rules", { name: f.name, conditions: { ...(f.vendorContains ? { vendorContains: f.vendorContains } : {}), ...(f.descriptionContains ? { descriptionContains: f.descriptionContains } : {}) }, action: { category: f.category }, priority: Number(f.priority) || 100 }))}>Add rule</Btn>
          <Note>Rules are versioned and audited. AI can only propose a rule; it starts inactive until a person activates it.</Note>
        </Card>)}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ reports + what-if
export function ReportsPanel({ orgId }) {
  const [type, setType] = useState("transactions"); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const rep = useAction(); const dl = useAction(); const sim = useAction();
  const [s, setS] = useState({ scenarioType: "SUPPLIER_PAYMENT_DELAYED", entityId: "", delayDays: "14", percent: "20" });
  const extra = `&type=${type}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`;
  return (
    <div className="space-y-4">
      <Card title="Finance reports">
        <div className="grid gap-3 md:grid-cols-4"><Select label="Report" value={type} onChange={setType} options={["transactions", "invoices", "bills", "receipts", "reconciliation", "unmatched", "exceptions", "duplicates", "supplier_spend", "customer_receipts", "aging", "category_spend", "cash_movement", "processing_accuracy"]} /><Input label="From (YYYY-MM-DD)" value={from} onChange={setFrom} /><Input label="To (YYYY-MM-DD)" value={to} onChange={setTo} /></div>
        <div className="flex gap-2"><Btn busy={rep.busy} onClick={() => rep.run(() => get(orgId, "reports", extra))}>Preview</Btn><Btn busy={dl.busy} onClick={() => dl.run(() => download(orgId, "reports", `${extra}&format=csv`, `bookkeeper-${type}.csv`))}>Download CSV</Btn><Btn busy={dl.busy} onClick={() => dl.run(() => download(orgId, "reports", `${extra}&format=xlsx`, `bookkeeper-${type}.xlsx`))}>Download Excel</Btn><Btn busy={dl.busy} onClick={() => dl.run(() => download(orgId, "reports", `${extra}&format=pdf`, `bookkeeper-${type}.pdf`))}>Download PDF</Btn></div>
        <Err error={rep.error || dl.error} />
        {rep.result && <div className="space-y-2"><Table rows={rep.result.rows.slice(0, 100)} columns={rep.result.columns.map((c) => ({ label: c, key: c }))} empty="No rows." /><Note>{rep.result.meta.status}. Generated {rep.result.meta.generatedAt}; scope: {rep.result.meta.sourceScope}; period {rep.result.meta.period}.</Note></div>}
        <Note>CSV, Excel (.xlsx) and PDF. The PDF prints Latin text only; other scripts show as ?, so use CSV or Excel for those.</Note>
      </Card>
      <Card title="What-if (Digital Twin, read-only)">
        <div className="grid gap-3 md:grid-cols-4">
          <Select label="Scenario" value={s.scenarioType} onChange={(v) => setS({ ...s, scenarioType: v })} options={[{ value: "SUPPLIER_PAYMENT_DELAYED", label: "Supplier payment delayed" }, { value: "EXPENSES_INCREASED", label: "Expenses increase" }, { value: "RECEIPTS_DELAYED", label: "Customer receipts delayed" }]} />
          {s.scenarioType === "SUPPLIER_PAYMENT_DELAYED" && <Input label="Supplier name" value={s.entityId} onChange={(v) => setS({ ...s, entityId: v })} />}
          {s.scenarioType === "EXPENSES_INCREASED" ? <Input label="Increase %" value={s.percent} onChange={(v) => setS({ ...s, percent: v })} /> : <Input label="Delay (days)" value={s.delayDays} onChange={(v) => setS({ ...s, delayDays: v })} />}
        </div>
        <Btn busy={sim.busy} onClick={() => sim.run(() => send(orgId, "twin", { scenarioType: s.scenarioType, entityId: s.entityId || "all", delayDays: Number(s.delayDays), percent: Number(s.percent) }))}>Simulate</Btn>
        <Err error={sim.error} />
        {sim.result?.simulation && <div className="space-y-2"><div className="rounded border border-amber-400/50 p-2 text-sm font-semibold text-amber-400">{sim.result.simulation.label}</div><Result result={{ impact: sim.result.simulation.directImpact, unknowns: sim.result.simulation.unknowns, result: sim.result.simulation.resultStatus }} /></div>}
        <Note>A simulation reads your records and changes nothing: no posting, no payments, no messages.</Note>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ settings
export function SettingsPanel({ orgId, canAdmin }) {
  const l = useLoad(`/api/orgs/finance/bookkeeper/settings?orgId=${encodeURIComponent(orgId)}`); const m = useLoad(`/api/orgs/finance/bookkeeper/metrics?orgId=${encodeURIComponent(orgId)}`);
  const [f, setF] = useState(null); const act = useAction(async () => { setF(null); await l.reload(); });
  const s = l.data?.settings; const form = f || (s ? { extraction: s.thresholds.extraction, categorization: s.thresholds.categorization, match: s.thresholds.match, anomaly: s.thresholds.anomaly, autoEnabled: s.autoProcess.enabled, maxAmount: s.autoProcess.maxAmount, highRiskAmount: s.highRiskAmount, highRiskCategories: s.highRiskCategories.join(", "), categories: s.categories.join("\n"), learn: s.learnFromReview, dateWindow: s.matching.dateWindowDays } : null);
  if (!form) return <Note>Loading…</Note>;
  const set = (k) => (v) => setF({ ...form, [k]: v });
  const save = () => act.run(() => send(orgId, "settings", { thresholds: { extraction: Number(form.extraction), categorization: Number(form.categorization), match: Number(form.match), anomaly: Number(form.anomaly) }, autoProcess: { enabled: form.autoEnabled, maxAmount: Number(form.maxAmount) }, highRiskAmount: Number(form.highRiskAmount), highRiskCategories: form.highRiskCategories.split(",").map((x) => x.trim()).filter(Boolean), categories: form.categories.split("\n").map((x) => x.trim()).filter(Boolean), learnFromReview: form.learn, matching: { dateWindowDays: Number(form.dateWindow) } }, "PATCH"));
  return (
    <div className="space-y-4">
      <Err error={l.error || act.error} />
      <Card title="Confidence thresholds and risk policy">
        <div className="grid gap-3 md:grid-cols-4"><Input label="Extraction ≥" value={form.extraction} onChange={set("extraction")} /><Input label="Categorization ≥" value={form.categorization} onChange={set("categorization")} /><Input label="Match ≥" value={form.match} onChange={set("match")} /><Input label="Anomaly score below" value={form.anomaly} onChange={set("anomaly")} /></div>
        <div className="grid gap-3 md:grid-cols-4"><Input label="Auto-process up to amount" value={form.maxAmount} onChange={set("maxAmount")} /><Input label="High-risk amount (needs approval)" value={form.highRiskAmount} onChange={set("highRiskAmount")} /><Input label="Date window (days)" value={form.dateWindow} onChange={set("dateWindow")} /><label className="flex items-center gap-2 pt-5 text-xs"><input type="checkbox" checked={form.autoEnabled} onChange={(e) => set("autoEnabled")(e.target.checked)} />Auto-processing on</label></div>
        <Input label="High-risk categories (comma separated)" value={form.highRiskCategories} onChange={set("highRiskCategories")} />
        <label className="block text-xs"><span className="text-[var(--inaya-text-muted)]">Categories (one per line)</span><textarea className={area} rows={5} value={form.categories} onChange={(e) => set("categories")(e.target.value)} /></label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.learn} onChange={(e) => set("learn")(e.target.checked)} />Learn category mappings from approved corrections</label>
        {canAdmin ? <Btn busy={act.busy} onClick={save}>Save policy</Btn> : <Note>Only an owner or admin can change the policy.</Note>}
        <Note>99% is the default, not a rule of accounting. Auto-processing only ever links matches and categories inside the bookkeeper; it never changes an invoice, expense or payment, and risk always overrides confidence.</Note>
      </Card>
      {m.data && <Card title="Operational metrics (last 30 days, counted)"><div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Documents processed" value={m.data.documentsProcessed} /><Stat label="Documents failed" value={m.data.documentsFailed} /><Stat label="Transactions imported" value={m.data.transactionsImported} /><Stat label="Reconciliation rate" value={pct(m.data.reconciliationRate)} /><Stat label="Review queue" value={m.data.reviewQueueSize} /><Stat label="Duplicates" value={m.data.duplicateDetections} /><Stat label="Anomalies" value={m.data.anomalyDetections} /><Stat label="AI extractions" value={m.data.aiUsage.documentExtractions} /></div></Card>}
    </div>
  );
}
