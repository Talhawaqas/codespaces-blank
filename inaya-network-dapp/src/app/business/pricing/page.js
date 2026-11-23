"use client";

// app/business/pricing/page.js
//
// Public marketing page for Inaya Business OS's 4 pricing tiers —
// content comes from GET /api/orgs/billing's `availablePlans` shape
// (src/lib/orgPlans.js is the single source of truth both this page and
// the in-app Billing switcher render from). No auth required to view it.
//
// Self-serve CTAs (Starter/Professional/Business) stash the chosen plan in
// localStorage and send the visitor to /business — NOT a query param,
// because a not-yet-signed-in visitor goes through the magic-link email
// flow next, and that flow's server-side redirect
// (GET /api/orgs/login/consume -> /business?orgLoggedIn=1) has no way to
// carry a query param from the page the visitor started on. localStorage
// survives that whole round trip since it isn't tied to any one request.
// business/page.js checks for this flag once a session/org is available
// and fires checkout automatically. Enterprise has no self-serve flow —
// its button is a plain mailto: link.

import { useEffect, useState } from "react";
import { PricingCard } from "../PricingCard";

const PENDING_PLAN_KEY = "inaya_pending_plan";

import { COMMERCE_PRICING as CP } from "../../../lib/commercePricing";
// Inaya Commerce pricing (owner approved 23 Nov 2026): back office + front office + online selling.
function CommercePricing({ region, onPick }) {
  const pk = region === "PK"; const m = (x) => (pk ? `PKR ${x.pkr.toLocaleString("en-US")}` : `$${x.usd}`);
  const cards = [
    { id: "professional", name: "Commerce Starter", price: m(CP.starter), note: "add-on to Professional", points: ["1 branch and 1 till", "Your own web store", "1 connected store: Shopify or WooCommerce", "300 online orders a month"] },
    { id: "business", name: "Commerce add-on", price: m(CP.addon), note: "add-on to Business", points: ["2 branches and 3 tills", "Your own web store", "1 Shopify + 1 WooCommerce store", "1,000 online orders a month"] },
    { id: "business", name: "Business + Commerce", price: m(CP.bundle), note: pk ? `a month, saves PKR ${(30000 + CP.addon.pkr - CP.bundle.pkr).toLocaleString("en-US")}` : `a month, saves $${99 + CP.addon.usd - CP.bundle.usd}`, featured: true, points: ["Everything in Business, plus full Commerce", "2 branches and 3 tills", "Web store + Shopify + WooCommerce", "Point of sale, stock, orders, loyalty, staff rota"] },
    { id: "enterprise", name: "Enterprise", price: "Included", note: "in the Enterprise plan", points: ["Unlimited branches and tills", "3 connected stores", "Unlimited online orders", "Priority onboarding"] },
  ];
  return (
    <section className="mt-12 scroll-mt-6" id="commerce" aria-label="Inaya Commerce pricing">
      <h2 className="text-2xl font-extrabold text-white">Inaya Commerce</h2>
      <p className="text-[#94a3b8] text-sm mt-1 mb-5">Back office, front office and online selling on the same products, stock, customers and books: point of sale, inventory across branches, your own web store, Shopify and WooCommerce sync, loyalty and gift cards, and staff time and commissions.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => (
          <div key={c.name} className={`rounded-2xl p-5 flex flex-col border ${c.featured ? "border-[#00f2fe]/50 bg-[#00f2fe]/5" : "border-white/10 bg-[#090d16]/80"}`}>
            {c.featured && <span className="self-start text-[11px] font-bold text-black bg-[#00f2fe] rounded-full px-2.5 py-0.5 mb-2">Best value</span>}
            <p className="text-white font-bold">{c.name}</p>
            <p className="mt-2"><span className="text-3xl font-extrabold text-white">{c.price}</span></p>
            <p className="text-[#94a3b8] text-xs">{c.note}{c.price !== "Included" && !c.featured ? (pk ? " · a month" : " · a month") : ""}</p>
            <ul className="mt-4 space-y-1.5 text-[13px] text-slate-300 flex-1">{c.points.map((x) => <li key={x} className="flex gap-2"><span className="text-[#00f2fe]">✓</span>{x}</li>)}</ul>
            <button onClick={() => onPick(c.id, c.name)} className={`mt-5 w-full py-2.5 rounded-xl text-sm font-bold ${c.featured ? "bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black" : "border border-white/15 text-white hover:border-[#00f2fe]/40"}`}>Choose {c.id === "professional" ? "Professional" : c.id === "business" ? "Business" : "Enterprise"}</button>
          </div>
        ))}
      </div>
      <p className="text-[#94a3b8] text-xs mt-4">Extra branch {m(CP.extraBranch)} a month · extra till {m(CP.extraTill)} a month. Commerce is switched on with your activation; tell us which option you want in the request. Card payments use your own Stripe or Safepay account: Inaya never holds your customers' money.</p>
    </section>
  );
}

