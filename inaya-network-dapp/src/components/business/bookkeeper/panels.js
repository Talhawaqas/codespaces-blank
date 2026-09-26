"use client";

// AI Bookkeeper console, part 1: Overview, Transactions, Documents. Every number is read from the API (counted from stored records); the UI
// computes nothing and never shows savings estimates. The server enforces every permission.

import { useState } from "react";
import { useLoad, useAction, Card, Note, Err, Btn, Input, Select, Pill, Table, Result, fmtTime } from "../nas/ui";
import { get, send, money, pct, tone, readAsBase64, download } from "./helpers";

const Stat = ({ label, value, sub }) => (<div className="rounded border border-white/10 p-3"><div className="text-xs text-[var(--inaya-text-muted)]">{label}</div><div className="text-xl font-semibold tabular-nums">{value ?? "—"}</div>{sub && <div className="text-[11px] text-[var(--inaya-text-muted)]">{sub}</div>}</div>);
const area = "mt-1 w-full rounded border border-white/10 bg-transparent px-2 py-1.5 text-xs font-mono";

const txnColumns = (onOpen) => [
  { label: "Date", key: "date" }, { label: "Description", render: (t) => <span className="block max-w-xs truncate" title={t.description}>{t.description}</span> },
  { label: "Amount", render: (t) => <span className="tabular-nums">{t.direction === "CREDIT" ? "+" : "−"}{money(t.amount, t.currency)}</span> },
  { label: "Category", render: (t) => <span>{t.category || "—"}{t.categoryMethod && t.categoryMethod !== "NONE" ? <span className="text-[11px] text-[var(--inaya-text-muted)]"> · {t.categoryMethod.replace("_", " ").toLowerCase()} {pct(t.categoryConfidence)}</span> : null}</span> },
  { label: "Match", render: (t) => t.match?.length ? <span className="text-xs">{t.match.map((m) => m.number || m.party || m.targetKind).join(", ")} <span className="text-[var(--inaya-text-muted)]">{pct(t.match[0].confidence)}</span></span> : <span className="text-[var(--inaya-text-muted)]">none</span> },
  { label: "Status", render: (t) => <Pill value={tone(t.status)} label={t.status.replace("_", " ")} /> },
  { label: "Source", key: "source" },
  { label: "", render: (t) => <Btn small onClick={() => onOpen(t.transactionId)}>Details</Btn> },
];

