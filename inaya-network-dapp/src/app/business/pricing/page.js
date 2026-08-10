"use client";

// app/business/pricing/page.js
//
// Public marketing page for the Business Workspace's 4 pricing tiers —
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

export default function PricingPage() {
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/orgs/billing/plans")
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setPlans(data.plans);
      })
      .catch((err) => setError(err.message));
  }, []);

  function handleSelect(plan) {
    if (plan.contactSalesOnly) {
      window.location.href = "mailto:sales@inaya.ai?subject=Inaya%20Business%20Workspace%20—%20Enterprise";
      return;
    }
    localStorage.setItem(PENDING_PLAN_KEY, JSON.stringify({ planId: plan.id, interval: "month" }));
    window.location.href = "/business";
  }

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-10">
          <div>
            <a href="/business" className="inline-block text-[#94a3b8] hover:text-slate-300 text-xs font-mono mb-4">← Business Workspace</a>
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
            <p className="text-[#94a3b8] text-[10px] font-mono">Zero-Knowledge. Always.</p>
          </div>
        </div>

        {error && <p className="text-red-400 text-sm text-center mb-6">{error}</p>}
        {!plans && !error && <p className="text-[#94a3b8] text-sm text-center">Loading plans…</p>}

        {plans && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {plans.map((plan) => (
              <PricingCard key={plan.id} plan={plan} onSelect={() => handleSelect(plan)} />
            ))}
          </div>
        )}

        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 bg-[#090d16]/60 border border-white/5 rounded-2xl p-5 text-xs text-[#94a3b8]">
          <div>
            <p className="text-white font-bold mb-1">Additional Users</p>
            <p>Starting at $2.49 / user / month</p>
          </div>
          <div>
            <p className="text-white font-bold mb-1">Additional Storage</p>
            <p>$3.99 / TB / month</p>
          </div>
          <div>
            <p className="text-white font-bold mb-1">Extra Features</p>
            <p>API, integrations &amp; more</p>
          </div>
          <div>
            <p className="text-white font-bold mb-1">All Plans Include</p>
            <p>End-to-end encryption, decentralized infrastructure, 99.9% uptime.</p>
          </div>
        </div>

        <p className="text-center text-[#64748b] text-[10px] font-mono mt-8">
          Decentralized. Private. Secure. Scalable. — Inaya puts you in control of your data, always.
        </p>
      </div>
    </div>
  );
}
