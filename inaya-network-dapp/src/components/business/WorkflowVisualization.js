// src/components/business/WorkflowVisualization.js
//
// Shown in place of a plain "select something" placeholder in the browse
// view's rightmost empty column (see OrgWorkspace in app/business/page.js)
// -- narrow-column-friendly, pure CSS animation (no canvas/JS loop),
// respects prefers-reduced-motion via the .inaya-workflow-* rules in
// globals.css, same pattern as AccentGraphic.js.
//
// Illustrates the two things that are actually true about this product:
// the real Company -> Department -> Project -> Document hierarchy, and
// that a document gets encrypted + split into two shards at the end of
// that chain -- not generic decoration.

const STEPS = [
  { icon: "🏢", label: "Department" },
  { icon: "📁", label: "Project" },
  { icon: "📄", label: "Document" },
];

export default function WorkflowVisualization() {
  return (
    <div className="py-2" aria-hidden="true">
      <div className="flex flex-col items-center">
        {STEPS.map((step, i) => (
          <div key={step.label} className="flex flex-col items-center">
            <div
              className="w-11 h-11 rounded-2xl bg-[#00f2fe]/10 border border-[#00f2fe]/20 flex items-center justify-center text-lg inaya-workflow-pulse"
              style={{ animationDelay: `${i * 0.5}s` }}
            >
              {step.icon}
            </div>
            <p className="text-[11px] text-[#8a96ab] font-mono uppercase tracking-wide mt-1.5">{step.label}</p>
            <div className="relative w-px h-7 bg-gradient-to-b from-[#00f2fe]/30 to-[#00f2fe]/5 my-1 overflow-visible">
              <div
                className="absolute left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-[#00f2fe] inaya-workflow-flow"
                style={{ animationDelay: `${i * 0.5}s` }}
              />
            </div>
          </div>
        ))}

        {/* File-securing step -- a document splitting into two independent
            encrypted shards, matching the real client-side encrypt+split
            pipeline (see /faq's "How does client-side encryption actually
            protect me?"). */}
        <div className="relative w-16 h-11 flex items-center justify-center">
          <div
            className="absolute text-lg inaya-shard-split"
            style={{ "--shard-x": "-9px", "--shard-r": "-8deg" }}
          >
            🔒
          </div>
          <div
            className="absolute text-[12px] translate-x-3 -translate-y-2 inaya-shard-split"
            style={{ "--shard-x": "8px", "--shard-r": "10deg", animationDelay: "0.15s" }}
          >
            ▪️
          </div>
          <div
            className="absolute text-[12px] -translate-x-3 translate-y-2 inaya-shard-split"
            style={{ "--shard-x": "-8px", "--shard-r": "-10deg", animationDelay: "0.15s" }}
          >
            ▪️
          </div>
        </div>
        <p className="text-[11px] text-[#00f2fe]/80 font-mono uppercase tracking-wide mt-1.5 text-center">
          Encrypted &amp; sharded
        </p>
      </div>
    </div>
  );
}