// ------------------------------------------------------------------------------------------------------------------------------ overview
export function OverviewPanel({ orgId, canManage, onOpenTxn, goTab }) {
  const o = useLoad(`/api/orgs/finance/bookkeeper/overview?orgId=${encodeURIComponent(orgId)}`);
  const t = useLoad(`/api/orgs/finance/bookkeeper/transactions?orgId=${encodeURIComponent(orgId)}&limit=10`);
  const act = useAction(async () => { await o.reload(); await t.reload(); });
  if (o.error) return <Err error={o.error} />;
  if (!o.data) return <Note>Loading…</Note>;
  const k = o.data.cards;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm"><span>AI Bookkeeper</span><Pill value={tone(o.data.status)} label={o.data.status === "RUNNING" ? "Running" : "Needs attention"} /></div>
        {canManage && <Btn busy={act.busy} onClick={() => act.run(() => send(orgId, "reconcile", {}))}>Run reconciliation now</Btn>}
      </div>
      <Err error={act.error} />
      {act.result?.processed !== undefined && <Note>Processed {act.result.processed}: {act.result.autoMatched} auto-matched, {act.result.humanReview} for review, {act.result.exceptions} exceptions.</Note>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Auto categorized" value={k.autoCategorized} /><Stat label="Auto matched" value={k.autoMatched} /><Stat label="Posted" value={k.posted} sub="payments & draft expenses" />
        <Stat label="For review" value={k.forReview} /><Stat label="Unmatched" value={k.unmatched} />
        <Stat label="Exceptions" value={k.exceptions} /><Stat label="Duplicates" value={k.duplicates} /><Stat label="Documents captured" value={k.documentsCaptured} />
        <Stat label="Failed processing" value={k.failedProcessing} /><Stat label="Reconciliation rate" value={pct(k.reconciliationRate)} sub={`${k.transactionsTotal} transactions`} />
      </div>
      <Card title="Recent transactions" right={<Btn small onClick={() => goTab("transactions")}>All transactions</Btn>}>
        <Table rows={t.data?.transactions} empty="No bank transactions yet. Add a bank account under Sources and import a CSV or OFX statement." columns={txnColumns(onOpenTxn)} />
      </Card>
      <Card title="Sources">
        <Table rows={o.data.sources} empty="No source connected." columns={[{ label: "Name", key: "name" }, { label: "Type", key: "type" }, { label: "Last sync", render: (s) => fmtTime(s.lastSyncAt) }, { label: "State", render: (s) => s.lastSyncStatus ? <Pill value={tone(s.lastSyncStatus === "OK" ? "COMPLETED" : "FAILED")} label={s.lastSyncStatus} /> : "" }, { label: "Error", render: (s) => s.lastSyncError || "" }]} />
      </Card>
      <Note>{o.data.note}</Note>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ transactions
export function TransactionsPanel({ orgId, canManage, openId, setOpenId }) {
  const [f, setF] = useState({ status: "", direction: "", category: "", from: "", to: "", counterparty: "", minConfidence: "", exception: false });
  const qs = Object.entries(f).filter(([, v]) => v !== "" && v !== false).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("");
  const l = useLoad(`/api/orgs/finance/bookkeeper/transactions?orgId=${encodeURIComponent(orgId)}${qs}&limit=100`);
  if (openId) return <TransactionDetail orgId={orgId} id={openId} canManage={canManage} onBack={() => { setOpenId(null); l.reload(); }} />;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <Select label="Status" value={f.status} onChange={(v) => setF({ ...f, status: v })} options={[{ value: "", label: "All" }, "UNMATCHED", "SUGGESTED", "AUTO_MATCHED", "HUMAN_REVIEW", "CONFIRMED", "RECONCILED", "EXCEPTION", "DISPUTED", "REVERSED"]} />
        <Select label="Direction" value={f.direction} onChange={(v) => setF({ ...f, direction: v })} options={[{ value: "", label: "All" }, { value: "DEBIT", label: "Money out" }, { value: "CREDIT", label: "Money in" }]} />
        <Input label="Category" value={f.category} onChange={(v) => setF({ ...f, category: v })} /><Input label="Vendor or customer contains" value={f.counterparty} onChange={(v) => setF({ ...f, counterparty: v })} />
        <Input label="From (YYYY-MM-DD)" value={f.from} onChange={(v) => setF({ ...f, from: v })} /><Input label="To (YYYY-MM-DD)" value={f.to} onChange={(v) => setF({ ...f, to: v })} />
        <Input label="Min match confidence (0-1)" value={f.minConfidence} onChange={(v) => setF({ ...f, minConfidence: v })} />
        <label className="flex items-center gap-2 pt-5 text-xs"><input type="checkbox" checked={f.exception} onChange={(e) => setF({ ...f, exception: e.target.checked })} />Only exceptions and items in review</label>
      </div>
      <Err error={l.error} />
      <Table rows={l.data?.transactions} empty="No transactions match." columns={txnColumns(setOpenId)} />
      {l.data && <Note>{l.data.total} matching transactions (first 100 shown).</Note>}
    </div>
  );
}

function TransactionDetail({ orgId, id, canManage, onBack }) {
  const d = useLoad(`/api/orgs/finance/bookkeeper/transactions/${id}?orgId=${encodeURIComponent(orgId)}`);
  const ev = useLoad(`/api/orgs/finance/bookkeeper/evidence?orgId=${encodeURIComponent(orgId)}&transactionId=${id}`);
  const act = useAction(async () => { await d.reload(); await ev.reload(); });
  const [reason, setReason] = useState("");
  if (d.error) return <div className="space-y-3"><Btn small onClick={onBack}>Back</Btn><Err error={d.error} /></div>;
  if (!d.data) return <Note>Loading…</Note>;
  const t = d.data.transaction;
  return (
    <div className="space-y-4">
      <Btn small onClick={onBack}>← Back to transactions</Btn>
      <Card title={`${t.direction === "CREDIT" ? "Received" : "Paid"} ${money(t.amount, t.currency)} on ${t.date}`} right={<Pill value={tone(t.status)} label={t.status.replace("_", " ")} />}>
        <p className="text-sm">{t.description}</p>
        <p className="text-xs text-[var(--inaya-text-muted)]">Category: {t.category || "—"} ({t.categoryMethod || "none"}, {pct(t.categoryConfidence)}) · Match {pct(t.matchConfidence)} · Decision {t.decision || "—"} · Risk {t.risk || "—"}</p>
        {t.reasons?.length > 0 && <ul className="list-disc pl-5 text-xs">{t.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        {t.anomalies?.length > 0 && <div className="space-y-1">{t.anomalies.map((a, i) => <p key={i} className="text-xs text-amber-400">{a.detail}</p>)}</div>}
      </Card>
      <Card title="Why it was matched (source facts and rule results)">
        {d.data.matches.length === 0 ? <Note>No match was found.</Note> : d.data.matches.map((m) => (
          <div key={m.matchId} className="space-y-1 rounded border border-white/10 p-3 text-sm">
            <div className="flex items-center justify-between"><span>{m.number || m.party || m.targetKind} <span className="text-xs text-[var(--inaya-text-muted)]">{m.type} · {pct(m.confidence)} · allocation {money(m.allocation, t.currency)}</span></span><Pill value={tone(m.status)} label={m.status.replace("_", " ")} /></div>
            <ul className="list-disc pl-5 text-xs">{(m.explanation || []).map((x, i) => <li key={i}>{x}</li>)}</ul>{m.discrepancy && <p className="text-xs text-amber-400">{m.discrepancy}</p>}{m.paymentId && <p className="text-xs text-[var(--inaya-text-muted)]">Payment recorded in Finance: {m.paymentId}</p>}
          </div>))}
        {canManage && d.data.matches.length > 0 && ["AUTO_MATCHED", "HUMAN_REVIEW", "SUGGESTED"].includes(t.status) && <div className="flex gap-2"><Btn busy={act.busy} onClick={() => act.run(() => send(orgId, `transactions/${id}/confirm`, {}), "Confirm this match? A payment is recorded, and marking an invoice paid is proposed for approval.")}>Confirm and record</Btn></div>}
        {canManage && ["CONFIRMED", "RECONCILED", "AUTO_MATCHED"].includes(t.status) && <div className="flex items-end gap-2"><Input label="Reversal reason" value={reason} onChange={setReason} /><Btn danger busy={act.busy} disabled={!reason} onClick={() => act.run(() => send(orgId, `transactions/${id}/reverse`, { reason }), "Unlink this match? Any payment already recorded stays in Finance.")}>Reverse match</Btn></div>}
        <Err error={act.error} />
      </Card>
      <Card title="Evidence and audit">
        {!ev.data ? <Note>Loading…</Note> : <div className="space-y-2">
          <Table rows={ev.data.trail?.trail} empty="No audit entries." columns={[{ label: "When", render: (e) => fmtTime(e.timestamp) }, { label: "Action", key: "action" }, { label: "By", key: "actorEmail" }]} />
          {ev.data.evidence ? <Result result={{ relationships: (ev.data.evidence.event?.relationships || ev.data.evidence.relationships || []).map((r) => ({ type: r.type, target: r.targetType, note: r.note })), integrity: ev.data.evidence.integrityHash || ev.data.evidence.integrity || null }} /> : <Note>{ev.data.note}</Note>}
        </div>}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ documents
export function DocumentsPanel({ orgId, canManage }) {
  const [status, setStatus] = useState("");
  const l = useLoad(`/api/orgs/finance/bookkeeper/documents?orgId=${encodeURIComponent(orgId)}${status ? `&status=${status}` : ""}&limit=100`);
  const src = useLoad(`/api/orgs/finance/bookkeeper/sources?orgId=${encodeURIComponent(orgId)}`);
  const [open, setOpen] = useState(null); const [detail, setDetail] = useState(null); const [sourceId, setSourceId] = useState(""); const [file, setFile] = useState(null);
  const act = useAction(l.reload);
  const sources = (src.data?.sources || []).filter((s) => ["UPLOAD", "API", "EMAIL_INBOX"].includes(s.type));
  const view = async (id) => { setOpen(id); setDetail(null); setDetail(await get(orgId, `documents/${id}`)); };
  const doUpload = () => act.run(async () => { const contentBase64 = await readAsBase64(file); const r = await send(orgId, "documents", { sourceId: sourceId || sources[0]?.sourceId, filename: file.name, contentType: file.type || "text/plain", contentBase64 }); setFile(null); return r; });
  const d = detail?.document;
  return (
    <div className="space-y-4">
      <Select label="Show" value={status} onChange={setStatus} options={[{ value: "", label: "All" }, "EXTRACTED", "NEEDS_REVIEW", "DUPLICATE", "PROCESSED", "REJECTED"]} />
      <Err error={l.error || act.error} />
      <Table rows={l.data?.documents} empty="No documents captured yet." columns={[
        { label: "Received", render: (x) => fmtTime(x.createdAt) }, { label: "Type", render: (x) => x.documentType.replace(/_/g, " ").toLowerCase() }, { label: "Vendor / customer", render: (x) => x.vendor || x.customer || "—" }, { label: "Number", key: "invoiceNumber" },
        { label: "Total", render: (x) => money(x.total, x.currency) }, { label: "Channel", key: "channel" }, { label: "Confidence", render: (x) => pct(x.extractionConfidence) }, { label: "Status", render: (x) => <Pill value={tone(x.status)} label={x.status.replace("_", " ")} /> },
        { label: "", render: (x) => <Btn small onClick={() => (open === x.documentId ? setOpen(null) : view(x.documentId))}>{open === x.documentId ? "Hide" : "Details"}</Btn> }]} />
      {open && d && (
        <Card title={`${d.filename} — what was extracted, and where from`} right={<span className="flex gap-1">{canManage && d.documentType.match(/SUPPLIER_INVOICE|RECEIPT/) && !d.postedExpenseId && <Btn small onClick={() => act.run(() => send(orgId, `documents/${open}/post`, {}), "Create a DRAFT expense from this bill? The normal expense approval still applies.")}>Post as draft expense</Btn>}<Btn small onClick={() => download(orgId, `documents/${open}/download`, "", d.filename).catch((e) => act.setError(e.message))}>Download original</Btn></span>}>
          <Table rows={Object.entries(d.fields || {}).map(([k, v]) => ({ field: k, value: String(v.value), conf: v.confidence, source: v.source + (v.grounded === false ? " (ungrounded)" : ""), where: v.location ? `line ${v.location.line}: ${v.location.snippet}` : v.source === "human" ? `entered by ${v.editedBy}` : "" }))} columns={[{ label: "Field", key: "field" }, { label: "Value", key: "value" }, { label: "Confidence", render: (r) => pct(r.conf) }, { label: "Source", key: "source" }, { label: "Where", key: "where" }]} />
          {d.checks?.length > 0 && <ul className="list-disc pl-5 text-xs">{d.checks.map((c, i) => <li key={i} className={c.ok === false ? "text-amber-400" : ""}>{c.detail}</li>)}</ul>}
          {d.missing?.length > 0 && <Note tone="warn">Missing: {d.missing.join(", ")} (nothing was guessed).</Note>}
          {d.anomalies?.map((a, i) => <Note key={i} tone="warn">{a.detail}</Note>)}
          {d.warnings?.map((w, i) => <Note key={i}>{w}</Note>)}
          <Note>Received via {d.channel}{d.occurrences > 1 ? `, seen ${d.occurrences} times` : ""}. Scan: {d.scan}. Extraction: {d.extractionMethod}.</Note>
        </Card>
      )}
      <Card title="Upload a bill, invoice or receipt">
        {sources.length === 0 ? <Note>Add an Upload source first (Sources tab, owner or admin).</Note> : (
          <div className="space-y-2">
            <Select label="Source (decides the department)" value={sourceId || sources[0].sourceId} onChange={setSourceId} options={sources.map((s) => ({ value: s.sourceId, label: `${s.name} (${s.type})` }))} />
            <label className="block text-xs"><span className="text-[var(--inaya-text-muted)]">PDF, JPEG, PNG or text file, up to about 4 MB here</span><input type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,application/pdf,image/png,image/jpeg,text/plain" onChange={(e) => setFile(e.target.files?.[0] || null)} className="mt-1 block text-xs" /></label>
            <Btn busy={act.busy} disabled={!file} onClick={doUpload}>Upload and extract</Btn>
            {act.result?.document && <Note>{act.result.duplicate ? "Already captured (duplicate)." : `Captured: ${act.result.document.status.replace("_", " ").toLowerCase()}.`}</Note>}
          </div>)}
        <Note>Images and scanned PDFs need the AI model; there is no local OCR engine, and a person always confirms them.</Note>
      </Card>
    </div>
  );
}

export { Stat, area };
