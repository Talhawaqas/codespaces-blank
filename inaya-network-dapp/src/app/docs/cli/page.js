import Link from "next/link";
import { CLI_TOOLS } from "../../../lib/docsCliReference.js";
import Breadcrumbs from "../../../components/docs/Breadcrumbs.js";
import StatusBadge from "../../../components/docs/StatusBadge.js";

export const metadata = {
  title: "CLI Reference",
  description: "Every real command across Inaya's three published CLI tools.",
};

export default function CliIndexPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10">
      <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "CLI Reference" }]} />
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">CLI Reference</h1>
      <p className="text-slate-500 dark:text-slate-400 mb-6">Three published command-line tools.</p>
      <div className="grid sm:grid-cols-2 gap-4">
        {CLI_TOOLS.map((tool) => (
          <Link
            key={tool.slug}
            href={`/docs/cli/${tool.slug}`}
            className="rounded-xl border border-slate-200 dark:border-slate-800 p-5 hover:border-[#0B63E5] dark:hover:border-[#5AA9FF] transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm font-semibold text-slate-900 dark:text-white">{tool.binary}</span>
              <StatusBadge status={tool.status} />
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">{tool.tagline}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
