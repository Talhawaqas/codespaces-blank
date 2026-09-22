import Link from "next/link";
import { loadAllDocs } from "../../lib/docsContent.js";
import StatusBadge from "../../components/docs/StatusBadge.js";

export const metadata = {
  title: "Inaya Documentation",
  description: "Search Inaya documentation — product guides, API reference, SDK reference, and CLI reference for the whole Inaya Network platform.",
};

const PRIMARY_CARDS = [
  { href: "/docs/products/storage", title: "Product Guides", description: "Storage, Business Workspace, Security, and more — organized by product." },
  { href: "/docs/api", title: "API Reference", description: "Every public/v1 endpoint — auth, parameters, responses." },
  { href: "/docs/sdk", title: "SDK Reference", description: "All 5 published npm packages, documented from their real exports." },
  { href: "/docs/cli", title: "CLI Reference", description: "inaya, create-inaya-dapp, and inaya-node-daemon — every real command." },
];

export default function DocsHomePage() {
  const docs = loadAllDocs();
  const recentlyUpdated = [...docs].sort((a, b) => (b.lastVerifiedAt || "").localeCompare(a.lastVerifiedAt || "")).slice(0, 5);

  return (
    <div>
      <section className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 py-16 text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 dark:text-white tracking-tight">Official Inaya Documentation</h1>
          <p className="mt-3 text-slate-500 dark:text-slate-400 max-w-2xl mx-auto">
            Product guides, API reference, SDK reference, and CLI reference for the whole Inaya Network platform — built directly from the real, shipped implementation.
          </p>
          <form action="/docs/search" className="mt-8 max-w-xl mx-auto">
            <label htmlFor="docs-home-search" className="sr-only">Search Inaya documentation</label>
            <div className="relative">
              <input
                id="docs-home-search"
                name="q"
                type="search"
                placeholder="Search storage, S3, SDK, Security API..."
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 pl-4 pr-24 py-3 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B63E5]"
              />
              <button
                type="submit"
                className="absolute right-1.5 top-1.5 rounded-md bg-[#0B63E5] text-white text-sm font-medium px-4 py-1.5 hover:bg-[#0952BE]"
              >
                Search
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-6 py-12">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {PRIMARY_CARDS.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="rounded-xl border border-slate-200 dark:border-slate-800 p-5 hover:border-[#0B63E5] dark:hover:border-[#5AA9FF] hover:shadow-sm transition-all"
            >
              <div className="font-semibold text-slate-900 dark:text-white">{card.title}</div>
              <div className="text-sm text-slate-500 dark:text-slate-400 mt-1.5">{card.description}</div>
            </Link>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-6 pb-16 grid lg:grid-cols-2 gap-10">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3">Recently updated</h2>
          <ul className="space-y-2">
            {recentlyUpdated.map((doc) => (
              <li key={doc.slug}>
                <Link
                  href={`/docs/${doc.product === "Developer Platform" ? "developer" : "products"}/${doc.slug}`}
                  className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 px-4 py-3 hover:border-[#0B63E5] dark:hover:border-[#5AA9FF]"
                >
                  <span className="text-sm font-medium text-slate-900 dark:text-white">{doc.title}</span>
                  <StatusBadge status={doc.status} />
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3">Developer quickstarts</h2>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              New to Inaya? Start with the <Link href="/docs/developer/developer-overview" className="text-[#0B63E5] dark:text-[#5AA9FF] hover:underline">Developer Overview</Link> for a 30-second quickstart, then the <Link href="/docs/products/storage" className="text-[#0B63E5] dark:text-[#5AA9FF] hover:underline">Storage</Link> and <Link href="/docs/products/storage-control-plane" className="text-[#0B63E5] dark:text-[#5AA9FF] hover:underline">Storage Control Plane</Link> guides for the platform's core.
            </p>
          </div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-8 mb-3">Ask Inaya</h2>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Prefer to ask a question in plain language? The <Link href="/" className="text-[#0B63E5] dark:text-[#5AA9FF] hover:underline">AI Docs Assistant</Link> on the main site is grounded in Inaya&rsquo;s own documentation and cites the pages it draws from.
            </p>
          </div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-8 mb-3">More</h2>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link href="/docs/release-notes" className="text-[#0B63E5] dark:text-[#5AA9FF] hover:underline">Release Notes</Link>
            <Link href="/openapi.json" className="text-[#0B63E5] dark:text-[#5AA9FF] hover:underline">OpenAPI spec</Link>
            <Link href="/docs/developer/contributing" className="text-[#0B63E5] dark:text-[#5AA9FF] hover:underline">Contributing to these docs</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
