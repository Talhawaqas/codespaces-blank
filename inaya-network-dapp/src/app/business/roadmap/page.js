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
  title: "Business Workspace Roadmap — Inaya Network",
  description: "How Inaya is evolving from decentralized storage infrastructure into a full business SaaS platform.",
};

function StatusBadge({ status }) {
  const color = STATUS_COLORS[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full border"
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

// ---------------------------------------------------------------- phase overview (presentation only)
// The roadmap design groups the stages into phases with a goal, a milestone line and an outcome. This grouping is
// presentation only: every word and every status below still comes from src/lib/saasRoadmap.js, and the outcome boxes
// are counted from the stages, so the overview can never claim more than the stages themselves.
const PHASES = [
  { id: "foundation", name: "Secure foundation", goal: "One secure place for the company: teams, documents, approvals and sharing", stages: [1, 2, 3, 4, 5] },
  { id: "operations", name: "Run the business", goal: "Daily operations, money and people in the same workspace", stages: [6, 7, 8, 9, 21, 22, 23, 25, 32] },
  { id: "industries", name: "Industries & enterprise", goal: "Ready-made workspaces for regulated and specialised sectors", stages: [10, 11, 12, 24, 31, 33] },
  { id: "infrastructure", name: "Infrastructure & trust", goal: "Storage, data access and verifiable records underneath it all", stages: [13, 14, 15, 16, 17, 18, 19, 20, 27, 30] },
  { id: "hardening", name: "Launch & hardening", goal: "Launch readiness, quality and the next generation of security", stages: [26, 28, 29, 34] },
];
const shortTitle = (t) => String(t).split(" — ")[0];
function phaseState(stages) {
  const live = stages.filter((x) => x.status === "LIVE").length;
  return { live, total: stages.length, label: live === stages.length ? "Live" : live === 0 ? "In progress" : live * 2 >= stages.length ? "Mostly live" : "Partly live", color: live === stages.length ? STATUS_COLORS.LIVE : STATUS_COLORS.IN_PROGRESS };
}
function PhaseOverview() {
  const byNumber = new Map(ROADMAP_STAGES.map((x) => [x.number, x]));
  const placed = new Set(PHASES.flatMap((p) => p.stages));
  const phases = PHASES.map((p) => ({ ...p, items: p.stages.map((n) => byNumber.get(n)).filter(Boolean) }));
  const rest = ROADMAP_STAGES.filter((x) => !placed.has(x.number)); // anything new lands in the last column automatically
  if (rest.length) phases[phases.length - 1].items.push(...rest);
  return (
    <section aria-label="Roadmap at a glance" className="mb-16">
      <div className="hidden xl:grid grid-cols-5 gap-3 mb-4">
        {phases.map((p) => (
          <div key={p.id} className="bg-[#0b2a4a] border border-[#1e4b7a] rounded-xl px-4 py-3 text-sm font-semibold text-white leading-snug min-h-[72px] flex items-center">{p.goal}</div>
        ))}
      </div>
      <div className="relative hidden xl:block h-10 mb-2" aria-hidden="true">
        <div className="absolute left-[10%] right-[10%] top-1/2 h-0.5 bg-[#1e4b7a]" />
        <div className="absolute inset-0 grid grid-cols-5">
          {phases.map((p) => { const st = phaseState(p.items); return (
            <div key={p.id} className="flex flex-col items-center justify-center">
              <span className="w-3.5 h-3.5 rotate-45 border-2" style={{ backgroundColor: st.color, borderColor: st.color }} />
            </div>); })}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
        {phases.map((p, i) => { const st = phaseState(p.items); return (
          <div key={p.id} className="bg-[#090d16]/80 border border-white/10 rounded-xl overflow-hidden flex flex-col">
            <div className="px-4 py-2.5 text-[12px] font-bold uppercase tracking-widest text-black" style={{ backgroundColor: st.color }}>Phase {i + 1} · {st.label}</div>
            <div className="px-4 pt-3 pb-2"><a href={`#${p.id}`} className="text-lg font-extrabold text-white hover:text-[#00f2fe]">{p.name}</a><p className="xl:hidden mt-1 text-[13px] text-[#9fc3e6]">{p.goal}</p></div>
            <ul className="px-4 pb-3 space-y-1.5 flex-1">
              {p.items.map((x) => (
                <li key={x.number}><a href={`#stage-${x.number}`} className="flex items-start gap-2 text-[13px] text-slate-300 hover:text-white">
                  <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: STATUS_COLORS[x.status] }} title={STATUS_LABELS[x.status]} />{shortTitle(x.title)}</a></li>
              ))}
            </ul>
            <div className="mx-3 mb-3 border border-[#1e4b7a] rounded-lg px-3 py-2 text-[12px] text-[#9fc3e6] italic">{st.live} of {st.total} live{st.live < st.total ? `, ${st.total - st.live} in progress` : ""}</div>
          </div>); })}
      </div>
      <div className="flex flex-wrap justify-center gap-4 mt-5 text-[12px] text-[#94a3b8]">
        {["LIVE", "IN_PROGRESS", "NEXT", "FUTURE"].map((k) => <span key={k} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: STATUS_COLORS[k] }} />{STATUS_LABELS[k]}</span>)}
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rotate-45" style={{ backgroundColor: STATUS_COLORS.LIVE }} />Phase milestone</span>
      </div>
    </section>
  );
}

