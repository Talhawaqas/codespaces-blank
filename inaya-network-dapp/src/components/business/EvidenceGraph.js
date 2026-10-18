"use client";

// src/components/business/EvidenceGraph.js
//
// Business Workspace gap closure, Batch 3 — a visual Evidence Graph for one
// business event: the event in the centre, one node per piece of evidence
// it's linked to (from the existing "Why?" explanation — same permission
// scoping, no new data), grouped by record type around the circle. Edge
// color = evidence state (included / restricted / missing). Dependency-free
// SVG; every node is a focusable button, and the list view stays available.

import { useState } from "react";

const STATE_COLOR = { INCLUDED: "#34d399", RESTRICTED: "#fbbf24", MISSING: "#f87171" };
const STATE_LABEL = { INCLUDED: "Included", RESTRICTED: "Restricted (you can't see it)", MISSING: "Missing" };
const colorFor = (state) => STATE_COLOR[state] || "#8a96ab";
const short = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || "");

/** Pure layout: groups nodes by targetType and spreads them around a circle. */
export function layoutEvidence(evidence, { width = 560, height = 360 } = {}) {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 2 - 56;
  const sorted = [...evidence].map((e, i) => ({ ...e, key: `${e.targetType}-${e.targetId || i}-${i}` })).sort((a, b) => String(a.targetType).localeCompare(String(b.targetType)));
  const n = sorted.length;
  return {
    center: { x: cx, y: cy },
    nodes: sorted.map((e, i) => {
      const angle = n === 1 ? -Math.PI / 2 : (2 * Math.PI * i) / n - Math.PI / 2;
      return { ...e, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), anchor: Math.cos(angle) > 0.3 ? "start" : Math.cos(angle) < -0.3 ? "end" : "middle" };
    }),
  };
}

export default function EvidenceGraph({ title, evidence = [] }) {
  const [selected, setSelected] = useState(null);
  const width = 560;
  const height = 360;
  const { center, nodes } = layoutEvidence(evidence, { width, height });
  const active = nodes.find((n) => n.key === selected) || null;

  if (evidence.length === 0) return <p className="text-[var(--inaya-text-muted)] text-xs">No linked evidence yet.</p>;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full max-w-[560px] min-w-[320px] h-auto" role="img" aria-label={`Evidence graph: ${evidence.length} linked records`}>
          {nodes.map((n) => (
            <g key={`edge-${n.key}`}>
              <line x1={center.x} y1={center.y} x2={n.x} y2={n.y} stroke={colorFor(n.state)} strokeOpacity={selected && selected !== n.key ? 0.25 : 0.7} strokeWidth={selected === n.key ? 2.5 : 1.5} strokeDasharray={n.state === "INCLUDED" ? undefined : "4 3"} />
              <text x={(center.x + n.x) / 2} y={(center.y + n.y) / 2 - 4} textAnchor="middle" fontSize="9" fill="var(--inaya-text-muted)">{short(n.relationship, 18)}</text>
            </g>
          ))}
          <circle cx={center.x} cy={center.y} r="34" fill="rgba(0,242,254,0.12)" stroke="#00f2fe" strokeWidth="1.5" />
          <text x={center.x} y={center.y + 3} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--inaya-text-primary)">{short(title, 14)}</text>
          {nodes.map((n) => (
            <g key={n.key} role="button" tabIndex={0} aria-label={`${n.relationship} ${n.targetType}${n.label ? ` ${n.label}` : ""}, ${STATE_LABEL[n.state] || n.state}`}
              onClick={() => setSelected(selected === n.key ? null : n.key)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(selected === n.key ? null : n.key); } }}
              className="cursor-pointer focus:outline-none">
              <circle cx={n.x} cy={n.y} r={selected === n.key ? 13 : 10} fill="var(--inaya-surface, #0b1220)" stroke={colorFor(n.state)} strokeWidth="2" />
              <text x={n.x + (n.anchor === "start" ? 16 : n.anchor === "end" ? -16 : 0)} y={n.y + (n.anchor === "middle" ? (n.y < center.y ? -16 : 24) : 4)} textAnchor={n.anchor} fontSize="10" fill="var(--inaya-text-primary)">{short(n.targetType, 22)}</text>
            </g>
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] text-[var(--inaya-text-muted)]">
        {Object.entries(STATE_LABEL).map(([k, v]) => <span key={k} className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: STATE_COLOR[k] }} />{v}</span>)}
      </div>
      {active && (
        <div className="bg-black/30 border border-white/10 rounded-md p-2.5 text-[12px] space-y-0.5">
          <p className="text-[var(--inaya-text-primary)] font-bold">{active.relationship} → {active.targetType}</p>
          {active.label && <p className="text-[var(--inaya-text-muted)]">{active.label}</p>}
          <p style={{ color: colorFor(active.state) }}>{STATE_LABEL[active.state] || active.state}</p>
          {active.targetId && <p className="font-mono text-[10px] text-[var(--inaya-text-muted)]">ID {active.targetId}</p>}
        </div>
      )}
    </div>
  );
}
