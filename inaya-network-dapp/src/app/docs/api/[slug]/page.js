import { notFound } from "next/navigation";
import { API_ENDPOINTS } from "../../../../lib/docsApiReference.js";
import Breadcrumbs from "../../../../components/docs/Breadcrumbs.js";
import StatusBadge from "../../../../components/docs/StatusBadge.js";

export function generateStaticParams() {
  return API_ENDPOINTS.map((ep) => ({ slug: ep.slug }));
}

export function generateMetadata({ params }) {
  const ep = API_ENDPOINTS.find((e) => e.slug === params.slug);
  if (!ep) return {};
  return { title: `${ep.method} ${ep.path}`, description: ep.summary };
}

export default function ApiEndpointPage({ params }) {
  const ep = API_ENDPOINTS.find((e) => e.slug === params.slug);
  if (!ep) notFound();

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10">
      <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "API Reference", href: "/docs/api" }, { label: ep.path }]} />
      <div className="flex items-center gap-3 mb-2">
        <span className="font-mono text-sm font-semibold text-[#0B63E5] dark:text-[#5AA9FF] bg-[#0B63E5]/10 rounded px-2 py-1">{ep.method}</span>
        <h1 className="font-mono text-xl font-bold text-slate-900 dark:text-white">{ep.path}</h1>
        <StatusBadge status={ep.status} />
      </div>
      <p className="text-slate-600 dark:text-slate-300 mb-6">{ep.summary}</p>

      {ep.params.length > 0 && (
        <>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">Parameters</h2>
          <div className="overflow-x-auto mb-6">
            <table className="min-w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className="border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-left">Name</th>
                  <th className="border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-left">In</th>
                  <th className="border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-left">Required</th>
                  <th className="border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-left">Description</th>
                </tr>
              </thead>
              <tbody>
                {ep.params.map((p) => (
                  <tr key={p.name}>
                    <td className="border border-slate-200 dark:border-slate-700 px-3 py-2 font-mono text-xs">{p.name}</td>
                    <td className="border border-slate-200 dark:border-slate-700 px-3 py-2 text-slate-500 dark:text-slate-400">{p.in}</td>
                    <td className="border border-slate-200 dark:border-slate-700 px-3 py-2">{String(p.required)}</td>
                    <td className="border border-slate-200 dark:border-slate-700 px-3 py-2 text-slate-600 dark:text-slate-300">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">Response</h2>
      <p className="text-slate-600 dark:text-slate-300 mb-6">{ep.response}</p>

      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">Example</h2>
      <pre className="overflow-x-auto bg-slate-900 text-slate-100 p-4 text-sm rounded-lg">
        <code>{`curl -H "Authorization: Bearer $INAYA_API_KEY" \\\n  "https://app.inaya.network${ep.path.replace(/\{[^}]+\}/g, "REPLACE_ME")}"`}</code>
      </pre>
    </div>
  );
}
