import { ROADMAP_STAGES, STATUS_LABELS } from "../../../lib/saasRoadmap.js";
import Breadcrumbs from "../../../components/docs/Breadcrumbs.js";
import StatusBadge from "../../../components/docs/StatusBadge.js";

export const metadata = {
  title: "Release Notes",
  description: "What shipped, stage by stage — sourced directly from the Business SaaS Roadmap, the same data src/lib/saasRoadmap.js already tracks.",
};

// Official Documentation Platform SOW -- deliberately reuses
// src/lib/saasRoadmap.js's ROADMAP_STAGES rather than hand-authoring a
// second, parallel changelog that could drift from it. Each stage is
// already dated (in its title/notes where a specific month is known),
// already verified, and already carries its own honest "what's not
// built" disclosure in `notes` -- exactly what a real release note needs,
// with no second source of truth to keep in sync.
const STATUS_TO_DOCS_STATUS = { LIVE: "live", TESTNET: "testnet", BETA: "beta", PLANNED: "planned" };

export default function ReleaseNotesPage() {
  const stages = [...ROADMAP_STAGES].sort((a, b) => b.number - a.number);

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10">
      <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "Release Notes" }]} />
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">Release Notes</h1>
      <p className="text-slate-500 dark:text-slate-400 mb-8">
        Every stage of the Business SaaS Roadmap, newest first — the same source of truth the <a href="/business/roadmap" className="text-[#0B63E5] dark:text-[#5AA9FF] hover:underline">public roadmap</a> renders from, so this list can never drift from what the roadmap itself claims.
      </p>

      <div className="space-y-8">
        {stages.map((stage) => (
          <article key={stage.number} className="border-b border-slate-200 dark:border-slate-800 pb-8 last:border-0">
            <div className="flex items-center gap-3 mb-2">
              <span className="font-mono text-xs text-slate-400 dark:text-slate-500">Stage {stage.number}</span>
              <StatusBadge status={STATUS_TO_DOCS_STATUS[stage.status] || "planned"} />
            </div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{stage.title}</h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 mt-2">{stage.description}</p>

            {stage.features?.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1.5">Added</div>
                <ul className="list-disc list-outside ml-5 space-y-1 text-sm text-slate-600 dark:text-slate-300">
                  {stage.features.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {stage.securityStatement && (
              <div className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-slate-700 dark:text-slate-300">Security: </span>
                {stage.securityStatement}
              </div>
            )}

            {stage.notes && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-[#0B63E5] dark:text-[#5AA9FF]">Verification &amp; known limitations</summary>
                <p className="mt-2 text-slate-500 dark:text-slate-400">{stage.notes}</p>
              </details>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
