"use client";
// app/business/why-inaya/WhyInayaClient.js -- the Why Inaya Business OS page (SOW sections 4 and 6).
// Every claim comes from src/lib/whyInaya/content.js (capabilities with availability states) and competitors.js (official
// sources + date checked). The AI explainer is loaded only when the visitor asks for it (consent first, no autoplay).
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { track } from "@vercel/analytics";
import { CAPABILITIES, STATE_LABEL, DIFFERENTIATORS, PLATFORM, TEAM, DEMOS, GUIDE_URL } from "../../../lib/whyInaya/content.js";
import { COMPETITORS, DIMENSIONS, STATUS, INAYA_COLUMN, CHECKED, PRICE_SCENARIO } from "../../../lib/whyInaya/competitors.js";
import { formatMoney } from "../../../lib/whyInaya/savings.js";

const Explainer = dynamic(() => import("../../../components/whyInaya/Explainer.js"), { ssr: false, loading: () => <p role="status" className="text-sm text-[#cbd5e1]">Loading the explainer…</p> });

// Privacy-safe analytics: event names only, never the visitor's answers (SOW 9.2).
export const ev = (name) => { try { track(name); } catch { /* analytics must never break the page */ } };

const GOLD = "#d4a24c"; // gold tuned for AA contrast on the navy background
const badgeTone = { LIVE: "bg-emerald-400/15 text-emerald-300 border-emerald-400/30", CONDITIONS: "bg-sky-400/15 text-sky-200 border-sky-400/30", BETA: "bg-amber-400/15 text-amber-200 border-amber-400/40" };
const statusTone = { INCLUDED: "text-emerald-300", CONDITIONS: "text-sky-200", ADDON: "text-amber-200", SEPARATE: "text-amber-200", THIRD_PARTY: "text-violet-200", NOT_ESTABLISHED: "text-[#94a3b8]" };

function StateBadge({ state }) {
  return <span className={`inline-block text-[10.5px] font-bold uppercase tracking-wide border rounded-full px-2 py-0.5 ${badgeTone[state] || "border-white/20 text-[#cbd5e1]"}`}>{STATE_LABEL[state]}</span>;
}
function Section({ id, eyebrow, title, intro, children, onSeen }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!onSeen || !ref.current || typeof IntersectionObserver === "undefined") return undefined;
    let done = false; const io = new IntersectionObserver((es) => { if (!done && es.some((e) => e.isIntersecting)) { done = true; onSeen(); io.disconnect(); } }, { threshold: 0.25 });
    io.observe(ref.current); return () => io.disconnect();
  }, [onSeen]);
  return (
    <section id={id} ref={ref} aria-labelledby={`${id}-h`} className="scroll-mt-20 py-12 md:py-16 border-t border-white/[0.06]">
      <p className="text-[11px] font-bold tracking-[0.18em] uppercase" style={{ color: GOLD }}>{eyebrow}</p>
      <h2 id={`${id}-h`} className="text-2xl md:text-3xl font-extrabold text-white mt-2 tracking-tight">{title}</h2>
      {intro && <p className="text-[#cbd5e1] text-[15px] leading-relaxed mt-3 max-w-3xl">{intro}</p>}
      <div className="mt-8">{children}</div>
    </section>
  );
}

