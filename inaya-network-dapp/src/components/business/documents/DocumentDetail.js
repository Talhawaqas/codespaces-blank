"use client";

// One document's whole life (SOW §32): what it is, its calculation and
// validation, the approval package for the EXACT version, the evidence chain
// and Evidence Graph timeline, storage/delivery status, every version, and
// the actions the caller's permissions and the document's state allow.

import { useState, useEffect, useCallback } from "react";
import { api, BASE, Button, Field, inputClass, ErrorNote, Section, StatusPill, PipelinePill, Pill, money, fmtDate, shortHash, randomKey } from "./shared";

const TABS = ["Overview", "Approval", "Evidence", "Delivery", "Versions"];

export default function DocumentDetail({ orgId, documentId, canApprove, canGenerate, onChanged, onClose }) {
  const [doc, setDoc] = useState(null);
  const [history, setHistory] = useState(null);
  const [pkg, setPkg] = useState(null);
  const [explain, setExplain] = useState(null);
  const [tab, setTab] = useState("Overview");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [verify, setVerify] = useState(null);
  const [share, setShare] = useState({ mode: "link", recipientEmail: "", expiresPreset: "7d", notify: true, ndaRequired: false });
  const [shared, setShared] = useState(null);

  const load = useCallback(async () => {
    try {
      const [d, h] = await Promise.all([api(`${BASE}/documents/${documentId}?orgId=${orgId}`), api(`${BASE}/documents/${documentId}/history?orgId=${orgId}`)]);
      setDoc(d.document); setHistory(h);
    } catch (e) { setError(e.message); }
  }, [orgId, documentId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab === "Approval" && doc && !pkg) api(`${BASE}/documents/${documentId}/approval?orgId=${orgId}`).then((r) => setPkg(r.package)).catch((e) => setError(e.message));
  }, [tab, doc, pkg, orgId, documentId]);

  async function act(name, fn) {
    setBusy(name); setError("");
    try { await fn(); await load(); setPkg(null); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(""); }
  }

  const post = (path, body) => api(`${BASE}/documents/${documentId}/${path}`, { method: "POST", body: JSON.stringify({ orgId, ...body }) });

  async function download(stage) {
    setBusy("download"); setError("");
    try {
      const res = await fetch(`${BASE}/documents/${documentId}/download?orgId=${orgId}&stage=${stage}&disposition=attachment`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Download failed.");
      const blob = await res.blob();
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${doc.documentNumber}${stage === "draft" ? "-draft" : ""}.pdf`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  }

  async function passport(scope, format) {
    setBusy("passport"); setError("");
    try {
      const res = await fetch(`${BASE}/documents/${documentId}/passport?orgId=${orgId}&scope=${scope}&format=${format}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not build the passport.");
      const blob = format === "pdf" ? await res.blob() : new Blob([JSON.stringify((await res.json()).passport, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `passport-${doc.documentNumber}-${scope}.${format === "pdf" ? "pdf" : "json"}`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  }

  async function runVerify(file) {
    setBusy("verify"); setError(""); setVerify(null);
    try {
      const init = file ? { method: "POST", headers: { "Content-Type": "application/pdf" }, body: await file.arrayBuffer() } : { method: "POST" };
      const res = await fetch(`${BASE}/documents/${documentId}/verify?orgId=${orgId}&deep=1`, init);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed.");
      setVerify(data.verification);
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  }

  if (!doc) return <div className="text-sm text-[var(--inaya-text-muted)]">{error || "Loading..."}</div>;

  const s = doc.status;
  const approvalNeeded = doc.approval.required;
  const failed = ["GENERATION_FAILED", "STORAGE_FAILED", "EVIDENCE_PENDING"].includes(doc.pipelineState);
  const finalStates = ["FINALIZED", "DELIVERED", "VIEWED", "PAID"];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-extrabold">{doc.documentNumber} <span className="text-sm font-normal text-[var(--inaya-text-muted)]">v{doc.documentVersion}</span></h2>
            <StatusPill status={s} /><PipelinePill state={doc.pipelineState} />
            {approvalNeeded && <Pill className="bg-blue-400/10 text-blue-400 border-blue-400/30">approval required</Pill>}
          </div>
          <div className="mt-1 text-xs text-[var(--inaya-text-muted)]">{doc.documentType.replace("_", " ")} - {doc.counterpartyName || "no counterparty"} - {doc.templateName || doc.templateId} v{doc.templateVersion} - {doc.locale} - {doc.pageSize}</div>
        </div>
        <Button onClick={onClose}>Close</Button>
      </div>
      <ErrorNote error={error} />
      {failed && (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200">
          This document is <strong>not complete</strong>: {doc.failureStage} step - {doc.failureReason || doc.pipelineState}. It is retried automatically; you can also retry now.
          {canGenerate && <Button className="ml-3" disabled={busy === "retry"} onClick={() => act("retry", () => post("retry", {}))}>Retry now</Button>}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {canGenerate && s === "GENERATED" && approvalNeeded && <Button tone="primary" disabled={!!busy} onClick={() => act("request", () => post("approval", { action: "request", note }))}>Request approval</Button>}
        {canApprove && ((s === "GENERATED" && !approvalNeeded) || s === "APPROVED") && !failed && <Button tone="good" disabled={!!busy} onClick={() => act("finalize", () => post("finalize", {}))}>{busy === "finalize" ? "Finalizing..." : "Finalize & store"}</Button>}
        {canGenerate && ["GENERATED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "DRAFT"].includes(s) && <Button tone="danger" disabled={!!busy} onClick={() => act("cancel", () => post("void", { cancel: true, reason: reason || "Cancelled" }))}>Cancel</Button>}
        {canApprove && finalStates.includes(s) && <Button tone="danger" disabled={!!busy || reason.trim().length < 3} onClick={() => act("void", () => post("void", { reason }))} >Void</Button>}
        <Button disabled={!!busy || !doc.storageReference} onClick={() => download(finalStates.includes(s) ? "final" : "draft")}>Download PDF</Button>
        {finalStates.includes(s) && <Button disabled={!!busy} onClick={() => runVerify(null)}>{busy === "verify" ? "Verifying..." : "Verify stored copy"}</Button>}
        {finalStates.includes(s) && <Button disabled={!!busy} onClick={() => passport("internal", "pdf")}>Passport (PDF)</Button>}
        {finalStates.includes(s) && <Button disabled={!!busy} onClick={() => passport("external", "json")}>External passport (JSON)</Button>}
      </div>
      {(canGenerate || canApprove) && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Note for approval request"><input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Field label="Reason (needed to void or cancel)"><input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
      )}

      {verify && (
        <Section title="Verification result">
          <div className={`text-sm font-bold ${verify.verified ? "text-emerald-300" : "text-red-300"}`}>{verify.verified ? "VERIFIED - every check passed" : "NOT VERIFIED"}</div>
          <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
            <li>Manifest hash: {String(verify.manifestHashMatches)}</li><li>Calculation hash: {String(verify.calculationHashMatches)}</li>
            <li>Template hash: {String(verify.templateHashMatches)}</li><li>Source-data hash: {String(verify.sourceDataHashMatches)}</li>
            <li>Evidence chain: {verify.evidenceChain.chainValid ? `intact (${verify.evidenceChain.nodes} nodes)` : `BROKEN at #${verify.evidenceChain.brokenAtSeq}`}</li>
            <li>Audit chain: {verify.auditChain.valid ? `intact (${verify.auditChain.entries} entries)` : "BROKEN"}</li>
            <li>Stored ciphertext: {verify.storage.checked ? (verify.storage.ok ? "decrypts to the recorded hash" : `FAILED ${verify.storage.reason || ""}`) : "not checked"}</li>
          </ul>
          <div className="mt-3"><Field label="Also check a PDF file against this record"><input type="file" accept="application/pdf" onChange={(e) => e.target.files?.[0] && runVerify(e.target.files[0])} /></Field></div>
          {verify.uploadedFile?.provided && <div className={`mt-2 text-xs font-bold ${verify.uploadedFile.matches ? "text-emerald-300" : "text-red-300"}`}>{verify.uploadedFile.matches ? "The file is byte-identical to the finalized document." : "The file does NOT match the finalized document."}</div>}
        </Section>
      )}

      <div className="flex gap-1 border-b border-white/10" role="tablist">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-semibold ${tab === t ? "border-b-2 border-cyan-400 text-cyan-300" : "text-[var(--inaya-text-muted)]"}`}>{t}</button>)}
      </div>

      {tab === "Overview" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Amounts">
            <div className="text-2xl font-extrabold">{money(doc.grandTotal, doc.currency)}</div>
            {doc.amountDue !== null && doc.amountDue !== doc.grandTotal && <div className="text-xs text-[var(--inaya-text-muted)]">Amount due {money(doc.amountDue, doc.currency)}</div>}
            {doc.calculation && (
              <table className="mt-3 w-full text-xs"><tbody>
                {[["Subtotal", doc.calculation.subtotal], ["Line discounts", -doc.calculation.lineDiscountTotal], ["Invoice discount", -doc.calculation.invoiceDiscount], ["Tax", doc.calculation.totalTax], ["Shipping", doc.calculation.shipping], ["Fees", doc.calculation.fees]].filter(([, v]) => v).map(([k, v]) => <tr key={k}><td>{k}</td><td className="text-right">{money(v, doc.currency)}</td></tr>)}
              </tbody></table>
            )}
          </Section>
          <Section title="Validation & checks">
            {(doc.validationChecks || []).length === 0 ? <p className="text-xs text-emerald-300">All checks passed.</p> : (
              <ul className="space-y-1.5 text-xs">{doc.validationChecks.map((c) => <li key={c.id} className="flex gap-2"><Pill>{c.severity}</Pill><span title={c.rule}>{c.message}</span></li>)}</ul>
            )}
            <div className="mt-3"><Button disabled={busy === "explain"} onClick={async () => { setBusy("explain"); try { setExplain((await api(`${BASE}/documents/${documentId}/explain?orgId=${orgId}`)).explanation); } catch (e) { setError(e.message); } finally { setBusy(""); } }}>Why does it look like this?</Button></div>
            {explain && <div className="mt-2 space-y-1 text-xs"><div>Rules: {explain.rules.map((r) => `${r.id} = ${r.result}`).join("; ")}</div><div>Source records: {explain.inputs.sourceRecords.length} - source fingerprint {shortHash(explain.inputs.sourceDataHash)}</div><div className="italic text-[var(--inaya-text-muted)]">{explain.note}</div></div>}
          </Section>
          <Section title="Fingerprints & storage">
            <dl className="space-y-1 text-xs">
              <div><dt className="inline text-[var(--inaya-text-muted)]">Document (SHA-256): </dt><dd className="inline font-mono">{shortHash(doc.documentHash)}</dd></div>
              <div><dt className="inline text-[var(--inaya-text-muted)]">Source data: </dt><dd className="inline font-mono">{shortHash(doc.sourceDataHash)}</dd></div>
              <div><dt className="inline text-[var(--inaya-text-muted)]">Calculation: </dt><dd className="inline font-mono">{shortHash(doc.calculationHash)}</dd></div>
              <div><dt className="inline text-[var(--inaya-text-muted)]">Template: </dt><dd className="inline font-mono">{shortHash(doc.templateHash)}</dd></div>
              <div><dt className="inline text-[var(--inaya-text-muted)]">Evidence root: </dt><dd className="inline font-mono">{shortHash(doc.evidence.root)}</dd> <span className="text-[var(--inaya-text-muted)]">({doc.evidence.nodes} nodes)</span></div>
              <div><dt className="inline text-[var(--inaya-text-muted)]">Stored at: </dt><dd className="inline">{doc.storageReference ? `${doc.storageReference.key}` : "not stored yet"}</dd></div>
              <div><dt className="inline text-[var(--inaya-text-muted)]">Pages / size: </dt><dd className="inline">{doc.pageCount || "-"} / {doc.sizeBytes ? `${(doc.sizeBytes / 1024).toFixed(1)} KB` : "-"}</dd></div>
            </dl>
            {doc.manifest && <details className="mt-3 text-xs"><summary className="cursor-pointer text-cyan-300">Manifest</summary><pre className="mt-2 max-h-64 overflow-auto rounded bg-black/40 p-2 text-[10px]">{JSON.stringify(doc.manifest, null, 2)}</pre></details>}
          </Section>
          <Section title="Lifecycle">
            <ul className="space-y-1 text-xs">
              <li>Created {fmtDate(doc.createdAt, true)} by {doc.createdByEmail} ({doc.createdByActorType})</li>
              {doc.finalizedAt && <li>Finalized {fmtDate(doc.finalizedAt, true)}</li>}
              {doc.supersededAt && <li>Superseded {fmtDate(doc.supersededAt, true)}</li>}
              {doc.voidedAt && <li className="text-red-300">Voided {fmtDate(doc.voidedAt, true)}: {doc.voidReason}</li>}
              <li>Delivery: {doc.delivery?.state || "NONE"}</li>
            </ul>
          </Section>
        </div>
      )}

      {tab === "Approval" && (
        <div className="space-y-4">
          {!approvalNeeded && <p className="text-xs">This document does not require approval ({doc.approval.reason || "below the threshold"}).</p>}
          {pkg && (
            <>
              <Section title="Exact version under review">
                <div className="text-xs">Version {pkg.approvalBinding.boundVersion} - document fingerprint <span className="font-mono">{shortHash(pkg.approvalBinding.boundDraftHash || pkg.approvalBinding.boundDocumentHash)}</span> - source fingerprint <span className="font-mono">{shortHash(pkg.approvalBinding.boundSourceDataHash)}</span></div>
                <div className={`mt-2 text-xs font-semibold ${pkg.drift.drifted ? "text-red-300" : pkg.drift.checked ? "text-emerald-300" : "text-amber-300"}`}>
                  {pkg.drift.checked ? (pkg.drift.drifted ? "The source data has CHANGED since this version was generated - it cannot be approved. Regenerate." : "The source data is unchanged since this version was generated.") : `Source drift not checked: ${pkg.drift.reason}`}
                </div>
              </Section>
              <Section title="Changes from the previous version">
                {!pkg.changesFromPreviousVersion.previousVersion ? <p className="text-xs">This is the first version.</p> : (
                  <ul className="space-y-1 text-xs">
                    <li>Total: {money(pkg.changesFromPreviousVersion.grandTotal.from, doc.currency)} to {money(pkg.changesFromPreviousVersion.grandTotal.to, doc.currency)}</li>
                    <li>Source data changed: {String(pkg.changesFromPreviousVersion.sourceDataChanged)}; template changed: {String(pkg.changesFromPreviousVersion.templateChanged)}</li>
                    {pkg.changesFromPreviousVersion.linesAdded.length > 0 && <li>Added: {pkg.changesFromPreviousVersion.linesAdded.join(", ")}</li>}
                    {pkg.changesFromPreviousVersion.linesRemoved.length > 0 && <li>Removed: {pkg.changesFromPreviousVersion.linesRemoved.join(", ")}</li>}
                  </ul>
                )}
              </Section>
              <Section title="Source snapshot">
                <pre className="max-h-64 overflow-auto rounded bg-black/40 p-2 text-[10px]">{JSON.stringify(pkg.sourceSnapshot, null, 2)}</pre>
              </Section>
            </>
          )}
          <Section title="Decision">
            <div className="text-xs">Status: <strong>{doc.approval.status || "not requested"}</strong>{doc.approval.requestedByEmail && <> - requested by {doc.approval.requestedByEmail} {fmtDate(doc.approval.requestedAt, true)}</>}{doc.approval.decidedByEmail && <> - decided by {doc.approval.decidedByEmail} {fmtDate(doc.approval.decidedAt, true)}{doc.approval.decisionNote ? ` ("${doc.approval.decisionNote}")` : ""}</>}</div>
            {s === "PENDING_APPROVAL" && canApprove && (
              <div className="mt-3 space-y-2">
                <Field label="Decision note"><input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                <div className="flex gap-2">
                  <Button tone="good" disabled={!!busy || pkg?.drift?.drifted} onClick={() => act("approve", () => post("approval", { action: "approve", note }))}>Approve this exact version</Button>
                  <Button tone="danger" disabled={!!busy} onClick={() => act("reject", () => post("approval", { action: "reject", note }))}>Reject</Button>
                </div>
                <p className="text-[11px] text-[var(--inaya-text-muted)]">You cannot approve a document you generated or requested. Approval binds to version {doc.documentVersion} and its fingerprints.</p>
              </div>
            )}
          </Section>
        </div>
      )}

      {tab === "Evidence" && history && (
        <div className="space-y-4">
          <Section title="Evidence chain">
            <div className={`mb-2 text-xs font-semibold ${history.evidence.chain.valid ? "text-emerald-300" : "text-red-300"}`}>{history.evidence.chain.valid ? `Intact - ${history.evidence.chain.count} nodes, each hash-linked to the previous one` : `BROKEN at node #${history.evidence.chain.brokenAtSeq}`}</div>
            <ol className="space-y-1 text-xs">
              {history.evidence.nodes.map((n) => <li key={n.seq} className="flex flex-wrap gap-2"><span className="w-6 text-[var(--inaya-text-muted)]">#{n.seq}</span><span className="font-semibold">{n.nodeType}</span><span className="text-[var(--inaya-text-muted)]">{fmtDate(n.at, true)} - {n.actorType}{n.actor ? ` (${n.actor})` : ""}</span><span className="font-mono text-[10px] text-[var(--inaya-text-muted)]">{shortHash(n.nodeHash)}</span></li>)}
            </ol>
          </Section>
          <Section title="Evidence Graph timeline (existing audit view)">
            {history.timeline.length === 0 ? <p className="text-xs">No timeline entries.</p> : <ol className="space-y-1 text-xs">{history.timeline.map((t, i) => <li key={i}>{fmtDate(t.timestamp, true)} - {t.recordType} {t.action} ({t.actorEmail || "system"})</li>)}</ol>}
          </Section>
        </div>
      )}

      {tab === "Delivery" && history && (
        <div className="space-y-4">
          {canGenerate && finalStates.includes(s) && (
            <Section title="Share securely">
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="How"><select className={inputClass} value={share.mode} onChange={(e) => setShare({ ...share, mode: e.target.value })}><option value="link">Secure link</option><option value="data_room">Data Room (verified email)</option></select></Field>
                <Field label="Recipient email"><input className={inputClass} value={share.recipientEmail} onChange={(e) => setShare({ ...share, recipientEmail: e.target.value })} /></Field>
                <Field label="Expires"><select className={inputClass} value={share.expiresPreset} onChange={(e) => setShare({ ...share, expiresPreset: e.target.value })}>{["1h", "24h", "7d", "30d"].map((p) => <option key={p}>{p}</option>)}</select></Field>
                <label className="flex items-end gap-2 text-xs"><input type="checkbox" checked={share.notify} onChange={(e) => setShare({ ...share, notify: e.target.checked })} /> Email a notification (never the document)</label>
              </div>
              {share.mode === "data_room" && <label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={share.ndaRequired} onChange={(e) => setShare({ ...share, ndaRequired: e.target.checked })} /> Require the recipient to accept confidentiality terms</label>}
              <p className="mt-2 text-[11px] text-[var(--inaya-text-muted)]">{share.mode === "link" ? "Anyone holding the link can open it until it expires or is revoked; the recipient email is recorded, not verified." : "The recipient proves control of their email address before they can open the document."} The link is bound to version {doc.documentVersion} and never resolves to a newer one.</p>
              <div className="mt-3"><Button tone="primary" disabled={!!busy} onClick={() => act("share", async () => { const r = await api(`${BASE}/documents/${documentId}/deliveries`, { method: "POST", body: JSON.stringify({ orgId, ...share, recipientEmail: share.recipientEmail || undefined }) }); setShared(r); })}>Create secure delivery</Button></div>
              {shared && (
                <div className="mt-3 rounded-md border border-emerald-400/30 bg-emerald-400/10 p-3 text-xs">
                  <div className="font-semibold text-emerald-300">Delivery created - copy the link now (it is shown only once).</div>
                  <input readOnly className={`${inputClass} mt-2 font-mono`} value={shared.url} onFocus={(e) => e.target.select()} aria-label="Secure link" />
                  {shared.email && <div className="mt-1">Email notification: {shared.email.state}{shared.email.state === "NOT_CONFIGURED" ? " (no email provider configured - share the link yourself)" : ""}</div>}
                  {shared.note && <div className="mt-1">{shared.note}</div>}
                </div>
              )}
            </Section>
          )}
          <Section title="Deliveries">
            {history.deliveries.length === 0 ? <p className="text-xs">Not shared yet.</p> : (
              <ul className="space-y-2 text-xs">{history.deliveries.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/10 p-2">
                  <span><Pill className={d.status === "ACTIVE" ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" : ""}>{d.status}</Pill> {d.mode === "link" ? "secure link" : "Data Room"} - v{d.documentVersion} - {d.recipientEmail || "no recipient"}{d.identityVerified ? " (identity verified)" : ""} - expires {fmtDate(d.expiresAt, true)} - opened {d.accessCount}x - email {d.emailState}</span>
                  {d.status === "ACTIVE" && canGenerate && <Button tone="danger" disabled={!!busy} onClick={() => act("revoke", () => api(`${BASE}/documents/${documentId}/deliveries/${d.id}?orgId=${orgId}&reason=revoked%20by%20sender`, { method: "DELETE" }))}>Revoke</Button>}
                </li>))}</ul>
            )}
          </Section>
          <Section title="Recipient access log">
            {history.accessEvents.length === 0 ? <p className="text-xs">No access yet.</p> : <ul className="space-y-1 text-xs">{history.accessEvents.map((e) => <li key={e.id}>{fmtDate(e.at, true)} - {e.type} - {e.result} - {e.mode} {e.recipient ? `- ${e.recipient}` : ""}</li>)}</ul>}
          </Section>
        </div>
      )}

      {tab === "Versions" && history && (
        <Section title="Every version of this document">
          <ul className="space-y-1 text-xs">{history.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-2"><span className="font-semibold">v{v.version}</span><StatusPill status={v.status} /><span className="font-mono text-[10px]">{shortHash(v.documentHash)}</span><span className="text-[var(--inaya-text-muted)]">{fmtDate(v.finalizedAt || v.createdAt, true)}</span>{v.id === doc.id && <Pill>this one</Pill>}</li>))}</ul>
          <p className="mt-2 text-[11px] text-[var(--inaya-text-muted)]">Corrections create a new version under the same number. A finalized version is never edited; when its successor is finalized it is marked superseded and its links stop working.</p>
        </Section>
      )}
    </div>
  );
}

export { randomKey };
