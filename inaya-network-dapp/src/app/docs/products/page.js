// src/app/docs/products/page.js
//
// Product Guides index. Fixes a real gap: the homepage's "Product Guides" card, and every page's
// "Product Guides" breadcrumb, linked directly to /docs/products/storage (the first product) with no page
// anywhere actually listing every product guide -- a visitor had to already know a product's name, use
// search, or follow the 5-item "Recently updated" list on the homepage. This page lists every real
// contentType:"Product Guide" doc (the same set /docs/products/[slug] serves), grouped by product.

import Link from "next/link";
import { loadAllDocs } from "../../../lib/docsContent.js";
import Breadcrumbs from "../../../components/docs/Breadcrumbs.js";
import StatusBadge from "../../../components/docs/StatusBadge.js";

export const metadata = {
  title: "Product Guides",
  description: "Every Inaya product guide, organized by product.",
};

export default function ProductGuidesIndexPage() {
  const guides = loadAllDocs().filter((d) => d.contentType === "Product Guide");
  const byProduct = new Map();
  for (const doc of guides) {
    if (!byProduct.has(doc.product)) byProduct.set(doc.product, []);
    byProduct.get(doc.product).push(doc);
  }
  const products = [...byProduct.keys()].sort((a, b) => a.localeCompare(b));

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-10">
      <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "Product Guides" }]} />
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">Product Guides</h1>
      <p className="text-slate-500 dark:text-slate-400 mb-8">
        {guides.length} guide{guides.length === 1 ? "" : "s"} across {products.length} product{products.length === 1 ? "" : "s"} — every one built from the real, shipped implementation.
      </p>
      <div className="space-y-10">
        {products.map((product) => (
          <section key={product}>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-3">{product}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {byProduct.get(product)
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((doc) => (
                  <Link
                    key={doc.slug}
                    href={`/docs/products/${doc.slug}`}
                    className="block rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:border-[#0B63E5] dark:hover:border-[#0B63E5] transition-colors"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-slate-900 dark:text-white">{doc.title}</span>
                      <StatusBadge status={doc.status} />
                    </div>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{doc.description}</p>
                  </Link>
                ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
