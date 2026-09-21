import Link from "next/link";
import { SDK_PACKAGES } from "../../../lib/docsSdkReference.js";
import Breadcrumbs from "../../../components/docs/Breadcrumbs.js";
import StatusBadge from "../../../components/docs/StatusBadge.js";

export const metadata = {
  title: "SDK Reference",
  description: "All 5 published Inaya npm packages, documented from their real exports and README content.",
};

export default function SdkIndexPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10">
      <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "SDK Reference" }]} />
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">SDK Reference</h1>
      <p className="text-slate-500 dark:text-slate-400 mb-6">Five packages, all confirmed published and live on the public npm registry.</p>
      <div className="grid sm:grid-cols-2 gap-4">
        {SDK_PACKAGES.map((pkg) => (
          <Link
            key={pkg.slug}
            href={`/docs/sdk/${pkg.slug}`}
            className="rounded-xl border border-slate-200 dark:border-slate-800 p-5 hover:border-[#0B63E5] dark:hover:border-[#5AA9FF] transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm font-semibold text-slate-900 dark:text-white">{pkg.name}</span>
              <StatusBadge status={pkg.status} />
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">{pkg.tagline}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
