"use client";
// src/components/whyInaya/Explainer.js -- opt-in AI business explainer (SOW section 5 + owner's avatar change).
// consent -> short skippable questions -> server explanation (/api/why-inaya/explain) -> avatar stage + visual + transcript.
// If the AI service fails, the same deterministic explanation is built here from the visitor's answers and the published
// prices (template wording only), so the visitor always gets an explanation. Answers never go to analytics.
import { useEffect, useRef, useState } from "react";
import { CATEGORIES, STAFF_BANDS, BRANCH_BANDS, ORDER_BANDS, INDUSTRIES, CHALLENGES, computeResult, formatMoney } from "../../lib/whyInaya/savings.js";
import { buildScript } from "../../lib/whyInaya/script.js";
import AvatarStage from "./AvatarStage.js";

const GOLD = "#d4a24c";
const field = "w-full min-h-[40px] bg-[#111a2b] border border-white/20 rounded-lg px-3 text-[14px] text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white";
const label = "block text-[13px] font-semibold text-[#e2e8f0] mb-1";

function Dialog({ title, onClose, children, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement; const el = ref.current; el?.querySelector("button, input, select, a")?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && el) { const f = [...el.querySelectorAll("button:not([disabled]), input, select, a[href], [tabindex='0']")]; if (!f.length) return; const first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    };
    document.addEventListener("keydown", onKey); document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="wi-dialog-title" className={`bg-[#0d1420] border border-white/10 w-full ${wide ? "sm:max-w-5xl" : "sm:max-w-xl"} max-h-[100dvh] sm:max-h-[92vh] overflow-y-auto sm:rounded-2xl p-5 sm:p-7 text-[#e2e8f0]`}>
        <div className="flex items-start justify-between gap-3"><h2 id="wi-dialog-title" className="text-xl font-extrabold text-white">{title}</h2><button type="button" onClick={onClose} aria-label="Close" className="text-[#cbd5e1] hover:text-white text-2xl leading-none px-2 focus-visible:outline focus-visible:outline-2 rounded">×</button></div>
        {children}
      </div>
    </div>
  );
}

