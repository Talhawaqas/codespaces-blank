import Link from "next/link";
import { API_ENDPOINTS, API_AUTH_NOTE } from "../../../lib/docsApiReference.js";
import Breadcrumbs from "../../../components/docs/Breadcrumbs.js";
import StatusBadge from "../../../components/docs/StatusBadge.js";

export const metadata = {
  title: "API Reference",
  description: "Every Inaya public/v1 endpoint — authentication, parameters, and responses, hand-verified against the real route implementation.",
};

export default function ApiIndexPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10">
      <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "API Reference" }]} />
      <div className="flex items-center justify-between gap-4 mb-2">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">API Reference</h1>
        <a
          href="/openapi.json"
          className="text-sm font-medium text-[#0B63E5] dark:text-[#5AA9FF] border border-[#0B63E5]/30 dark:border-[#5AA9FF]/30 rounded-md px-3 py-1.5 hover:bg-[#0B63E5]/5 shrink-0"
          download
        >
          Download OpenAPI spec
        </a>
      </div>
      <p className="text-slate-500 dark:text-slate-400 mb-6">{API_AUTH_NOTE}</p>
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800">
        {API_ENDPOINTS.map((ep) => (
          <Link
            key={ep.slug}
            href={`/docs/api/${ep.slug}`}
            className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-900"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold text-[#0B63E5] dark:text-[#5AA9FF]">{ep.method}</span>
                <span className="font-mono text-sm text-slate-900 dark:text-white truncate">{ep.path}</span>
              </div>
              <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{ep.summary}</div>
            </div>
            <StatusBadge status={ep.status} className="shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}