export default function PricingPage() {
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState("");
  // "PK" for visitors in Pakistan (PKR packages, bank transfer), otherwise "INTL" (USD).
  const [region, setRegion] = useState(null);

  useEffect(() => {
    fetch("/api/orgs/billing/plans")
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setPlans(data.plans);
        setRegion(data.region || "INTL");
      })
      .catch((err) => setError(err.message));
  }, []);

  // Every package (Enterprise included) goes through the activation request form, which opens in the
  // workspace once the visitor has signed in / created their company (15 Nov 2026: no card checkout).
  function handleSelect(plan, commerce = null) {
    try { localStorage.setItem(PENDING_PLAN_KEY, JSON.stringify({ planId: plan.id, planName: plan.name, commerce, interval: "month" })); } catch { /* storage blocked */ }
    window.location.href = "/business#workspace-signin";
  }

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-10">
          <div>
            <a href="/business" className="inline-block text-[#94a3b8] hover:text-slate-300 text-xs font-mono mb-4">← Business OS</a>
            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00f2fe] to-[#4facfe] flex items-center justify-center shrink-0">
                <span className="text-black font-extrabold text-sm">I</span>
              </div>
              <span className="text-white font-extrabold tracking-wide">INAYA</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-extrabold text-white">
              Inaya <span className="bg-gradient-to-r from-[#00f2fe] to-violet-400 bg-clip-text text-transparent">SaaS</span> Pricing
            </h1>
            <p className="text-[#94a3b8] text-sm mt-2">Simple plans. Enterprise-grade privacy. Unmatched value.</p>
          </div>
          <div className="bg-[#090d16]/80 border border-white/5 rounded-xl px-4 py-3 text-right shrink-0">
            <p className="text-white text-xs font-bold">Your data. Your control.</p>
            <p className="text-[#94a3b8] text-[12px] font-mono">Zero-Knowledge. Always.</p>
          </div>
        </div>

        <a href="/business/demo" className="mb-8 flex items-center gap-4 bg-[#090d16]/80 border border-white/5 hover:border-[#00f2fe]/30 rounded-2xl p-3 pr-5 group">
          <img src="/videos/inaya-business-workspace-erp-demo-poster.jpg" alt="" className="w-32 sm:w-40 rounded-lg border border-white/10 shrink-0" />
          <div className="min-w-0">
            <p className="text-white text-sm font-bold">Watch the 4-minute demo</p>
            <p className="text-[#94a3b8] text-xs mt-0.5">See HR, sales, invoicing, inventory, tasks and documents working together before you choose a plan.</p>
          </div>
          <span className="ml-auto text-[#00f2fe] text-xs font-bold uppercase shrink-0 group-hover:translate-x-0.5 transition-transform">Play →</span>
        </a>

        {error && <p className="text-red-400 text-sm text-center mb-6">{error}</p>}
        {!plans && !error && <p className="text-[#94a3b8] text-sm text-center">Loading plans…</p>}

        {plans && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {plans.map((plan) => (
              <PricingCard key={plan.id} plan={plan} onSelect={() => handleSelect(plan)} />
            ))}
          </div>
        )}

        {plans && <CommercePricing region={region} onPick={(id, commerce) => { const pl = plans.find((x) => x.id === id); if (pl) handleSelect(pl, commerce); }} />}

        {region === "PK" ? (
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 bg-[#090d16]/60 border border-white/5 rounded-2xl p-5 text-xs text-[#94a3b8]">
          <div>
            <p className="text-white font-bold mb-1">Additional Users</p>
            <p>PKR 2,500 / user / month, up to a limit per package</p>
          </div>
          <div>
            <p className="text-white font-bold mb-1">6-Month Pilot</p>
            <p>30% off for 10 pilot companies; setup free for the first 5</p>
          </div>
          <div>
            <p className="text-white font-bold mb-1">Payment</p>
            <p>Monthly by NayaPay or bank transfer, invoiced in PKR</p>
          </div>
          <div>
            <p className="text-white font-bold mb-1">Support</p>
            <p>WhatsApp and email, Mon to Sat, 10:00 to 19:00 PKT</p>
          </div>
        </div>
        ) : (
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 bg-[#090d16]/60 border border-white/5 rounded-2xl p-5 text-xs text-[#94a3b8]">
          <div>
            <p className="text-white font-bold mb-1">Additional Users</p>
            <p>$3 / user / month, up to a limit per plan</p>
          </div>
          <div>
            <p className="text-white font-bold mb-1">Additional Storage</p>
            <p>$19.99 / TB / month</p>
          </div>
          <div>
            <p className="text-white font-bold mb-1">Payment</p>
            <p>NayaPay or bank transfer, invoiced in USD. No card needed.</p>
          </div>
          <div>
            <p className="text-white font-bold mb-1">All Plans Include</p>
            <p>End-to-end encryption, decentralized infrastructure, 99.9% uptime.</p>
          </div>
        </div>
        )}

        <p className="text-center text-[#8a96ab] text-[12px] font-mono mt-8">
          Decentralized. Private. Secure. Scalable. — Inaya puts you in control of your data, always.
        </p>
      </div>
    </div>
  );
}