export default function WhyInayaClient({ prices }) {
  const [explainerOpen, setExplainerOpen] = useState(false);
  const [cat, setCat] = useState("all");
  const [openSources, setOpenSources] = useState(null);
  const usd = prices.usd; const inayaShop = usd.professional + usd.commerceStarter;
  useEffect(() => { ev("why_inaya_page_view"); }, []);
  const cats = [["all", "All"], ["ERP / business suite", "Business suite"], ["Retail POS", "Retail POS"], ["E-commerce platform with POS", "E-commerce"], ["Inventory and order management", "Inventory"], ["POS and inventory apps", "POS + inventory apps"]];
  const shown = cat === "all" ? COMPETITORS : COMPETITORS.filter((c) => c.category === cat);

  return (
    <div className="min-h-screen bg-[#0a0e14] text-[#e2e8f0] font-sans">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 bg-white text-black px-3 py-2 rounded">Skip to content</a>
      <header className="sticky top-0 z-30 bg-[#0a0e14]/90 backdrop-blur border-b border-white/[0.06]">
        <nav aria-label="Why Inaya" className="max-w-6xl mx-auto px-4 md:px-8 h-14 flex items-center gap-4 overflow-x-auto text-[13px] whitespace-nowrap">
          <a href="/business" className="font-bold text-white hover:underline focus-visible:outline focus-visible:outline-2 rounded">← Inaya Business OS</a>
          <span aria-hidden="true" className="text-white/20">|</span>
          {[["#differentiators", "What's different"], ["#platform", "How it connects"], ["#compare", "Compare"], ["#value", "Value"], ["#team", "Team"]].map(([h, l]) => <a key={h} href={h} className="text-[#cbd5e1] hover:text-white focus-visible:outline focus-visible:outline-2 rounded">{l}</a>)}
          <a href="/business/pricing" onClick={() => ev("pricing_link_click")} className="ml-auto font-bold hover:underline" style={{ color: GOLD }}>Pricing</a>
        </nav>
      </header>

      <main id="main" className="max-w-6xl mx-auto px-4 md:px-8">
        {/* A. Introduction (a supporting page, not a second hero) */}
        <div className="pt-12 pb-10 md:pt-16">
          <p className="text-[11px] font-bold tracking-[0.18em] uppercase" style={{ color: GOLD }}>Inaya Business OS · Business Operations Platform</p>
          <h1 className="text-3xl md:text-[2.6rem] font-black text-white tracking-tight leading-[1.1] mt-3 max-w-3xl">Why Inaya Business OS?</h1>
          <p className="text-lg text-[#e2e8f0] font-semibold mt-3 max-w-3xl">One connected platform for the systems that run your business.</p>
          <p className="text-[15px] text-[#cbd5e1] leading-relaxed mt-3 max-w-3xl">Inaya brings the back office, the shop counter and online selling into one system with shared records, AI assistants that respect your staff roles, and data protection built in. This page explains what is different, how it compares with alternatives (with sources), who builds it, and, if you like, an AI walkthrough for your own business.</p>
          <div className="flex flex-wrap gap-3 mt-6">
            <button type="button" onClick={() => { ev("ai_explainer_open"); setExplainerOpen(true); }} className="px-5 py-3 rounded-xl text-sm font-bold text-[#0a0e14] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" style={{ background: GOLD }}>▶ See how Inaya could work for your business</button>
            <a href={DEMOS.commerce.url} target="_blank" rel="noopener noreferrer" onClick={() => ev("demo_link_click")} className="px-5 py-3 rounded-xl text-sm font-bold border border-white/15 text-white hover:border-white/40">Watch the 8-minute demo</a>
          </div>
        </div>

        {/* B. Differentiators */}
        <Section id="differentiators" eyebrow="What's different" title="Six things that set Inaya apart" intro="Ranked by how much they change day-to-day work. Each card shows whether it is live, live with conditions, or in Beta." onSeen={() => ev("differentiator_section_view")}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {DIFFERENTIATORS.map((d) => (
              <article key={d.id} className="bg-white/[0.03] border border-white/[0.08] rounded-2xl p-5 flex flex-col">
                <div className="flex items-start justify-between gap-2"><span aria-hidden="true" className="text-2xl">{d.icon}</span>{d.beta && <StateBadge state="BETA" />}</div>
                <h3 className="text-white font-bold text-[17px] mt-3">{d.title}</h3>
                <p className="text-[#cbd5e1] text-[14px] leading-relaxed mt-2 flex-1">{d.text}</p>
                <ul className="mt-3 space-y-1.5">
                  {d.caps.map((c) => <li key={c} className="text-[12px] text-[#cbd5e1] flex flex-wrap items-center gap-2"><span>{CAPABILITIES[c].name}</span><StateBadge state={CAPABILITIES[c].state} /></li>)}
                </ul>
                {d.caps.some((c) => CAPABILITIES[c].condition) && <p className="text-[11.5px] text-[#94a3b8] mt-2">{d.caps.map((c) => CAPABILITIES[c].condition).filter(Boolean)[0]}.</p>}
                {d.link && <a href={d.link.href} target={d.link.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" onClick={() => ev(d.link.href.includes("youtu") ? "demo_link_click" : "guide_link_click")} className="text-[13px] font-bold mt-3 hover:underline" style={{ color: GOLD }}>{d.link.label} →</a>}
              </article>
            ))}
          </div>
        </Section>

        {/* C. How the connected platform works */}
        <Section id="platform" eyebrow="How it connects" title="Four areas, one set of records" intro="The till, the web store and the back office share one stock count, one customer list and one set of books. Arrows show how information actually moves; Shopify and WooCommerce sync runs in the background rather than instantly.">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
            {PLATFORM.areas.filter((a) => a.id !== "core").map((a) => (
              <div key={a.id} className="bg-white/[0.03] border border-white/[0.08] rounded-2xl p-5">
                <h3 className="font-bold text-white">{a.title}</h3>
                <ul className="mt-3 space-y-1.5">{a.items.map((i) => <li key={i} className="text-[13.5px] text-[#cbd5e1] flex gap-2"><span aria-hidden="true" style={{ color: GOLD }}>•</span>{i}</li>)}</ul>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-2xl p-5 border" style={{ borderColor: `${GOLD}55`, background: `${GOLD}10` }}>
            <h3 className="font-bold text-white">{PLATFORM.areas.find((a) => a.id === "core").title} <span className="text-[#94a3b8] font-normal text-sm">(under all three)</span></h3>
            <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">{PLATFORM.areas.find((a) => a.id === "core").items.map((i) => <li key={i} className="text-[13.5px] text-[#e2e8f0]">{i}</li>)}</ul>
          </div>
          <h3 className="sr-only">How information moves</h3>
          <ul className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-2">
            {PLATFORM.flows.map((f) => <li key={f.label} className="text-[13px] text-[#cbd5e1] bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2"><b className="text-white">{PLATFORM.areas.find((a) => a.id === f.from).title} → {PLATFORM.areas.find((a) => a.id === f.to).title}:</b> {f.label}</li>)}
          </ul>
        </Section>

        {/* E. Comparison */}
        <Section id="compare" eyebrow="How it compares" title="Inaya next to the tools businesses use today" intro="These products are good at different things. We compared what each one's official pricing and product pages say, on the date shown, and marked anything those pages don't state as not established, rather than missing." onSeen={() => ev("competitor_comparison_view")}>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 mb-6">
            <h3 className="text-white font-bold">In short</h3>
            <ul className="mt-2 space-y-1.5 text-[14px] text-[#cbd5e1] list-disc pl-5">
              <li>Inaya's case is one flat company price covering the back office, the till and online selling, with ransomware recovery built in and Shopify or WooCommerce sync rather than replacement.</li>
              <li>Odoo covers a very broad range of apps and can cost less for small teams; it prices per user and implementation is separate.</li>
              <li>Specialists (Shopify for online stores, Lightspeed for retail and restaurant POS, Cin7 for inventory) go deeper in their own area, and you add the other systems yourself.</li>
            </ul>
          </div>
          <div role="tablist" aria-label="Filter by category" className="flex flex-wrap gap-2 mb-4">
            {cats.map(([v, l]) => <button key={v} role="tab" aria-selected={cat === v} onClick={() => setCat(v)} className={`text-[12.5px] font-semibold rounded-full px-3 py-1.5 border ${cat === v ? "text-[#0a0e14] border-transparent" : "text-[#cbd5e1] border-white/15 hover:border-white/40"}`} style={cat === v ? { background: GOLD } : undefined}>{l}</button>)}
          </div>
          {/* Desktop table */}
          <div className="hidden lg:block overflow-x-auto rounded-2xl border border-white/[0.08]">
            <table className="w-full text-[13px]">
              <caption className="sr-only">Feature comparison, checked {CHECKED}</caption>
              <thead className="bg-white/[0.04]"><tr><th scope="col" className="text-left p-3 text-[#cbd5e1] font-semibold w-[19%]">Area</th><th scope="col" className="text-left p-3 font-bold" style={{ color: GOLD }}>Inaya Business OS</th>{shown.map((c) => <th key={c.id} scope="col" className="text-left p-3 text-white font-bold">{c.name}<div className="text-[11px] text-[#94a3b8] font-normal">{c.product}</div></th>)}</tr></thead>
              <tbody>
                {DIMENSIONS.map((d) => (
                  <tr key={d.id} className="border-t border-white/[0.06] align-top">
                    <th scope="row" className="text-left p-3 text-[#cbd5e1] font-semibold">{d.label}</th>
                    <td className="p-3"><span className={`font-bold ${statusTone[INAYA_COLUMN[d.id][0]]}`}>{STATUS[INAYA_COLUMN[d.id][0]]}</span><div className="text-[11.5px] text-[#94a3b8] mt-0.5">{INAYA_COLUMN[d.id][1]}</div></td>
                    {shown.map((c) => <td key={c.id} className="p-3"><span className={`font-semibold ${statusTone[c.dims[d.id][0]]}`}>{STATUS[c.dims[d.id][0]]}</span>{c.dims[d.id][1] && <div className="text-[11.5px] text-[#94a3b8] mt-0.5">{c.dims[d.id][1]}</div>}</td>)}
                  </tr>
                ))}
                <tr className="border-t border-white/[0.06] align-top"><th scope="row" className="text-left p-3 text-[#cbd5e1] font-semibold">Published price</th><td className="p-3 text-[#e2e8f0]">Professional ${usd.professional} + Commerce Starter ${usd.commerceStarter} = <b>${inayaShop}</b> a month; Business + Commerce ${usd.bundle}; Enterprise ${usd.enterprise} (Commerce included)</td>{shown.map((c) => <td key={c.id} className="p-3 text-[#e2e8f0]">{c.price}<div className="text-[11.5px] text-[#94a3b8] mt-1">{c.limits}</div></td>)}</tr>
                <tr className="border-t border-white/[0.06] align-top"><th scope="row" className="text-left p-3 text-[#cbd5e1] font-semibold">Strong at</th><td className="p-3 text-[#cbd5e1]">One system across back office, till and online, with recovery built in.</td>{shown.map((c) => <td key={c.id} className="p-3 text-[#cbd5e1]">{c.strongAt}</td>)}</tr>
              </tbody>
            </table>
          </div>
          {/* Mobile and tablet: stacked cards */}
          <div className="lg:hidden space-y-4">
            {shown.map((c) => (
              <article key={c.id} className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
                <h3 className="text-white font-bold">{c.name} <span className="text-[#94a3b8] font-normal text-[12px]">· {c.product} · {c.category}</span></h3>
                <p className="text-[13px] text-[#cbd5e1] mt-1">{c.strongAt}</p>
                <dl className="mt-3 divide-y divide-white/[0.06]">
                  {DIMENSIONS.map((d) => <div key={d.id} className="py-2 grid grid-cols-[1fr_1fr] gap-3 text-[12.5px]"><dt className="text-[#94a3b8]">{d.label}</dt><dd><span className={`font-semibold ${statusTone[c.dims[d.id][0]]}`}>{STATUS[c.dims[d.id][0]]}</span>{c.dims[d.id][1] && <span className="block text-[#94a3b8] text-[11.5px]">{c.dims[d.id][1]}</span>}<span className="block text-[11px] mt-0.5" style={{ color: GOLD }}>Inaya: {STATUS[INAYA_COLUMN[d.id][0]]}</span></dd></div>)}
                </dl>
                <p className="text-[12.5px] text-[#e2e8f0] mt-2"><b>Price:</b> {c.price}</p>
                <p className="text-[11.5px] text-[#94a3b8]">{c.limits}</p>
              </article>
            ))}
          </div>
          {COMPETITORS.filter((c) => c.note).map((c) => <p key={c.id} className="text-[13px] text-[#cbd5e1] mt-4"><b className="text-white">{c.name}:</b> {c.note}</p>)}

          <div className="mt-8 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
            <h3 className="text-white font-bold">One example configuration</h3>
            <p className="text-[13px] text-[#94a3b8] mt-1">{PRICE_SCENARIO.title}</p>
            <div className="overflow-x-auto mt-3"><table className="w-full text-[13px] min-w-[520px]"><caption className="sr-only">Example monthly cost for one shop</caption><thead><tr className="text-left text-[#94a3b8]"><th scope="col" className="py-2 pr-3">Product</th><th scope="col" className="py-2 pr-3">What this configuration is</th><th scope="col" className="py-2 text-right">List price / month</th></tr></thead>
              <tbody>{PRICE_SCENARIO.rows.map((r) => <tr key={r.who} className="border-t border-white/[0.06] align-top"><th scope="row" className="py-2 pr-3 text-left text-white font-semibold">{r.who}</th><td className="py-2 pr-3 text-[#cbd5e1]">{r.config}</td><td className="py-2 text-right font-bold text-white">{formatMoney(r.priceKey === "inaya" ? inayaShop : r.monthly, "USD")}</td></tr>)}</tbody></table></div>
            <p className="text-[12px] text-[#94a3b8] mt-3">{PRICE_SCENARIO.caveat}</p>
          </div>

          <div className="mt-4">
            <button type="button" aria-expanded={openSources === "all"} aria-controls="sources" onClick={() => setOpenSources(openSources === "all" ? null : "all")} className="text-[13px] font-bold hover:underline" style={{ color: GOLD }}>{openSources === "all" ? "Hide" : "View"} sources and how we compared</button>
            {openSources === "all" && <div id="sources" className="mt-3 text-[12.5px] text-[#cbd5e1] space-y-2">
              <p>Checked on {CHECKED} from each company's official pricing pages (US pages, USD, before tax). We compared list prices for an equivalent small setup and stated the billing basis for each. A feature marked "not established" means the reviewed official pages did not state it, not that the product lacks it. Prices change; check the source before deciding.</p>
              <ul className="list-disc pl-5 space-y-1">{COMPETITORS.flatMap((c) => c.sources.map((s) => <li key={s.url}><a className="underline" href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.label}</a> ({c.name})</li>))}</ul>
              <p>Inaya prices are read from the same code that runs the <a className="underline" href="/business/pricing">pricing page</a>.</p>
            </div>}
          </div>
        </Section>

        {/* F. Business value */}
        <Section id="value" eyebrow="Business value" title="Where the value can come from" intro="Most of the value comes from doing things once: fewer separate subscriptions, less typing the same sale into two systems, and less reconciling between them. How much that is worth depends entirely on your business, so we don't promise a number.">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[["Fewer subscriptions", "Accounting, POS, inventory, CRM, HR and document tools could consolidate into parts of one system."], ["Enter it once", "A sale updates stock, the customer and the books together, so there is less double entry and reconciling."], ["See every branch", "Reports per branch and for the whole company, from the same records."], ["Recover, don't pay", "Tested rollback can cut the disruption from ransomware; it cannot promise an attack causes none."]].map(([t, d]) => <div key={t} className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4"><h3 className="text-white font-bold text-[15px]">{t}</h3><p className="text-[13px] text-[#cbd5e1] mt-1.5">{d}</p></div>)}
          </div>
          <div className="mt-6 rounded-2xl p-5 border flex flex-col md:flex-row md:items-center gap-4" style={{ borderColor: `${GOLD}55`, background: `${GOLD}10` }}>
            <div className="flex-1"><h3 className="text-white font-bold text-lg">Get a walkthrough for your business</h3><p className="text-[13.5px] text-[#e2e8f0] mt-1">An AI guide presents the workflows that match your answers, with an illustrative cost based only on the figures you choose to enter. Narrated, with a full transcript; nothing plays until you press play.</p></div>
            <button type="button" onClick={() => { ev("ai_explainer_open"); setExplainerOpen(true); }} className="px-5 py-3 rounded-xl text-sm font-bold text-[#0a0e14] shrink-0" style={{ background: GOLD }}>See how Inaya could work for you</button>
          </div>
          <p className="text-[12px] text-[#94a3b8] mt-3">Estimates are illustrative and depend on the costs and assumptions entered. Actual savings vary by business, configuration, usage, implementation and third-party services. This is not a quote or a guarantee of savings.</p>
        </Section>

        {/* D. Team */}
        <Section id="team" eyebrow="The team behind Inaya" title="Who builds and runs it" onSeen={() => ev("team_section_view")}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {TEAM.map((p) => (
              <article key={p.name} className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
                <div aria-hidden="true" className="w-12 h-12 rounded-full flex items-center justify-center font-black text-[#0a0e14]" style={{ background: GOLD }}>{p.name.split(" ").map((w) => w[0]).join("")}</div>
                <h3 className="text-white font-bold text-lg mt-3">{p.name}</h3>
                <p className="text-[12px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>{p.title}</p>
                <p className="text-[13.5px] text-[#cbd5e1] mt-2 leading-relaxed">{p.bio}</p>
              </article>
            ))}
          </div>
        </Section>

        <section aria-label="Next steps" className="py-12 border-t border-white/[0.06] flex flex-wrap gap-3">
          <a href="/business#workspace-signin" onClick={() => ev("signup_link_click")} className="px-5 py-3 rounded-xl text-sm font-bold text-[#0a0e14]" style={{ background: GOLD }}>Create a company</a>
          <a href="/business/pricing" onClick={() => ev("pricing_link_click")} className="px-5 py-3 rounded-xl text-sm font-bold border border-white/15 text-white hover:border-white/40">See pricing</a>
          <a href={DEMOS.ransomware.url} target="_blank" rel="noopener noreferrer" onClick={() => ev("demo_link_click")} className="px-5 py-3 rounded-xl text-sm font-bold border border-white/15 text-white hover:border-white/40">Ransomware recovery demo</a>
          <a href={GUIDE_URL} target="_blank" rel="noopener noreferrer" className="px-5 py-3 rounded-xl text-sm font-bold border border-white/15 text-white hover:border-white/40">User guide (PDF)</a>
          <a href="mailto:contact@inayanetwork.com?subject=Inaya%20Business%20OS%20question" className="px-5 py-3 rounded-xl text-sm font-bold border border-white/15 text-white hover:border-white/40">Contact sales</a>
        </section>
      </main>

      {explainerOpen && <Explainer prices={prices} onClose={() => setExplainerOpen(false)} track={ev} />}
    </div>
  );
}
