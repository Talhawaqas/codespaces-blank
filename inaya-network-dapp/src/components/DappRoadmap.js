"use client";

// src/components/DappRoadmap.js -- the dApp About-tab roadmap in the same "project roadmap" style as the Business
// Workspace roadmap (/business/roadmap): a phase overview with a milestone line, then each phase as a card on a
// diamond timeline with its deliverables in headed boxes. WORDING IS UNCHANGED: the phases and items come straight
// from roadmapPhases in src/app/page.js; this file only changes the layout (owner, 22 Nov 2026: after the Commerce SOW).

// dApp theme colours (cyan/blue brand on dark navy; amber = in progress, violet = future, as elsewhere in the dApp)
const COLORS = { completed: "#00f2fe", technically_completed: "#4facfe", in_progress: "#fbbf24", planned: "#4facfe", future: "#a78bfa" };
const TICK = "#00f2fe";
const LABELS = { completed: "Completed", technically_completed: "Technically complete", in_progress: "In progress", planned: "Planned", future: "Future" };

const itemOf = (it, phaseStatus) => (typeof it === "string" ? { text: it, done: phaseStatus === "completed" } : { text: it.text, done: !!it.done });
const nameOf = (phase) => String(phase).split(" — ").slice(1).join(" — ") || String(phase);
const numberOf = (phase, i) => (String(phase).match(/Phase\s+(\d+)/) || [null, String(i + 1)])[1];

// "SDK — Delete files" -> group "SDK"; items without a prefix share one group named after the phase.
function groupItems(items, fallback) {
  const pre = (t) => { const m = t.match(/^(.{2,48}?) — (.+)$/); return m ? [m[1], m[2]] : [null, t]; };
  const counts = new Map(); for (const it of items) { const [g] = pre(it.text); if (g) counts.set(g, (counts.get(g) || 0) + 1); }
  const groups = new Map([[fallback, []]]);
  for (const it of items) {
    const [g, rest] = pre(it.text); const shared = g && counts.get(g) > 1; // a prefix becomes a box only when 2+ items share it
    const key = shared ? g : fallback; if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...it, label: shared ? rest : it.text });
  }
  return [...groups.entries()].filter(([, list]) => list.length).map(([title, list]) => ({ title, list }));
}

function Mark({ done, color }) {
  return done
    ? <span aria-label="Done" className="mt-[3px] w-4 h-4 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-black" style={{ backgroundColor: TICK }}>✓</span>
    : <span aria-label="Not done yet" className="mt-[7px] w-2 h-2 rotate-45 shrink-0" style={{ backgroundColor: color }} />;
}

