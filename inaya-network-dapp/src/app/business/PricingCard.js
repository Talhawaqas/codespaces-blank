"use client";

// src/app/business/PricingCard.js
//
// Shared between the public marketing page (business/pricing/page.js) and
// the in-app "Change plan" switcher inside the authenticated Workspace
// (business/page.js's BillingView) — one card component, one place to keep
// the 4-tier visual design consistent, rather than two divergent copies.
// Content itself (price/limits/features) comes from src/lib/orgPlans.js
// via each caller's API response — this file only knows how to render it.

const COLOR_STYLES = {
  green: {
    ring: "border-emerald-400/30",
    ringPopular: "border-emerald-400/60",
    iconBg: "bg-emerald-400/15",
    iconText: "text-emerald-400",
    name: "text-emerald-400",
    check: "text-emerald-400",
    button: "bg-gradient-to-r from-emerald-500 to-emerald-400 text-black",
  },
  blue: {
    ring: "border-[#4facfe]/30",
    ringPopular: "border-[#4facfe]/70",
    iconBg: "bg-[#4facfe]/15",
    iconText: "text-[#4facfe]",
    name: "text-[#4facfe]",
    check: "text-[#4facfe]",
    button: "bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black",
  },
  purple: {
    ring: "border-violet-400/30",
    ringPopular: "border-violet-400/60",
    iconBg: "bg-violet-400/15",
    iconText: "text-violet-300",
    name: "text-violet-300",
    check: "text-violet-300",
    button: "bg-gradient-to-r from-violet-500 to-violet-400 text-white",
  },
  gold: {
    ring: "border-amber-400/30",
    ringPopular: "border-amber-400/60",
    iconBg: "bg-amber-400/15",
    iconText: "text-amber-400",
    name: "text-amber-400",
    check: "text-amber-400",
    button: "bg-gradient-to-r from-amber-500 to-amber-400 text-black",
  },
  cyan: {
    ring: "border-[#00f2fe]/30",
    ringPopular: "border-[#00f2fe]/60",
    iconBg: "bg-[#00f2fe]/15",
    iconText: "text-[#00f2fe]",
    name: "text-[#00f2fe]",
    check: "text-[#00f2fe]",
    button: "bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black",
  },
};

const PLAN_ICON_GLYPH = { starter: "🌱", professional: "💼", business: "🏢", enterprise: "🛡️" };

export function PricingCard({ plan, current = false, loading = false, onSelect, ctaLabelOverride, compact = false }) {
  const c = COLOR_STYLES[plan.color] || COLOR_STYLES.cyan;
  const ctaLabel =
    ctaLabelOverride ||
    (current
      ? "Current plan"
      : plan.contactSalesOnly
      ? "Contact Sales"
      : plan.id === "starter"
      ? "Get Started"
      : "Start Free Trial");

  return (
    <div
      className={`relative flex flex-col rounded-2xl border bg-[#090d16]/80 ${compact ? "p-4" : "p-6"} ${
        plan.popular ? c.ringPopular : c.ring
      } ${current ? "ring-2 ring-offset-0 ring-white/20" : ""}`}
    >
      {plan.popular && !compact && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#4facfe] text-black text-[12px] font-extrabold uppercase tracking-wide px-3 py-1 rounded-full">
          Most Popular
        </span>
      )}

      <div className={`flex flex-col items-center text-center ${compact ? "mb-3" : "mb-5"}`}>
        <div className={`${compact ? "w-9 h-9 text-base" : "w-14 h-14 text-2xl"} rounded-full ${c.iconBg} flex items-center justify-center mb-2`}>
          <span>{PLAN_ICON_GLYPH[plan.id] || "✦"}</span>
        </div>
        <h3 className={`${compact ? "text-sm" : "text-xl"} font-extrabold ${c.name}`}>{plan.name}</h3>
        {!compact && <p className="text-[#94a3b8] text-xs mt-1">{plan.tagline}</p>}
      </div>

      <div className={`text-center ${compact ? "mb-3" : "mb-5"}`}>
        <p className={`${compact ? "text-2xl" : "text-4xl"} font-extrabold text-white`}>
          ${plan.priceMonthly}
          <span className="text-[#94a3b8] text-xs font-medium">/month</span>
        </p>
        <p className="text-[#94a3b8] text-[12px] font-mono mt-1">
          ${plan.priceYearly}/year · save 17% with yearly billing
        </p>
      </div>

      {!compact && (
        <ul className="space-y-2 mb-6 flex-1">
          {plan.features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-xs text-slate-300">
              <span className={`${c.check} mt-0.5`}>✓</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
      )}

      <button
        onClick={onSelect}
        disabled={current || loading}
        className={`w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide disabled:opacity-50 ${
          current ? "bg-white/5 border border-white/10 text-slate-300" : c.button
        }`}
      >
        {loading ? "Working…" : ctaLabel}
      </button>
    </div>
  );
}