// Detailed stage card in the same "project roadmap" style as the overview: a diamond on the phase's milestone
// line, the stage's description in a goal box, its deliverables as headed boxes and its notes in an outlined box.
// Wording is unchanged; only the layout differs.
const GROUP_COLS = { 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-3" };
function Diamond({ color }) {
  return <span className="mt-1.5 w-2 h-2 rotate-45 shrink-0" style={{ backgroundColor: color }} />;
}
function StageCard({ stage, last = false }) {
  const color = STATUS_COLORS[stage.status];
  const header = "px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-black";
  return (
    <div id={`stage-${stage.number}`} className="scroll-mt-6 relative pl-9 md:pl-12">
      {!last && <span aria-hidden="true" className="absolute left-[11px] md:left-[15px] top-7 -bottom-8 w-0.5 bg-[#1e4b7a]" />}
      <span aria-hidden="true" className="absolute left-[5px] md:left-[9px] top-5 w-3.5 h-3.5 rotate-45" style={{ backgroundColor: color }} />
      <div className={`bg-[#090d16]/80 border rounded-xl overflow-hidden ${stage.highlight ? "border-[#00f2fe]/40" : "border-white/10"}`}>
        <div className="flex items-center justify-between gap-3 flex-wrap px-5 py-3 border-b border-white/5">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-mono text-[12px] font-bold px-2 py-0.5 rounded text-black" style={{ backgroundColor: color }}>Stage {String(stage.number).padStart(2, "0")}</span>
            <h3 className="text-lg md:text-xl font-extrabold text-white tracking-tight">{stage.title}</h3>
          </div>
          <StatusBadge status={stage.status} />
        </div>
        <div className="p-5 md:p-6">
          <div className="bg-[#0b2a4a] border border-[#1e4b7a] rounded-lg px-4 py-3">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#9fc3e6] mb-1">Goal</p>
            <p className="text-sm text-white leading-relaxed">{stage.description}</p>
          </div>

          {stage.securityStatement && (
            <div className="mt-4 bg-[#00f2fe]/5 border border-[#00f2fe]/20 rounded-lg px-4 py-3">
              <p className="text-[#00f2fe] text-xs font-mono">{stage.securityStatement}</p>
            </div>
          )}

          {stage.features && (
            <div className="mt-4 border border-white/10 rounded-lg overflow-hidden">
              <p className={header} style={{ backgroundColor: color }}>Deliverables</p>
              <ul className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                {stage.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-slate-300"><Diamond color={color} />{f}</li>
                ))}
              </ul>
            </div>
          )}

          {stage.groups && (
            <div className={`mt-4 grid grid-cols-1 sm:grid-cols-2 ${GROUP_COLS[stage.groups.length] || ""} gap-3`}>
              {stage.groups.map((g) => (
                <div key={g.title} className="border border-white/10 rounded-lg overflow-hidden flex flex-col">
                  <p className={header} style={{ backgroundColor: color }}>{g.title}</p>
                  <ul className="p-4 space-y-1.5 flex-1">
                    {g.items.map((item) => (
                      <li key={item} className="text-sm text-slate-300 flex items-start gap-2"><Diamond color={color} />{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {stage.tools && (
            <div className="mt-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-[#8a96ab] mb-2">Implemented AI tools</p>
              <div className="flex flex-wrap gap-2">
                {stage.tools.map((t) => (
                  <code key={t} className="text-[13px] font-mono text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 rounded-md px-2 py-1">{t}</code>
                ))}
              </div>
            </div>
          )}

          {stage.diagram === "DOCUMENT_WORKFLOW_DIAGRAM" && <WorkflowDiagram />}

          {stage.examples && (
            <div className="mt-4 bg-black/20 border border-white/5 rounded-lg p-4">
              <ul className="space-y-1.5">
                {stage.examples.map((ex) => <li key={ex} className="text-sm text-slate-400 italic">{ex}</li>)}
              </ul>
              {stage.examplesNote && <p className="text-[12px] text-[#8a96ab] mt-3">{stage.examplesNote}</p>}
            </div>
          )}

          {stage.notes && (
            <div className="mt-4 border border-[#1e4b7a] rounded-lg px-4 py-3">
              <p className="text-[11px] font-bold uppercase tracking-widest text-[#9fc3e6] mb-1">Where it stands</p>
              <p className="text-xs text-[#9fc3e6] italic leading-relaxed">{stage.notes}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RoadmapPage() {
  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-7xl mx-auto">
        {/* HEADER */}
        <div className="flex items-center justify-between mb-10 text-xs font-mono text-[#8a96ab]">
          <a href="/" className="hover:text-slate-300">← Inaya Network</a>
          <a href="/business" className="hover:text-slate-300">Business Workspace →</a>
        </div>

        <div className="text-center mb-14">
          <span className="inline-block text-[12px] font-bold uppercase tracking-[0.2em] text-[#00f2fe] mb-3">
            Product Roadmap
          </span>
          <h1 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight">Business Workspace Roadmap</h1>
          <p className="text-[#94a3b8] text-sm md:text-base mt-4 max-w-2xl mx-auto leading-relaxed">{POSITIONING_STATEMENT}</p>
          <p className="text-[#8a96ab] text-xs md:text-sm mt-2 max-w-xl mx-auto leading-relaxed">{POSITIONING_SUBTEXT}</p>
        </div>

        <PhaseOverview />

        <div className="max-w-4xl mx-auto">
        {/* ARCHITECTURE FLOW */}
        <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 md:p-8 mb-14">
          <p className="text-[12px] font-bold uppercase tracking-wider text-[#8a96ab] mb-5 text-center">Architecture</p>
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

        {/* STAGES, grouped by phase */}
        <div className="space-y-14 lg:-mx-24">
          {PHASES.map((p, i) => { const nums = new Set(p.stages); const items = ROADMAP_STAGES.filter((x) => nums.has(x.number) || (i === PHASES.length - 1 && !PHASES.some((q) => q.stages.includes(x.number)))); return (
            <section key={p.id} id={p.id} className="scroll-mt-6">
              <div className="rounded-xl overflow-hidden border border-white/10 mb-6">
                <div className="px-5 py-2.5 text-[12px] font-bold uppercase tracking-widest text-black" style={{ backgroundColor: phaseState(items).color }}>Phase {i + 1} · {phaseState(items).label} · {phaseState(items).live} of {items.length} live</div>
                <div className="px-5 py-4 bg-[#090d16]/80">
                  <h2 className="text-xl md:text-2xl font-extrabold text-white">{p.name}</h2>
                  <p className="mt-2 inline-block bg-[#0b2a4a] border border-[#1e4b7a] rounded-lg px-3 py-2 text-sm font-semibold text-white">{p.goal}</p>
                </div>
              </div>
              <div className="space-y-8">{items.map((stage, k) => <StageCard key={stage.number} stage={stage} last={k === items.length - 1} />)}</div>
            </section>); })}
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
