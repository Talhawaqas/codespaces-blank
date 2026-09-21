import { notFound } from "next/navigation";
import { CLI_TOOLS } from "../../../../lib/docsCliReference.js";
import Breadcrumbs from "../../../../components/docs/Breadcrumbs.js";
import StatusBadge from "../../../../components/docs/StatusBadge.js";

export function generateStaticParams() {
  return CLI_TOOLS.map((t) => ({ slug: t.slug }));
}

export function generateMetadata({ params }) {
  const tool = CLI_TOOLS.find((t) => t.slug === params.slug);
  if (!tool) return {};
  return { title: tool.packageName, description: tool.tagline };
}

export default function CliToolPage({ params }) {
  const tool = CLI_TOOLS.find((t) => t.slug === params.slug);
  if (!tool) notFound();

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10">
      <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "CLI Reference", href: "/docs/cli" }, { label: tool.binary }]} />
      <div className="flex items-center gap-3 mb-2">
        <h1 className="font-mono text-xl font-bold text-slate-900 dark:text-white">{tool.packageName}</h1>
        <StatusBadge status={tool.status} />
      </div>
      <p className="text-slate-600 dark:text-slate-300 mb-4">{tool.tagline}</p>
      <pre className="overflow-x-auto bg-slate-900 text-slate-100 p-4 text-sm rounded-lg mb-6">
        <code>{tool.install}</code>
      </pre>

      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3">Commands</h2>
      <div className="space-y-3">
        {tool.commands.map((c) => (
          <div key={c.command} className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
            <code className="font-mono text-sm font-semibold text-[#0B63E5] dark:text-[#5AA9FF]">{c.command}</code>
            <p className="text-sm text-slate-600 dark:text-slate-300 mt-1.5">{c.detail}</p>
            {c.options && <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 font-mono">{c.options}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
