"use client";

// Template registry + authoring (SOW §5/§23/§38). Templates are DATA in a
// safe, closed language -- the editor validates on the server on every save,
// so an invalid or unsafe spec can never be stored, and a published version
// can never be edited (create a new version instead).

import { useState, useEffect, useCallback } from "react";
import { api, BASE, Button, Field, inputClass, ErrorNote, Section, Pill, fmtDate, shortHash, pdfBlobUrl } from "./shared";

export default function TemplatesPanel({ orgId, types, canManage, onChanged }) {
  const [templates, setTemplates] = useState([]);
  const [typeFilter, setTypeFilter] = useState("");
  const [open, setOpen] = useState(null);
  const [versions, setVersions] = useState([]);
  const [specText, setSpecText] = useState("");
  const [errors, setErrors] = useState([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState("");
  const [lang, setLang] = useState(null);
  const [sources, setSources] = useState([]);
  const [previewSource, setPreviewSource] = useState("");
  const [pdfUrl, setPdfUrl] = useState(null);
  const [cloneName, setCloneName] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api(`${BASE}/templates?orgId=${orgId}${typeFilter ? `&documentType=${typeFilter}` : ""}&includeArchived=1`);
      setTemplates(r.templates);
    } catch (e) { setError(e.message); }
  }, [orgId, typeFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api(`${BASE}/types?orgId=${orgId}`).then((r) => setLang(r.templateLanguage)).catch(() => {}); }, [orgId]);
  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  async function openTemplate(t) {
    setOpen(t); setErrors([]); setError(""); setInfo(""); setPdfUrl(null);
    setSpecText(JSON.stringify(t.spec, null, 2));
    try { setVersions((await api(`${BASE}/templates/${encodeURIComponent(t.templateId)}/versions?orgId=${orgId}`)).versions); } catch { setVersions([]); }
    try { setSources((await api(`${BASE}/sources?orgId=${orgId}&documentType=${t.documentType}`)).records); setPreviewSource(""); } catch { setSources([]); }
  }

  async function run(name, fn) {
    setBusy(name); setError(""); setErrors([]); setInfo("");
    try { await fn(); await load(); onChanged?.(); } catch (e) { setError(e.message); setErrors(e.data?.errors || []); } finally { setBusy(""); }
  }

  const parsed = () => { try { return JSON.parse(specText); } catch { throw new Error("The template is not valid JSON."); } };

  async function preview() {
    setBusy("preview"); setError("");
    try {
      const res = await api(`${BASE}/preview`, { method: "POST", body: JSON.stringify({ orgId, documentType: open.documentType, sourceId: previewSource, templateId: open.templateId, templateVersion: open.version }) });
      setPdfUrl(pdfBlobUrl(res.preview.pdfBase64));
    } catch (e) { setError(e.message); } finally { setBusy(""); }
  }

  const isDraft = open && !open.isSystem && open.status === "DRAFT";

  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Document type"><select className={inputClass} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}><option value="">All</option>{types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>
        {!canManage && <p className="text-xs text-[var(--inaya-text-muted)]">Only an owner or admin can create and publish templates. You can preview and use published ones.</p>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Section title="Templates">
          <ul className="max-h-[60vh] space-y-1 overflow-auto">
            {templates.map((t) => (
              <li key={`${t.templateId}@${t.version}`}>
                <button onClick={() => openTemplate(t)} className={`w-full rounded-md border px-2.5 py-2 text-left text-xs ${open && open.templateId === t.templateId && open.version === t.version ? "border-cyan-400/60" : "border-white/10"}`}>
                  <div className="flex items-center justify-between gap-2"><span className="font-semibold">{t.name}</span><Pill className={t.status === "PUBLISHED" ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" : t.status === "DRAFT" ? "bg-amber-400/10 text-amber-400 border-amber-400/30" : ""}>{t.isSystem ? "system" : `v${t.version} ${t.status.toLowerCase()}`}</Pill></div>
                  <div className="mt-0.5 text-[var(--inaya-text-muted)]">{t.documentType.replace("_", " ")}</div>
                </button>
              </li>
            ))}
          </ul>
        </Section>

        <div className="space-y-4">
          {!open && (
            <Section title="Template authoring guide">
              <div className="space-y-2 text-xs text-[var(--inaya-text-muted)]">
                <p>A template is a JSON document in a safe, closed language: blocks such as header, parties, table, totals and text; field references like <code>{"{{party.name}}"}</code>; and controlled conditions like <code>{`{"path":"calc.totalTax","op":"gt","value":0}`}</code>. It cannot run code, call the network, touch the database or read files.</p>
                <p>Pick a template on the left, <strong>Clone</strong> a system template into your own draft, edit it, preview it with a real record, then publish. A published version is immutable; changes are a new version, and every document records the exact version and hash it used.</p>
                {lang && (<>
                  <p><strong>Blocks:</strong> {lang.blockTypes.join(", ")}. <strong>Formats:</strong> {lang.formats.join(", ")}. <strong>Operators:</strong> {lang.conditionOps.join(", ")}.</p>
                  <details><summary className="cursor-pointer text-cyan-300">Available fields</summary><p className="mt-1 break-words font-mono text-[10px]">{lang.fieldPaths.join("  ")}</p></details>
                  <details><summary className="cursor-pointer text-cyan-300">Table sources and columns</summary><pre className="mt-1 text-[10px]">{JSON.stringify(lang.tableSources, null, 2)}</pre></details>
                  <details><summary className="cursor-pointer text-cyan-300">Label keys (localized)</summary><p className="mt-1 break-words font-mono text-[10px]">{lang.labelKeys.join("  ")}</p></details>
                </>)}
              </div>
            </Section>
          )}
          {open && (
            <Section title={`${open.name} - ${open.isSystem ? "system template" : `version ${open.version} (${open.status.toLowerCase()})`}`} right={<span className="font-mono text-[10px] text-[var(--inaya-text-muted)]">{shortHash(open.specHash)}</span>}>
              {open.changeNote && <p className="mb-2 text-xs text-[var(--inaya-text-muted)]">{open.changeNote}</p>}
              <textarea aria-label="Template JSON" className={`${inputClass} h-80 font-mono text-[11px]`} spellCheck={false} value={specText} onChange={(e) => setSpecText(e.target.value)} readOnly={!isDraft} />
              {errors.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-red-300">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
              {info && <p className="mt-2 text-xs text-emerald-300">{info}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {canManage && open.isSystem && <><input className={`${inputClass} max-w-[220px]`} placeholder="Name for your copy" value={cloneName} onChange={(e) => setCloneName(e.target.value)} aria-label="Name for your copy" /><Button tone="primary" disabled={!!busy} onClick={() => run("clone", async () => { const r = await api(`${BASE}/templates`, { method: "POST", body: JSON.stringify({ orgId, cloneFrom: open.templateId, name: cloneName || `${open.name} (custom)` }) }); setInfo("Draft created."); await openTemplate(r.template); })}>Clone into a draft</Button></>}
                {canManage && isDraft && <Button tone="primary" disabled={!!busy} onClick={() => run("save", async () => { const r = await api(`${BASE}/templates/${encodeURIComponent(open.templateId)}`, { method: "PATCH", body: JSON.stringify({ orgId, version: open.version, spec: parsed() }) }); setOpen(r.template); setSpecText(JSON.stringify(r.template.spec, null, 2)); setInfo("Saved. The template is valid."); })}>Save draft</Button>}
                {canManage && isDraft && <Button tone="good" disabled={!!busy} onClick={() => run("publish", async () => { const r = await api(`${BASE}/templates/${encodeURIComponent(open.templateId)}/publish`, { method: "POST", body: JSON.stringify({ orgId, version: open.version }) }); setOpen(r.template); setInfo("Published. This version is now immutable."); })}>Publish</Button>}
                {canManage && !open.isSystem && open.status !== "DRAFT" && <Button disabled={!!busy} onClick={() => run("version", async () => { const r = await api(`${BASE}/templates/${encodeURIComponent(open.templateId)}/versions`, { method: "POST", body: JSON.stringify({ orgId, spec: parsed(), changeNote: "New version" }) }); await openTemplate(r.template); setInfo("New draft version created."); })}>New version from this</Button>}
                {canManage && !open.isSystem && open.status !== "ARCHIVED" && <Button tone="danger" disabled={!!busy} onClick={() => run("archive", async () => { await api(`${BASE}/templates/${encodeURIComponent(open.templateId)}?orgId=${orgId}&version=${open.version}`, { method: "DELETE" }); setInfo("Archived. Historical documents keep their exact copy."); setOpen(null); })}>Archive version</Button>}
              </div>
              <div className="mt-4 grid items-end gap-3 sm:grid-cols-[1fr_auto]">
                <Field label="Preview with a real record"><select className={inputClass} value={previewSource} onChange={(e) => setPreviewSource(e.target.value)}><option value="">Choose...</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.title} - {s.subtitle}</option>)}</select></Field>
                <Button disabled={!previewSource || busy === "preview"} onClick={preview}>{busy === "preview" ? "Rendering..." : "Preview saved version"}</Button>
              </div>
              {pdfUrl && <iframe title="Template preview" src={pdfUrl} className="mt-3 h-[60vh] w-full rounded-md border border-white/10 bg-white" />}
              {versions.length > 1 && (
                <div className="mt-4 text-xs"><div className="mb-1 font-bold uppercase tracking-wide text-[var(--inaya-text-muted)]">Versions</div>
                  <ul className="space-y-0.5">{versions.map((v) => <li key={v.version}>v{v.version} - {v.status.toLowerCase()} - {fmtDate(v.publishedAt || v.updatedAt)} - <span className="font-mono text-[10px]">{shortHash(v.specHash)}</span></li>)}</ul></div>
              )}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
