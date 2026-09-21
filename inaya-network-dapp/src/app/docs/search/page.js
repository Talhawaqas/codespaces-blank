import { Suspense } from "react";
import { buildSearchIndex } from "../../../lib/docsContent.js";
import { API_ENDPOINTS } from "../../../lib/docsApiReference.js";
import { SDK_PACKAGES } from "../../../lib/docsSdkReference.js";
import { CLI_TOOLS } from "../../../lib/docsCliReference.js";
import Breadcrumbs from "../../../components/docs/Breadcrumbs.js";
import DocsSearchClient from "../../../components/docs/DocsSearchClient.js";

export const metadata = {
  title: "Search",
  description: "Search Inaya documentation.",
};

function buildFullIndex() {
  const contentIndex = buildSearchIndex();
  const apiIndex = API_ENDPOINTS.map((ep) => ({
    slug: ep.slug,
    title: `${ep.method} ${ep.path}`,
    description: ep.summary,
    product: "API",
    contentType: "API Reference",
    status: ep.status,
    tags: ["api"],
    headings: [],
  }));
  const sdkIndex = SDK_PACKAGES.map((pkg) => ({
    slug: pkg.slug,
    title: pkg.name,
    description: pkg.tagline,
    product: "Developer Platform",
    contentType: "SDK Reference",
    status: pkg.status,
    tags: ["sdk"],
    headings: [],
  }));
  const cliIndex = CLI_TOOLS.map((tool) => ({
    slug: tool.slug,
    title: tool.packageName,
    description: tool.tagline,
    product: "Developer Platform",
    contentType: "CLI Reference",
    status: tool.status,
    tags: ["cli"],
    headings: [],
  }));
  return [...contentIndex, ...apiIndex, ...sdkIndex, ...cliIndex];
}

export default function DocsSearchPage() {
  const index = buildFullIndex();
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-10">
      <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "Search" }]} />
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-6">Search documentation</h1>
      <Suspense fallback={null}>
        <DocsSearchClient index={index} />
      </Suspense>
    </div>
  );
}