export default function DappRoadmap({ phases = [] }) {
  const rows = phases.map((p, i) => {
    const items = (p.items || []).map((it) => itemOf(it, p.status));
    const done = items.filter((x) => x.done).length;
    return { key: p.phase, n: numberOf(p.phase, i), name: nameOf(p.phase), status: p.status, color: COLORS[p.status] || "#64748b", items, done, total: items.length };
  });
  return (
    <div className="space-y-10">
      {/* overview */}
      <section aria-label="Roadmap at a glance">
        <div className="relative hidden lg:block h-8 mb-2" aria-hidden="true">
          <div className="absolute left-[10%] right-[10%] top-1/2 h-0.5 bg-[#00f2fe]/20" />
          <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
            {rows.map((r) => <div key={r.key} className="flex items-center justify-center"><span className="w-3.5 h-3.5 rotate-45" style={{ backgroundColor: r.color }} /></div>)}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 lg:[grid-template-columns:var(--cols)]" style={{ "--cols": `repeat(${rows.length}, minmax(0, 1fr))` }}>
          {rows.map((r) => (
            <a key={r.key} href={`#roadmap-phase-${r.n}`} className="bg-[#090d16]/80 border border-white/10 rounded-xl overflow-hidden flex flex-col hover:border-white/25 transition-colors">
              <div className="px-4 py-2 text-[12px] font-bold text-black" style={{ backgroundColor: r.color }}>Phase {r.n} · {LABELS[r.status] || r.status}</div>
              <div className="px-4 pt-3 pb-3 flex-1 flex flex-col">
                <span className="text-base font-extrabold text-white leading-snug">{r.name}</span>
                <div className="mt-auto pt-3">
                  <div className="h-1.5 rounded-full bg-white/10 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${r.total ? Math.round((r.done / r.total) * 100) : 0}%`, backgroundColor: r.color }} /></div>
                  <p className="mt-1.5 text-[12px] text-[#8a96ab]">{r.done} of {r.total} done</p>
                </div>
              </div>
            </a>
          ))}
        </div>
        <div className="flex flex-wrap justify-center gap-4 mt-4 text-[12px] text-[#94a3b8]">
          {["completed", "in_progress", "future"].map((k) => <span key={k} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rotate-45" style={{ backgroundColor: COLORS[k] }} />{LABELS[k]}</span>)}
          <span className="inline-flex items-center gap-1.5"><span className="w-3.5 h-3.5 rounded-full flex items-center justify-center text-[9px] font-bold text-black" style={{ backgroundColor: TICK }}>✓</span>Delivered item</span>
        </div>
      </section>

      {/* phases on a diamond timeline */}
      <section aria-label="Roadmap in detail" className="space-y-8">
        {rows.map((r, idx) => {
          const groups = groupItems(r.items, r.name);
          return (
            <div key={r.key} id={`roadmap-phase-${r.n}`} className="scroll-mt-6 relative pl-9 md:pl-12">
              {idx < rows.length - 1 && <span aria-hidden="true" className="absolute left-[11px] md:left-[15px] top-7 -bottom-8 w-0.5 bg-[#00f2fe]/20" />}
              <span aria-hidden="true" className="absolute left-[5px] md:left-[9px] top-5 w-3.5 h-3.5 rotate-45" style={{ backgroundColor: r.color }} />
              <div className="bg-[#090d16]/80 border border-white/10 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between gap-3 flex-wrap px-5 py-3 border-b border-white/5">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-[12px] font-bold px-2 py-0.5 rounded text-black" style={{ backgroundColor: r.color }}>Phase {String(r.n).padStart(2, "0")}</span>
                    <h3 className="text-lg md:text-xl font-extrabold text-white tracking-tight">{r.name}</h3>
                  </div>
                  <span className="text-[12px] font-semibold px-2.5 py-0.5 rounded-full border" style={{ color: r.color, borderColor: `${r.color}66`, backgroundColor: `${r.color}14` }}>{LABELS[r.status] || r.status} · {r.done}/{r.total}</span>
                </div>
                {(() => {
                  // No empty gaps (owner, 23 Nov 2026): long boxes (or a phase's only box) span the full width with items in
                  // columns; the shorter boxes flow as a masonry, each only as tall as its own list.
                  const wide = (g) => groups.length === 1 || g.list.length > 12;
                  const Box = ({ g }) => (
                    <div className="border border-white/10 rounded-lg overflow-hidden">
                      <p className="px-4 py-2 text-[12px] font-bold text-black flex justify-between gap-2" style={{ backgroundColor: r.color }}><span>{g.title}</span><span className="font-semibold opacity-80">{g.list.filter((x) => x.done).length}/{g.list.length}</span></p>
                      <ul className={`p-4 gap-x-6 ${wide(g) ? (g.list.length > 12 ? "columns-1 sm:columns-2 xl:columns-3" : "columns-1 sm:columns-2") : ""}`}>
                        {g.list.map((x) => (
                          <li key={x.text} className={`flex items-start gap-2 text-[13px] leading-snug break-inside-avoid mb-1.5 ${x.done ? "text-slate-300" : "text-slate-400"}`}><Mark done={x.done} color={r.color} />{x.label}</li>
                        ))}
                      </ul>
                    </div>
                  );
                  const small = groups.filter((g) => !wide(g));
                  return (
                    <div className="p-5 md:p-6 space-y-3">
                      {groups.filter(wide).map((g) => <Box key={g.title} g={g} />)}
                      {small.length > 0 && <div className="columns-1 sm:columns-2 xl:columns-3 gap-3">{small.map((g) => <div key={g.title} className="break-inside-avoid mb-3"><Box g={g} /></div>)}</div>}
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
