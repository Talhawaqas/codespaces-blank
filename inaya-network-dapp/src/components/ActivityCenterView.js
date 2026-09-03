"use client";

// src/components/ActivityCenterView.js
//
// Enterprise OS SOW, Phase 5 — surface-agnostic "What Changed?" view,
// same "period selector + real fetched data" shape as BriefView.js
// (business-brief.js's existing view), generalized to any fetchUrl so
// both surfaces render it: Business Workspace passes
// /api/orgs/activity-center?orgId=..., the dApp passes
// /api/wallet/activity-center?address=....

import { useState, useEffect, useCallback } from "react";

const PERIOD_OPTIONS = [
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["yearly", "Yearly"],
];

const MODULE_LABELS = {
  business: "Business",
  ai: "AI Actions",
  notifications: "Notifications",
  trust: "Trust & Health",
  data: "Sovereign Vault",
};

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function ActivityCenterView({ baseUrl }) {
  const [period, setPeriod] = useState("weekly");
  const [digest, setDigest] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setDigest(null);
    setError("");
    try {
      setDigest(await api(`${baseUrl}${baseUrl.includes("?") ? "&" : "?"}period=${period}`));
    } catch (err) {
      setError(err.message);
    }
  }, [baseUrl, period]);

  useEffect(() => {
    load();
  }, [load]);

  const sectionsWithContent = (digest?.sections || []).filter((s) => s.bullets?.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-lg font-extrabold text-[var(--inaya-text-primary)]">What Changed?</h2>
        <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1">
          {PERIOD_OPTIONS.map(([value, label]) => (
            <button
              key={value}
              onClick={() => setPeriod(value)}
              className={`px-3 py-1.5 text-[12px] font-bold rounded-lg transition-colors ${
                period === value ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)] hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-[12px] text-red-400">{error}</p>}

      {digest && sectionsWithContent.length === 0 && (
        <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-6 text-center">
          <p className="text-[12px] text-[var(--inaya-text-muted)]">Nothing to report for this period.</p>
        </div>
      )}

      {sectionsWithContent.map((section) => (
        <div key={section.module} className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-2">
            {MODULE_LABELS[section.module] || section.module}
          </p>
          <ul className="space-y-1.5">
            {section.bullets.map((bullet, i) => (
              <li key={i} className="text-[13px] text-[var(--inaya-text-primary)] flex items-start gap-2">
                <span className="text-[#00f2fe] mt-0.5">•</span>
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
