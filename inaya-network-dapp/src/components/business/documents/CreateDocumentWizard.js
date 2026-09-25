"use client";

// Create Document -> Select Type -> Select Record -> Review Data -> Preview ->
// Generate (SOW §32). Every number shown here comes from the server's own
// calculation (the preview endpoint); nothing is computed in the browser.

import { useState, useEffect, useRef, useCallback } from "react";
import { api, BASE, Button, Field, inputClass, ErrorNote, Section, money, pdfBlobUrl, randomKey, LinesEditor, cleanLines, Pill } from "./shared";

const STEPS = ["Type", "Record", "Options", "Review & preview"];

export default function CreateDocumentWizard({ orgId, types, templates, onCreated }) {
  const [step, setStep] = useState(0);
  const [type, setType] = useState(null);
  const [records, setRecords] = useState([]);
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState(null);
  const [opts, setOpts] = useState({ lines: [{ description: "", quantity: "1", unitPrice: "", taxPercent: "" }], reason: "", validUntil: "", notes: "", periodFrom: "", periodTo: "", currency: "", delivered: {} });
  const [templateId, setTemplateId] = useState("");
  const [locale, setLocale] = useState("");
  const [pageSize, setPageSize] = useState("");
  const [preview, setPreview] = useState(null);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sourceLines, setSourceLines] = useState([]);
  const keyRef = useRef(randomKey());

  const chosen = types.find((t) => t.id === type);
  const typeTemplates = templates.filter((t) => t.documentType === type && t.status !== "ARCHIVED");

  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  const loadRecords = useCallback(async (t) => {
    setRecords([]); setError("");
    try { setRecords((await api(`${BASE}/sources?orgId=${orgId}&documentType=${t}`)).records); } catch (e) { setError(e.message); }
  }, [orgId]);

  function pickType(t) {
    setType(t); setSource(null); setPreview(null); setPdfUrl(null); setTemplateId(""); keyRef.current = randomKey();
    loadRecords(t); setStep(1);
  }

  async function pickSource(r) {
    setSource(r); setPreview(null); setSourceLines([]); keyRef.current = randomKey();
    if (type === "delivery_note") {
      try {
        const inv = await api(`/api/orgs/finance/invoices/${r.id}?orgId=${orgId}`);
        setSourceLines(inv.lineItems || []);
        setOpts((o) => ({ ...o, delivered: Object.fromEntries((inv.lineItems || []).map((l, i) => [i, String(l.quantity)])) }));
      } catch (e) { setError(e.message); }
    }
    setStep(2);
  }

  function buildOptions() {
    const o = {};
    if (type === "quotation") {
      const lines = cleanLines(opts.lines);
      if (lines.length) o.lineItems = lines;
      if (opts.validUntil) o.validUntil = opts.validUntil;
      if (opts.notes) o.notes = opts.notes;
      if (opts.currency) o.currency = opts.currency;
    } else if (type === "credit_note" || type === "debit_note") {
      o.reason = opts.reason; o.lineItems = cleanLines(opts.lines);
      if (opts.notes) o.notes = opts.notes;
    } else if (type === "statement") {
      if (opts.periodFrom) o.periodFrom = opts.periodFrom;
      if (opts.periodTo) o.periodTo = opts.periodTo;
      if (opts.currency) o.currency = opts.currency;
    } else if (type === "delivery_note") {
      o.delivered = Object.fromEntries(Object.entries(opts.delivered).map(([i, v]) => [i, Number(v)]));
      if (opts.notes) o.notes = opts.notes;
    }
    return o;
  }

  const body = () => ({ orgId, documentType: type, sourceId: source.id, options: buildOptions(), ...(templateId ? { templateId } : {}), ...(locale ? { locale } : {}), ...(pageSize ? { pageSize } : {}) });

  async function runPreview() {
    setBusy("preview"); setError("");
    try {
      const res = await api(`${BASE}/preview`, { method: "POST", body: JSON.stringify(body()) });
      setPreview(res.preview);
      setPdfUrl(pdfBlobUrl(res.preview.pdfBase64));
      setStep(3);
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  }

  async function generate() {
    setBusy("generate"); setError("");
    try {
      // The idempotency key is stable for this attempt: a double click or a
      // retry after a network error returns the same document, never a second one.
      const res = await api(`${BASE}/documents`, { method: "POST", body: JSON.stringify({ ...body(), idempotencyKey: keyRef.current }) });
      onCreated(res.document);
    } catch (e) {
      setError(e.data?.validation ? `${e.message}` : e.message);
    } finally { setBusy(""); }
  }

  const shown = records.filter((r) => `${r.title} ${r.subtitle}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={`rounded-full border px-3 py-1 ${i === step ? "border-cyan-400/60 text-cyan-300" : i < step ? "border-emerald-400/30 text-emerald-300" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{i + 1}. {s}</li>
        ))}
      </ol>
      <ErrorNote error={error} />

      {step === 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {types.map((t) => (
            <button key={t.id} disabled={!t.canGenerate} onClick={() => pickType(t.id)} className="rounded-lg border border-white/10 p-4 text-left hover:border-cyan-400/50 disabled:opacity-40">
              <div className="text-sm font-semibold">{t.label}</div>
              <div className="mt-1 text-xs text-[var(--inaya-text-muted)]">From a {t.sourceKind}</div>
              {!t.canGenerate && <div className="mt-2 text-[11px] text-amber-300">You don&apos;t have permission to generate this.</div>}
            </button>
          ))}
        </div>
      )}

      {step === 1 && chosen && (
        <Section title={`Select a ${chosen.sourceKind}`} right={<Button onClick={() => setStep(0)}>Back</Button>}>
          <input className={`${inputClass} mb-3`} placeholder="Filter..." value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter records" />
          {records.length === 0 && <p className="text-xs text-[var(--inaya-text-muted)]">No records you can use yet.</p>}
          <ul className="max-h-80 space-y-1 overflow-auto">
            {shown.map((r) => (
              <li key={r.id}>
                <button onClick={() => pickSource(r)} className="flex w-full items-center justify-between rounded-md border border-white/10 px-3 py-2 text-left text-sm hover:border-cyan-400/50">
                  <span><span className="font-semibold">{r.title}</span> <span className="text-xs text-[var(--inaya-text-muted)]">{r.subtitle}</span></span>
                  {r.amount !== undefined && r.amount !== null && <span className="text-xs">{money(r.amount, r.currency)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {step === 2 && chosen && source && (
        <Section title={`${chosen.label} for ${source.title}`} right={<Button onClick={() => setStep(1)}>Back</Button>}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Template">
              <select className={inputClass} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Default for {chosen.label}</option>
                {typeTemplates.map((t) => <option key={`${t.templateId}`} value={t.templateId}>{t.name}{t.isSystem ? "" : ` (v${t.version})`}</option>)}
              </select>
            </Field>
            <Field label="Language / locale">
              <select className={inputClass} value={locale} onChange={(e) => setLocale(e.target.value)}>
                <option value="">Organization default</option>
                {["en-US", "en-GB", "ar-AE", "ur-PK", "fr-FR", "de-DE", "es-ES"].map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </Field>
            <Field label="Page size">
              <select className={inputClass} value={pageSize} onChange={(e) => setPageSize(e.target.value)}>
                <option value="">Organization default</option><option value="A4">A4</option><option value="LETTER">Letter</option>
              </select>
            </Field>
          </div>

          {type === "quotation" && (
            <div className="mt-4 space-y-3">
              <p className="text-xs text-[var(--inaya-text-muted)]">Leave the lines empty to quote the deal&apos;s own value as one line.</p>
              <LinesEditor lines={opts.lines} onChange={(lines) => setOpts({ ...opts, lines })} />
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Valid until"><input type="date" className={inputClass} value={opts.validUntil} onChange={(e) => setOpts({ ...opts, validUntil: e.target.value })} /></Field>
                <Field label="Currency"><select className={inputClass} value={opts.currency} onChange={(e) => setOpts({ ...opts, currency: e.target.value })}><option value="">Default</option>{["USD", "EUR", "GBP", "AED", "PKR"].map((c) => <option key={c}>{c}</option>)}</select></Field>
                <Field label="Notes"><input className={inputClass} value={opts.notes} onChange={(e) => setOpts({ ...opts, notes: e.target.value })} /></Field>
              </div>
            </div>
          )}
          {(type === "credit_note" || type === "debit_note") && (
            <div className="mt-4 space-y-3">
              <Field label="Reason (required)"><input className={inputClass} value={opts.reason} onChange={(e) => setOpts({ ...opts, reason: e.target.value })} /></Field>
              <p className="text-xs text-[var(--inaya-text-muted)]">{type === "credit_note" ? "Lines being credited. The total can never exceed the invoice (less earlier credit notes)." : "Additional charges being debited."}</p>
              <LinesEditor lines={opts.lines} onChange={(lines) => setOpts({ ...opts, lines })} />
              <Field label="Notes"><input className={inputClass} value={opts.notes} onChange={(e) => setOpts({ ...opts, notes: e.target.value })} /></Field>
            </div>
          )}
          {type === "statement" && (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Field label="From"><input type="date" className={inputClass} value={opts.periodFrom} onChange={(e) => setOpts({ ...opts, periodFrom: e.target.value })} /></Field>
              <Field label="To"><input type="date" className={inputClass} value={opts.periodTo} onChange={(e) => setOpts({ ...opts, periodTo: e.target.value })} /></Field>
              <Field label="Currency" hint="Required if the customer has invoices in several currencies."><select className={inputClass} value={opts.currency} onChange={(e) => setOpts({ ...opts, currency: e.target.value })}><option value="">Auto</option>{["USD", "EUR", "GBP", "AED", "PKR"].map((c) => <option key={c}>{c}</option>)}</select></Field>
            </div>
          )}
          {type === "delivery_note" && (
            <div className="mt-4 space-y-2">
              <p className="text-xs text-[var(--inaya-text-muted)]">Quantity delivered per line (defaults to the full quantity).</p>
              {sourceLines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 items-center gap-2 text-sm">
                  <span className="col-span-7 truncate">{l.description}</span>
                  <span className="col-span-2 text-xs text-[var(--inaya-text-muted)]">ordered {l.quantity}</span>
                  <input aria-label={`Delivered for line ${i + 1}`} className={`${inputClass} col-span-3`} value={opts.delivered[i] ?? ""} onChange={(e) => setOpts({ ...opts, delivered: { ...opts.delivered, [i]: e.target.value } })} />
                </div>
              ))}
            </div>
          )}
          <div className="mt-5"><Button tone="primary" disabled={busy === "preview"} onClick={runPreview}>{busy === "preview" ? "Rendering preview..." : "Review data & preview"}</Button></div>
        </Section>
      )}

      {step === 3 && preview && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <Section title="Source" right={<Button onClick={() => setStep(2)}>Back</Button>}>
              <div className="text-sm">{preview.sourceSummary.counterparty?.name || source.title}</div>
              <div className="mt-1 text-xs text-[var(--inaya-text-muted)]">{preview.sourceSummary.records.length} source record(s) - source fingerprint {preview.sourceDataHash.slice(0, 16)}...</div>
              <div className="mt-2 text-xs">Template: <span className="font-semibold">{preview.template.name}</span> v{preview.template.version} - {preview.locale} - {preview.pageSize} - {preview.pages} page(s)</div>
            </Section>
            <Section title="Calculation (computed by the server, exact to the currency's minor unit)">
              <table className="w-full text-xs"><tbody>
                {[["Subtotal", preview.calculation.subtotal], ["Line discounts", -preview.calculation.lineDiscountTotal], ["Invoice discount", -preview.calculation.invoiceDiscount], ["Tax", preview.calculation.totalTax], ["Shipping", preview.calculation.shipping], ["Fees", preview.calculation.fees]].filter(([, v]) => v).map(([k, v]) => (
                  <tr key={k}><td className="py-0.5">{k}</td><td className="py-0.5 text-right">{money(v, preview.calculation.currency)}</td></tr>
                ))}
                <tr className="border-t border-white/10 font-bold"><td className="py-1">Total</td><td className="py-1 text-right">{money(preview.calculation.grandTotal, preview.calculation.currency)}</td></tr>
                {preview.calculation.amountPaid ? <tr><td>Paid</td><td className="text-right">{money(preview.calculation.amountPaid, preview.calculation.currency)}</td></tr> : null}
                {preview.calculation.amountPaid ? <tr className="font-bold"><td>Amount due</td><td className="text-right">{money(preview.calculation.amountDue, preview.calculation.currency)}</td></tr> : null}
              </tbody></table>
            </Section>
            <Section title="Validation">
              {preview.validation.checks.length === 0 ? <p className="text-xs text-emerald-300">All checks passed.</p> : (
                <ul className="space-y-1.5 text-xs">
                  {preview.validation.checks.map((c) => (
                    <li key={c.id} className="flex gap-2"><Pill className={c.severity === "error" ? "bg-red-400/10 text-red-400 border-red-400/30" : c.severity === "warning" ? "bg-amber-400/10 text-amber-400 border-amber-400/30" : ""}>{c.severity}</Pill><span title={c.rule}>{c.message}</span></li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Approval">
              <p className="text-xs">{preview.approval.required ? "Approval will be required before this can be finalized." : "No approval required."} <span className="text-[var(--inaya-text-muted)]">{preview.approval.reason}</span></p>
            </Section>
            <div className="flex gap-2">
              <Button tone="primary" disabled={busy === "generate" || !preview.validation.passed} onClick={generate}>{busy === "generate" ? "Generating & storing..." : "Generate document"}</Button>
              {!preview.validation.passed && <span className="text-xs text-red-300">Fix the errors above first.</span>}
            </div>
          </div>
          <Section title="Preview (watermarked - not an official document)">
            {pdfUrl && <iframe title="Document preview" src={pdfUrl} className="h-[70vh] w-full rounded-md border border-white/10 bg-white" />}
          </Section>
        </div>
      )}
    </div>
  );
}
