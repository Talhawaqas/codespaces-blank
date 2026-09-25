"use client";

// Organization document settings (SOW §5/§6/§7/§10/§21/§22): the billing
// profile printed on documents (legal name, address, tax id, logo, brand
// color, default tax and payment terms), numbering, approval thresholds,
// defaults and retention -- plus the auditable number ledger.

import { useState, useEffect, useCallback } from "react";
import { api, BASE, Button, Field, inputClass, ErrorNote, Section, fmtDate, Pill } from "./shared";

const TYPES = ["invoice", "purchase_order", "quotation", "receipt", "statement", "credit_note", "debit_note", "delivery_note", "business_report"];

export default function SettingsPanel({ orgId, canManage }) {
  const [s, setS] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [ledgerType, setLedgerType] = useState("invoice");
  const [ledger, setLedger] = useState(null);

  const load = useCallback(async () => {
    try { const r = await api(`${BASE}/settings?orgId=${orgId}`); setS(r.settings); setDraft(JSON.parse(JSON.stringify(r.settings))); } catch (e) { setError(e.message); }
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  const loadLedger = useCallback(async () => {
    try { setLedger(await api(`${BASE}/numbers?orgId=${orgId}&documentType=${ledgerType}`)); } catch (e) { setLedger({ error: e.message }); }
  }, [orgId, ledgerType]);
  useEffect(() => { if (canManage) loadLedger(); }, [canManage, loadLedger]);

  if (!draft) return <div className="text-sm text-[var(--inaya-text-muted)]">{error || "Loading..."}</div>;

  const set = (path, value) => setDraft((d) => { const c = JSON.parse(JSON.stringify(d)); let o = c; const keys = path.split("."); keys.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; }); o[keys.at(-1)] = value; return c; });
  const num = (v) => (v === "" ? null : Number(v));

  async function save(section) {
    setBusy(true); setError(""); setSaved("");
    try {
      const body = { orgId, [section]: draft[section] };
      if (section === "billingProfile") { const { logo, ...rest } = draft.billingProfile; body.billingProfile = rest; if (draft.billingProfile._newLogo) body.billingProfile.logo = draft.billingProfile._newLogo; delete body.billingProfile._newLogo; }
      const r = await api(`${BASE}/settings`, { method: "PUT", body: JSON.stringify(body) });
      setS(r.settings); setDraft(JSON.parse(JSON.stringify(r.settings))); setSaved("Saved.");
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  function onLogo(file) {
    if (!file) return;
    if (file.size > 200 * 1024) { setError("The logo must be 200 KB or smaller."); return; }
    const reader = new FileReader();
    reader.onload = () => { const dataBase64 = String(reader.result).split(",")[1]; set("billingProfile._newLogo", { contentType: file.type, dataBase64 }); setSaved("Logo ready - press Save billing profile."); };
    reader.readAsDataURL(file);
  }

  const bp = draft.billingProfile;
  const addr = bp.address || {};
  const dis = !canManage;

  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      {saved && <div className="text-xs text-emerald-300" role="status">{saved}</div>}
      {dis && <p className="text-xs text-[var(--inaya-text-muted)]">Only a Finance Manager or an owner/admin can change these settings.</p>}

      <Section title="Billing profile (printed on every document)" right={<Button tone="primary" disabled={busy || dis} onClick={() => save("billingProfile")}>Save billing profile</Button>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Legal name"><input className={inputClass} disabled={dis} value={bp.legalName || ""} onChange={(e) => set("billingProfile.legalName", e.target.value)} /></Field>
          <Field label="Billing email"><input className={inputClass} disabled={dis} value={bp.email || ""} onChange={(e) => set("billingProfile.email", e.target.value)} /></Field>
          <Field label="Phone"><input className={inputClass} disabled={dis} value={bp.phone || ""} onChange={(e) => set("billingProfile.phone", e.target.value)} /></Field>
          <Field label="Tax ID / registration"><input className={inputClass} disabled={dis} value={bp.taxId || ""} onChange={(e) => set("billingProfile.taxId", e.target.value)} /></Field>
          <Field label="Tax ID label" hint="e.g. VAT, TRN, NTN"><input className={inputClass} disabled={dis} value={bp.taxLabel || ""} onChange={(e) => set("billingProfile.taxLabel", e.target.value)} /></Field>
          <Field label="Website"><input className={inputClass} disabled={dis} placeholder="https://" value={bp.website || ""} onChange={(e) => set("billingProfile.website", e.target.value)} /></Field>
          {[["line1", "Address line 1"], ["line2", "Address line 2"], ["city", "City"], ["region", "State / region"], ["postalCode", "Postal code"], ["country", "Country"]].map(([k, label]) => (
            <Field key={k} label={label}><input className={inputClass} disabled={dis} value={addr[k] || ""} onChange={(e) => set("billingProfile.address", { ...addr, [k]: e.target.value })} /></Field>
          ))}
          <Field label="Brand color"><input className={inputClass} disabled={dis} placeholder="#0a5f6e" value={bp.brandColor || ""} onChange={(e) => set("billingProfile.brandColor", e.target.value)} /></Field>
          <Field label="Default tax %" hint="Applied to invoice lines that have no rate of their own."><input className={inputClass} disabled={dis} inputMode="decimal" value={bp.defaultTaxPercent ?? 0} onChange={(e) => set("billingProfile.defaultTaxPercent", num(e.target.value) ?? 0)} /></Field>
          <Field label="Default payment terms"><input className={inputClass} disabled={dis} value={bp.defaultPaymentTerms || ""} onChange={(e) => set("billingProfile.defaultPaymentTerms", e.target.value)} /></Field>
          <Field label="Footer note"><input className={inputClass} disabled={dis} value={bp.footerNote || ""} onChange={(e) => set("billingProfile.footerNote", e.target.value)} /></Field>
          <Field label="Default terms & conditions"><input className={inputClass} disabled={dis} value={bp.defaultTerms || ""} onChange={(e) => set("billingProfile.defaultTerms", e.target.value)} /></Field>
          <Field label="Logo (PNG or JPEG, up to 200 KB)" hint={s.billingProfile.logo?.present ? `A logo is set (${Math.round((s.billingProfile.logo.bytes || 0) / 1024)} KB).` : "No logo set."}><input type="file" accept="image/png,image/jpeg" disabled={dis} onChange={(e) => onLogo(e.target.files?.[0])} /></Field>
        </div>
      </Section>

      <Section title="Numbering" right={<Button tone="primary" disabled={busy || dis} onClick={() => save("numbering")}>Save numbering</Button>}>
        <div className="grid gap-3 sm:grid-cols-4">
          {TYPES.map((t) => <Field key={t} label={`${t.replace("_", " ")} prefix`}><input className={inputClass} disabled={dis} value={draft.numbering.prefixes[t] || ""} onChange={(e) => set(`numbering.prefixes.${t}`, e.target.value.toUpperCase())} /></Field>)}
          <Field label="Separator"><select className={inputClass} disabled={dis} value={draft.numbering.separator} onChange={(e) => set("numbering.separator", e.target.value)}>{["-", "/", "."].map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Number padding"><input className={inputClass} disabled={dis} inputMode="numeric" value={draft.numbering.padding} onChange={(e) => set("numbering.padding", Number(e.target.value))} /></Field>
          <Field label="Fiscal-year start month"><input className={inputClass} disabled={dis} inputMode="numeric" value={draft.numbering.fiscalYearStartMonth} onChange={(e) => set("numbering.fiscalYearStartMonth", Number(e.target.value))} /></Field>
          <label className="flex items-end gap-2 text-xs"><input type="checkbox" disabled={dis} checked={draft.numbering.fiscalYearReset !== false} onChange={(e) => set("numbering.fiscalYearReset", e.target.checked)} /> Restart numbering each fiscal year</label>
        </div>
        <p className="mt-2 text-[11px] text-[var(--inaya-text-muted)]">Numbers are allocated atomically on the server and are never reused: a cancelled or voided document keeps its number, recorded in the ledger below.</p>
      </Section>

      <Section title="Approval policy" right={<Button tone="primary" disabled={busy || dis} onClick={() => save("approval")}>Save approval policy</Button>}>
        <p className="mb-2 text-xs text-[var(--inaya-text-muted)]">A document at or above its threshold needs a second person to approve the exact version. Leave a threshold empty for &quot;never by amount&quot;. Force or waive approval per type with the selector. Segregation of duties (no self-approval) follows the SoD rules in Settings.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {TYPES.map((t) => (
            <div key={t} className="rounded-md border border-white/10 p-2">
              <div className="mb-1 text-xs font-semibold">{t.replace("_", " ")}</div>
              <input className={inputClass} disabled={dis} inputMode="decimal" placeholder="threshold" value={draft.approval.thresholds[t] ?? ""} onChange={(e) => set(`approval.thresholds.${t}`, num(e.target.value))} aria-label={`${t} approval threshold`} />
              <select className={`${inputClass} mt-1`} disabled={dis} value={draft.approval.alwaysRequire[t] === undefined ? "" : String(draft.approval.alwaysRequire[t])} onChange={(e) => { const v = e.target.value; const c = { ...draft.approval.alwaysRequire }; if (v === "") delete c[t]; else c[t] = v === "true"; set("approval.alwaysRequire", c); }} aria-label={`${t} approval override`}>
                <option value="">Use threshold</option><option value="true">Always require</option><option value="false">Never require</option>
              </select>
            </div>
          ))}
          <Field label="Approval request goes stale after (days)"><input className={inputClass} disabled={dis} inputMode="numeric" value={draft.approval.staleAfterDays} onChange={(e) => set("approval.staleAfterDays", Number(e.target.value))} /></Field>
        </div>
      </Section>

      <Section title="Defaults & retention" right={<div className="flex gap-2"><Button tone="primary" disabled={busy || dis} onClick={() => save("defaults")}>Save defaults</Button><Button tone="primary" disabled={busy || dis} onClick={() => save("retention")}>Save retention</Button></div>}>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Default language"><select className={inputClass} disabled={dis} value={draft.defaults.locale} onChange={(e) => set("defaults.locale", e.target.value)}>{["en-US", "en-GB", "ar-AE", "ur-PK", "fr-FR", "de-DE", "es-ES"].map((l) => <option key={l}>{l}</option>)}</select></Field>
          <Field label="Default currency"><select className={inputClass} disabled={dis} value={draft.defaults.currency} onChange={(e) => set("defaults.currency", e.target.value)}>{["USD", "EUR", "GBP", "AED", "PKR"].map((l) => <option key={l}>{l}</option>)}</select></Field>
          <Field label="Page size"><select className={inputClass} disabled={dis} value={draft.defaults.pageSize} onChange={(e) => set("defaults.pageSize", e.target.value)}><option value="A4">A4</option><option value="LETTER">Letter</option></select></Field>
          <Field label="Rounding"><select className={inputClass} disabled={dis} value={draft.defaults.roundingMode} onChange={(e) => set("defaults.roundingMode", e.target.value)}>{["HALF_UP", "HALF_EVEN", "DOWN", "UP"].map((l) => <option key={l}>{l}</option>)}</select></Field>
          {["top", "right", "bottom", "left"].map((m) => <Field key={m} label={`Margin ${m} (pt)`}><input className={inputClass} disabled={dis} inputMode="numeric" value={draft.defaults.margins[m]} onChange={(e) => set(`defaults.margins.${m}`, Number(e.target.value))} /></Field>)}
          <Field label="Retention lock (days)" hint="Finalized documents cannot be deleted or altered in storage for this long."><input className={inputClass} disabled={dis} inputMode="numeric" value={draft.retention.finalizedRetentionDays} onChange={(e) => set("retention.finalizedRetentionDays", Number(e.target.value))} /></Field>
          <Field label="Lock mode"><select className={inputClass} disabled={dis} value={draft.retention.lockMode} onChange={(e) => set("retention.lockMode", e.target.value)}><option>GOVERNANCE</option><option>COMPLIANCE</option></select></Field>
        </div>
      </Section>

      {canManage && (
        <Section title="Number ledger" right={<select className={`${inputClass} max-w-[200px]`} value={ledgerType} onChange={(e) => setLedgerType(e.target.value)} aria-label="Ledger document type">{TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}</select>}>
          {ledger?.error && <ErrorNote error={ledger.error} />}
          {ledger?.report && (
            <div className="mb-2 text-xs">{ledger.report.total} numbers - {ledger.report.cancelled.length} cancelled, {ledger.report.voided.length} voided, {ledger.report.failed.length} failed - {ledger.report.unaccountedSequences.length === 0 ? <span className="text-emerald-300">every sequence value is accounted for</span> : <span className="text-red-300">unaccounted: {ledger.report.unaccountedSequences.join(", ")}</span>}</div>
          )}
          <div className="max-h-64 overflow-auto"><table className="w-full text-xs"><thead><tr className="text-left text-[var(--inaya-text-muted)]"><th>Number</th><th>Status</th><th>Allocated</th><th>Reason</th></tr></thead><tbody>
            {(ledger?.ledger || []).map((r) => <tr key={r.number}><td className="py-0.5 font-mono">{r.number}</td><td><Pill>{r.status}</Pill></td><td>{fmtDate(r.allocatedAt, true)}</td><td>{r.statusReason || ""}</td></tr>)}
          </tbody></table></div>
        </Section>
      )}
    </div>
  );
}