export default function Explainer({ prices, onClose, track }) {
  const [step, setStep] = useState("consent"); // consent | form | loading | result | error
  const [a, setA] = useState({ region: "", industry: "", staff: "", branches: "", sellsInPerson: false, sellsOnline: false, channels: [], orders: "", challenge: "", tools: [], time: { hoursPerWeek: "", people: "", hourlyCost: "", reductionPct: "" } });
  const [out, setOut] = useState(null); const [err, setErr] = useState("");
  const cur = a.region === "PK" ? "PKR" : "USD";
  const set = (k) => (e) => setA((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const toggleCh = (c) => setA((x) => ({ ...x, channels: x.channels.includes(c) ? x.channels.filter((y) => y !== c) : [...x.channels, c] }));
  const clean = () => ({ ...a, region: a.region || null, tools: a.tools.filter((t) => t.category && t.monthlyCost !== ""), time: Object.fromEntries(Object.entries(a.time).map(([k, v]) => [k, v === "" ? null : Number(v)])) });

  function localFallback(reason) {
    const result = computeResult(clean(), prices); const script = buildScript(result, {});
    setOut({ result, script, source: "local", sceneTokens: null }); setErr(reason); setStep("result");
  }
  async function submit() {
    track?.("ai_explainer_started"); setStep("loading"); setErr("");
    try {
      const r = await fetch("/api/why-inaya/explain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consent: true, answers: clean() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { if (r.status === 429) return localFallback(j.error || "Too many explanations from this connection in the last hour."); throw new Error(j.error || "failed"); }
      setOut(j); setStep("result");
    } catch { localFallback("The AI service didn't answer, so this explanation uses our standard wording; the figures are calculated the same way."); }
  }

  if (step === "consent") return (
    <Dialog title="A business explanation built around your needs" onClose={onClose}>
      <p className="mt-3 text-[14.5px] leading-relaxed">Would you like to see how Inaya Business OS could fit your business? Our AI-assisted guide can walk you through the relevant workflows and estimate potential operational savings using the information you choose to provide. It is an illustrative guide, not a financial guarantee.</p>
      <ul className="mt-4 text-[13px] text-[#cbd5e1] space-y-1.5 list-disc pl-5">
        <li>You answer a few multiple-choice questions; every one can be skipped. Don't enter customer, staff or supplier names, or any account details.</li>
        <li>Your answers are sent to Inaya's server and to an AI service (Google Gemini, or Groq if Gemini is busy) to word the explanation, and to Google's voice service if you press Play. Prices and savings are calculated by our own code, not by the AI.</li>
        <li>We don't save your answers or the result, and they are not used for marketing. Nothing plays until you press Play.</li>
      </ul>
      <div className="flex flex-wrap gap-3 mt-6">
        <button type="button" onClick={() => { track?.("ai_explainer_consent"); setStep("form"); }} className="px-5 py-3 rounded-xl text-sm font-bold text-[#0a0e14]" style={{ background: GOLD }}>Start my explanation</button>
        <button type="button" onClick={onClose} className="px-5 py-3 rounded-xl text-sm font-bold border border-white/20 text-white">Not now</button>
      </div>
      <p className="text-[11.5px] text-[#94a3b8] mt-4">See our <a className="underline" href="/privacy" target="_blank" rel="noopener noreferrer">privacy policy</a>.</p>
    </Dialog>
  );

  if (step === "form" || step === "loading") return (
    <Dialog title="Tell us a little about your business" onClose={onClose}>
      <p className="text-[13px] text-[#94a3b8] mt-1">Everything is optional. Choose "Not sure" or leave it blank.</p>
      <form className="mt-5 space-y-5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <fieldset><legend className={label}>Where is your business? (sets the currency)</legend>
          <div className="flex flex-wrap gap-2">{[["PK", "Pakistan (PKR)"], ["INTL", "Elsewhere (USD)"], ["", "Not sure (USD)"]].map(([v, l]) => <label key={l} className={`cursor-pointer rounded-lg px-3 py-2 border text-[13px] ${a.region === v ? "border-transparent text-[#0a0e14] font-bold" : "border-white/20"}`} style={a.region === v ? { background: GOLD } : undefined}><input type="radio" name="region" value={v} aria-label={l} checked={a.region === v} onChange={set("region")} className="sr-only" />{l}</label>)}</div>
        </fieldset>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div><label htmlFor="wi-ind" className={label}>Type of business</label><select id="wi-ind" value={a.industry} onChange={set("industry")} className={field}><option value="">Not sure</option>{Object.entries(INDUSTRIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div><label htmlFor="wi-staff" className={label}>Staff</label><select id="wi-staff" value={a.staff} onChange={set("staff")} className={field}><option value="">Not sure</option>{Object.keys(STAFF_BANDS).map((k) => <option key={k} value={k}>{k}</option>)}</select></div>
          <div><label htmlFor="wi-br" className={label}>Branches / locations</label><select id="wi-br" value={a.branches} onChange={set("branches")} className={field}><option value="">Not sure</option>{Object.keys(BRANCH_BANDS).map((k) => <option key={k} value={k}>{k}</option>)}</select></div>
        </div>
        <fieldset><legend className={label}>How do you sell?</legend>
          <div className="flex flex-wrap gap-4 text-[13.5px]"><label className="flex items-center gap-2"><input type="checkbox" aria-label="Sell in person" checked={a.sellsInPerson} onChange={set("sellsInPerson")} className="w-4 h-4" /> In person (shop, counter, restaurant)</label><label className="flex items-center gap-2"><input type="checkbox" aria-label="Sell online" checked={a.sellsOnline} onChange={set("sellsOnline")} className="w-4 h-4" /> Online</label></div>
          {a.sellsOnline && <div className="flex flex-wrap gap-4 text-[13px] mt-2 text-[#cbd5e1]">{[["own_site", "Own website"], ["shopify", "Shopify"], ["woocommerce", "WooCommerce"], ["marketplace", "Marketplace (e.g. Daraz, Amazon)"]].map(([v, l]) => <label key={v} className="flex items-center gap-2"><input type="checkbox" aria-label={l} checked={a.channels.includes(v)} onChange={() => toggleCh(v)} className="w-4 h-4" /> {l}</label>)}</div>}
          {a.sellsOnline && <div className="mt-2 max-w-xs"><label htmlFor="wi-ord" className={label}>Online orders a month</label><select id="wi-ord" value={a.orders} onChange={set("orders")} className={field}><option value="">Not sure</option>{Object.keys(ORDER_BANDS).filter((k) => k !== "none").map((k) => <option key={k} value={k}>{k}</option>)}</select></div>}
        </fieldset>
        <div className="max-w-md"><label htmlFor="wi-ch" className={label}>Main challenge</label><select id="wi-ch" value={a.challenge} onChange={set("challenge")} className={field}><option value="">Not sure</option>{Object.entries(CHALLENGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <details className="rounded-xl border border-white/10 p-4"><summary className="cursor-pointer font-semibold text-[14px]">Optional: what you pay for software today ({cur} a month)</summary>
          <p className="text-[12px] text-[#94a3b8] mt-2">Only used to compare with Inaya. Leave it empty and we won't guess.</p>
          {a.tools.map((t, i) => <div key={i} className="grid grid-cols-[1fr_120px_auto] gap-2 mt-2"><select aria-label={`Tool ${i + 1} type`} value={t.category} onChange={(e) => setA((x) => ({ ...x, tools: x.tools.map((y, j) => (j === i ? { ...y, category: e.target.value } : y)) }))} className={field}><option value="">Type of tool</option>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><input aria-label={`Tool ${i + 1} monthly cost in ${cur}`} inputMode="decimal" type="number" min="0" step="any" placeholder={cur} value={t.monthlyCost} onChange={(e) => setA((x) => ({ ...x, tools: x.tools.map((y, j) => (j === i ? { ...y, monthlyCost: e.target.value } : y)) }))} className={field} /><button type="button" aria-label={`Remove tool ${i + 1}`} onClick={() => setA((x) => ({ ...x, tools: x.tools.filter((_, j) => j !== i) }))} className="px-3 text-[#cbd5e1] border border-white/20 rounded-lg">×</button></div>)}
          {a.tools.length < 8 && <button type="button" onClick={() => setA((x) => ({ ...x, tools: [...x.tools, { category: "", monthlyCost: "" }] }))} className="mt-3 text-[13px] font-bold" style={{ color: GOLD }}>+ Add a tool</button>}
        </details>
        <details className="rounded-xl border border-white/10 p-4"><summary className="cursor-pointer font-semibold text-[14px]">Optional: time spent on manual work</summary>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
            {[["hoursPerWeek", "Hours a week"], ["people", "People doing it"], ["hourlyCost", `Cost per hour (${cur})`]].map(([k, l]) => <div key={k}><label htmlFor={`wi-${k}`} className={label}>{l}</label><input id={`wi-${k}`} type="number" min="0" step="any" inputMode="decimal" value={a.time[k]} onChange={(e) => setA((x) => ({ ...x, time: { ...x.time, [k]: e.target.value } }))} className={field} /></div>)}
          </div>
          <label htmlFor="wi-red" className={`${label} mt-3`}>Your own hypothetical reduction: {a.time.reductionPct === "" ? "none" : `${a.time.reductionPct}%`}</label>
          <input id="wi-red" type="range" min="0" max="60" step="5" value={a.time.reductionPct === "" ? 0 : a.time.reductionPct} onChange={(e) => setA((x) => ({ ...x, time: { ...x.time, reductionPct: e.target.value === "0" ? "" : e.target.value } }))} className="w-full" />
          <p className="text-[11.5px] text-[#94a3b8]">This is your assumption to explore, not a measured Inaya result.</p>
        </details>
        <div className="flex flex-wrap gap-3 pt-1">
          <button type="submit" disabled={step === "loading"} className="px-5 py-3 rounded-xl text-sm font-bold text-[#0a0e14] disabled:opacity-60" style={{ background: GOLD }}>{step === "loading" ? "Preparing your explanation…" : "Create my explanation"}</button>
          <button type="button" onClick={onClose} className="px-5 py-3 rounded-xl text-sm font-bold border border-white/20 text-white">Cancel</button>
        </div>
        {step === "loading" && <p role="status" className="text-[13px] text-[#cbd5e1]">Working out the configuration and wording (a few seconds)…</p>}
      </form>
    </Dialog>
  );

  const r = out.result; const m = (n) => formatMoney(n, r.currency);
  return (
    <Dialog title="How Inaya could work for your business" onClose={onClose} wide>
      {err && <p role="status" className="mt-3 text-[13px] text-amber-200">{err}</p>}
      <div className="mt-4"><AvatarStage script={out.script} sceneTokens={out.sceneTokens} currency={r.currency} track={track} /></div>
      {!out.sceneTokens && <p className="text-[12px] text-[#94a3b8] mt-1">The AI voice needs the online explanation; your device's voice will read this one.</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-6">
        <section aria-labelledby="wi-cost-h" className="rounded-xl border border-white/10 p-4">
          <h3 id="wi-cost-h" className="font-bold text-white">Illustrative cost ({r.currency} a month)</h3>
          <table className="w-full text-[13.5px] mt-2"><tbody>
            {r.config.lines.map((l) => <tr key={l.label}><td className="py-1 text-[#cbd5e1]">{l.label}</td><td className="py-1 text-right text-white">{m(l.amount)}</td></tr>)}
            <tr className="border-t border-white/10"><th scope="row" className="py-1.5 text-left" style={{ color: GOLD }}>Inaya total</th><td className="py-1.5 text-right font-bold" style={{ color: GOLD }}>{m(r.config.monthlyTotal)}</td></tr>
            {r.consolidation && <><tr><td className="py-1 text-[#cbd5e1]">Your tools today (your figures)</td><td className="py-1 text-right text-white">{m(r.consolidation.currentMonthly)}</td></tr><tr><th scope="row" className="py-1 text-left text-white">Illustrative monthly difference</th><td className={`py-1 text-right font-bold ${r.consolidation.difference >= 0 ? "text-emerald-300" : "text-amber-200"}`}>{m(r.consolidation.difference)}</td></tr></>}
            {r.time && <tr><td className="py-1 text-[#cbd5e1]">Your manual-work time cost{r.time.hypotheticalMonthlyValue !== null ? `; your ${r.time.reductionPct}% hypothetical` : ""}</td><td className="py-1 text-right text-white">{m(r.time.currentMonthlyCost)}{r.time.hypotheticalMonthlyValue !== null ? ` · ${m(r.time.hypotheticalMonthlyValue)}` : ""}</td></tr>}
          </tbody></table>
          <p className="text-[11.5px] text-[#94a3b8] mt-2">Formula: your entered software spend − Inaya subscription − known extra recurring costs. Payment-processing fees, tax and implementation are not included. Estimates are illustrative and depend on the costs and assumptions entered. This is not a quote or a guarantee of savings.</p>
          <a href="/business/pricing" onClick={() => track?.("pricing_link_click")} className="inline-block mt-2 text-[13px] font-bold hover:underline" style={{ color: GOLD }}>See full pricing →</a>
        </section>
        <section aria-labelledby="wi-flow-h" className="rounded-xl border border-white/10 p-4">
          <h3 id="wi-flow-h" className="font-bold text-white">Your workflows, step by step</h3>
          {out.script.scenes.filter((s) => s.kind === "workflow").map((s) => <div key={s.id} className="mt-2"><p className="text-[13px] font-semibold" style={{ color: GOLD }}>{s.title}</p><ol className="list-decimal pl-5 text-[13px] text-[#cbd5e1] space-y-0.5 mt-1">{s.data.steps.map((x) => <li key={x}>{x}</li>)}</ol></div>)}
        </section>
      </div>
      <section aria-labelledby="wi-tr-h" className="mt-5 rounded-xl border border-white/10 p-4">
        <h3 id="wi-tr-h" className="font-bold text-white">Transcript</h3>
        <div className="mt-2 space-y-3 text-[13.5px] text-[#cbd5e1] leading-relaxed">{out.script.scenes.map((s) => <p key={s.id}><b className="text-white">{s.title}.</b> {s.text}</p>)}</div>
      </section>
      <div className="flex flex-wrap gap-3 mt-5">
        <a href="/business#workspace-signin" onClick={() => track?.("signup_link_click")} className="px-5 py-3 rounded-xl text-sm font-bold text-[#0a0e14]" style={{ background: GOLD }}>Create a company</a>
        <a href="mailto:contact@inayanetwork.com?subject=Inaya%20Business%20OS%20demo" onClick={() => track?.("demo_link_click")} className="px-5 py-3 rounded-xl text-sm font-bold border border-white/20 text-white">Ask for a live demo</a>
        <button type="button" onClick={() => { setOut(null); setStep("form"); }} className="px-5 py-3 rounded-xl text-sm font-bold border border-white/20 text-white">Change my answers</button>
      </div>
    </Dialog>
  );
}
