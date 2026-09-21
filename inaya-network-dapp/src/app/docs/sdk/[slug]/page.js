import { notFound } from "next/navigation";
import { SDK_PACKAGES } from "../../../../lib/docsSdkReference.js";
import Breadcrumbs from "../../../../components/docs/Breadcrumbs.js";
import StatusBadge from "../../../../components/docs/StatusBadge.js";

export function generateStaticParams() {
  return SDK_PACKAGES.map((p) => ({ slug: p.slug }));
}

export function generateMetadata({ params }) {
  const pkg = SDK_PACKAGES.find((p) => p.slug === params.slug);
  if (!pkg) return {};
  return { title: pkg.name, description: pkg.tagline };
}

export default function SdkPackagePage({ params }) {
  const pkg = SDK_PACKAGES.find((p) => p.slug === params.slug);
  if (!pkg) notFound();

  const items = pkg.exports || pkg.layers || [];

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10">
      <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "SDK Reference", href: "/docs/sdk" }, { label: pkg.name }]} />
      <div className="flex items-center gap-3 mb-2">
        <h1 className="font-mono text-xl font-bold text-slate-900 dark:text-white">{pkg.name}</h1>
        <StatusBadge status={pkg.status} />
      </div>
      <p className="text-slate-600 dark:text-slate-300 mb-4">{pkg.tagline}</p>

      <pre className="overflow-x-auto bg-slate-900 text-slate-100 p-4 text-sm rounded-lg mb-6">
        <code>{pkg.install}</code>
      </pre>

      {pkg.peerDeps && <p className="text-sm text-slate-500 dark:text-slate-400 mb-6"><strong className="text-slate-700 dark:text-slate-300">Peer dependencies:</strong> {pkg.peerDeps}</p>}

      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3">
        {pkg.layers ? "Layers" : "Exports"}
      </h2>
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.name} className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
            <div className="flex items-baseline gap-2">
              <span className="font-mono font-semibold text-slate-900 dark:text-white">{item.name}</span>
              {item.kind && <span className="text-xs text-slate-400 dark:text-slate-500">{item.kind}{item.file ? ` — ${item.file}` : ""}</span>}
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">{item.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
