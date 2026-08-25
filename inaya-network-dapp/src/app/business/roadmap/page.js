// app/business/roadmap/page.js
//
// Public Business SaaS Roadmap — presentation/documentation only. No auth,
// no database, no API calls; every word here comes from
// src/lib/saasRoadmap.js (the canonical content, mirrored in
// inaya-mobile/src/data/saasRoadmap.js for the mobile screen — see that
// file's header comment for why it's a mirror rather than a shared import).
//
// Deliberately a plain server component (no "use client", no hooks) —
// this page has nothing to fetch and nothing to react to, it's static copy.

import {
  STATUS_LABELS,
  STATUS_COLORS,
  ARCHITECTURE_LAYERS,
  POSITIONING_STATEMENT,
  POSITIONING_SUBTEXT,
  DOCUMENT_WORKFLOW_DIAGRAM,
  ROADMAP_STAGES,
  VISION,
} from "../../../lib/saasRoadmap.js";

export const metadata = {
  title: "Business SaaS Roadmap — Inaya Network",
  description: "How Inaya is evolving from decentralized storage infrastructure into a full business SaaS platform.",
};

function StatusBadge({ status }) {
  const color = STATUS_COLORS[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full border"
      style={{ color, borderColor: `${color}55`, backgroundColor: `${color}14` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      {STATUS_LABELS[status]}
    </span>
  );
}

function WorkflowDiagram() {
  const { linear, splits, loops } = DOCUMENT_WORKFLOW_DIAGRAM;
  return (
    <div className="mt-4 bg-black/20 border border-white/5 rounded-xl p-5 font-mono text-xs text-[#94a3b8] overflow-x-auto">
      <div className="flex items-center gap-2 flex-wrap">
        {linear.map((step, i) => (
          <span key={step.id} className="flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-slate-200">{step.label}</span>
            {i < linear.length - 1 && <span className="text-[#8a96ab]">→</span>}
          </span>
        ))}
      </div>
      <div className="mt-3 pl-4 border-l border-white/10 space-y-2">
        {splits.map((s) => (
          <div key={s.to} className="flex items-center gap-2">
            <span className="text-[#8a96ab]">↳ {s.label} →</span>
            <span className="px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-slate-200">
              {s.to.replace("_", " ")}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 pl-4 border-l border-white/10 space-y-2">
        {loops.map((l) => (
          <div key={`${l.from}-${l.to}`} className="flex items-center gap-2">
            <span className="text-[#8a96ab]">
              {l.from.replace("_", " ")} — {l.label} →
            </span>
            <span className="px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-slate-200">
              {l.to.replace("_", " ")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StageCard({ stage }) {
  return (
    <div
      className={`bg-[#090d16]/80 border rounded-2xl p-6 md:p-7 transition-colors ${
        stage.highlight ? "border-[#00f2fe]/30" : "border-white/5"
      }`}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[#8a96ab] text-sm">{String(stage.number).padStart(2, "0")}</span>
          <h3 className="text-lg md:text-xl font-extrabold text-white tracking-tight">{stage.title}</h3>
        </div>
        <StatusBadge status={stage.status} />
      </div>

      <p className="text-[#94a3b8] text-sm mt-3 leading-relaxed max-w-2xl">{stage.description}</p>

      {stage.securityStatement && (
        <div className="mt-4 bg-[#00f2fe]/5 border border-[#00f2fe]/20 rounded-xl px-4 py-3">
          <p className="text-[#00f2fe] text-xs font-mono">{stage.securityStatement}</p>
        </div>
      )}

      {stage.features && (
        <ul className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
          {stage.features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-sm text-slate-300">
              <span className="text-emerald-400 mt-0.5">✓</span>
              {f}
            </li>
          ))}
        </ul>
      )}

      {stage.groups && (
        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          {stage.groups.map((g) => (
            <div key={g.title} className="bg-black/20 border border-white/5 rounded-xl p-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#8a96ab] mb-2">{g.title}</p>
              <ul className="space-y-1.5">
                {g.items.map((item) => (
                  <li key={item} className="text-sm text-slate-300 flex items-start gap-2">
                    <span className="text-[#8a96ab] mt-0.5">•</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {stage.tools && (
        <div className="mt-5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#8a96ab] mb-2">Implemented AI tools</p>
          <div className="flex flex-wrap gap-2">
            {stage.tools.map((t) => (
              <code key={t} className="text-[11px] font-mono text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 rounded-md px-2 py-1">
                {t}
              </code>
            ))}
          </div>
        </div>
      )}

      {stage.diagram === "DOCUMENT_WORKFLOW_DIAGRAM" && <WorkflowDiagram />}

      {stage.examples && (
        <div className="mt-5 bg-black/20 border border-white/5 rounded-xl p-4">
          <ul className="space-y-1.5">
            {stage.examples.map((ex) => (
              <li key={ex} className="text-sm text-slate-400 italic">
                {ex}
              </li>
            ))}
          </ul>
          {stage.examplesNote && <p className="text-[10px] text-[#8a96ab] mt-3">{stage.examplesNote}</p>}
        </div>
      )}

      {stage.notes && <p className="text-xs text-[#8a96ab] italic mt-5 leading-relaxed">{stage.notes}</p>}
    </div>
  );
}

export default function RoadmapPage() {
  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-4xl mx-auto">
        {/* HEADER */}
        <div className="flex items-center justify-between mb-10 text-xs font-mono text-[#8a96ab]">
          <a href="/" className="hover:text-slate-300">← Inaya Network</a>
          <a href="/business" className="hover:text-slate-300">Business Workspace →</a>
        </div>

        <div className="text-center mb-14">
          <span className="inline-block text-[10px] font-bold uppercase tracking-[0.2em] text-[#00f2fe] mb-3">
            Product Roadmap
          </span>
          <h1 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight">Business SaaS Roadmap</h1>
          <p className="text-[#94a3b8] text-sm md:text-base mt-4 max-w-2xl mx-auto leading-relaxed">{POSITIONING_STATEMENT}</p>
          <p className="text-[#8a96ab] text-xs md:text-sm mt-2 max-w-xl mx-auto leading-relaxed">{POSITIONING_SUBTEXT}</p>
        </div>

        {/* ARCHITECTURE FLOW */}
        <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 md:p-8 mb-14">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#8a96ab] mb-5 text-center">Architecture</p>
          <div className="flex flex-col items-center gap-1.5">
            {ARCHITECTURE_LAYERS.map((layer, i) => (
              <div key={layer} className="flex flex-col items-center">
                <div
                  className={`px-5 py-2.5 rounded-lg border text-sm text-center ${
                    i === ARCHITECTURE_LAYERS.length - 1
                      ? "bg-[#00f2fe]/10 border-[#00f2fe]/30 text-[#00f2fe] font-bold"
                      : "bg-white/5 border-white/10 text-slate-300"
                  }`}
                >
                  {layer}
                </div>
                {i < ARCHITECTURE_LAYERS.length - 1 && <span className="text-[#8a96ab] text-lg leading-none my-1">↓</span>}
              </div>
            ))}
          </div>
        </div>

        {/* STAGES */}
        <div className="space-y-6">
          {ROADMAP_STAGES.map((stage) => (
            <StageCard key={stage.number} stage={stage} />
          ))}
        </div>

        {/* VISION */}
        <div className="mt-16 text-center border-t border-white/5 pt-14">
          <h2 className="text-2xl font-extrabold text-white tracking-tight">{VISION.title}</h2>
          <div className="mt-5 space-y-3 max-w-2xl mx-auto">
            {VISION.paragraphs.map((p) => (
              <p key={p} className="text-[#94a3b8] text-sm leading-relaxed">
                {p}
              </p>
            ))}
          </div>
          <p className="mt-6 text-[#00f2fe] font-semibold text-sm">{VISION.closingStatement}</p>
        </div>

        <div className="text-center mt-14">
          <a
            href="/business"
            className="inline-block px-6 py-3 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black"
          >
            Open the Business Workspace
          </a>
        </div>
      </div>
    </div>
  );
}
