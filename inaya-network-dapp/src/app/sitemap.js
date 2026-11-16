// app/sitemap.js
//
// Native Next.js App Router sitemap convention — served automatically at
// /sitemap.xml, no package needed. Only lists real, public, indexable
// routes: excludes /admin/* (private dashboards), /oauth2redirect (auth
// callback), and /business/share/[token] (private per-recipient links,
// also disallowed in robots.js). /dataroom is deliberately excluded too —
// it's NDA-gated investor content, meant to be reached by direct/invite
// link, not organic search (see its own page metadata: robots: noindex).
// Wallet-only app screens (/bridge, /operator, /nfts) are left out: they
// have nothing to show a visitor without a connected wallet.
//
// SEO pass (15 Nov 2026): adds the documentation pages (product guides,
// developer guides, SDK and CLI reference), the Business Workspace demo, and
// the public trust/support/apps/build/verification pages, using the same
// slug lists the [slug] pages generate from, so new docs appear automatically.

import { loadAllDocs } from "../lib/docsContent.js";
import { SDK_PACKAGES } from "../lib/docsSdkReference.js";
import { CLI_TOOLS } from "../lib/docsCliReference.js";

const BASE_URL = "https://www.inayanetwork.com";

export default function sitemap() {
  const now = new Date();

  const routes = [
    { path: "/", priority: 1.0, changeFrequency: "daily" },
    { path: "/business", priority: 0.9, changeFrequency: "weekly" },
    { path: "/business/pricing", priority: 0.8, changeFrequency: "monthly" },
    { path: "/business/demo", priority: 0.8, changeFrequency: "monthly" },
    { path: "/business/download", priority: 0.6, changeFrequency: "monthly" },
    { path: "/business/roadmap", priority: 0.6, changeFrequency: "monthly" },
    { path: "/about", priority: 0.8, changeFrequency: "monthly" },
    { path: "/whitepaper", priority: 0.8, changeFrequency: "monthly" },
    { path: "/faq", priority: 0.7, changeFrequency: "monthly" },
    { path: "/security", priority: 0.8, changeFrequency: "weekly" },
    { path: "/trust", priority: 0.7, changeFrequency: "monthly" },
    { path: "/stats", priority: 0.6, changeFrequency: "daily" },
    { path: "/automation", priority: 0.5, changeFrequency: "weekly" },
    { path: "/build", priority: 0.7, changeFrequency: "monthly" },
    { path: "/apps", priority: 0.6, changeFrequency: "weekly" },
    { path: "/support", priority: 0.5, changeFrequency: "monthly" },
    { path: "/verify-document", priority: 0.5, changeFrequency: "monthly" },
    { path: "/download", priority: 0.6, changeFrequency: "monthly" },
    { path: "/docs", priority: 0.8, changeFrequency: "weekly" },
    { path: "/docs/products", priority: 0.7, changeFrequency: "weekly" },
    { path: "/docs/sdk", priority: 0.6, changeFrequency: "monthly" },
    { path: "/docs/cli", priority: 0.6, changeFrequency: "monthly" },
    { path: "/docs/release-notes", priority: 0.5, changeFrequency: "weekly" },
    { path: "/changelog", priority: 0.6, changeFrequency: "weekly" },
    { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
    { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
  ];

  const docs = loadAllDocs();
  for (const d of docs.filter((x) => x.contentType === "Product Guide")) routes.push({ path: `/docs/products/${d.slug}`, priority: 0.7, changeFrequency: "monthly" });
  for (const d of docs.filter((x) => x.product === "Developer Platform")) routes.push({ path: `/docs/developer/${d.slug}`, priority: 0.6, changeFrequency: "monthly" });
  for (const p of SDK_PACKAGES) routes.push({ path: `/docs/sdk/${p.slug}`, priority: 0.5, changeFrequency: "monthly" });
  for (const t of CLI_TOOLS) routes.push({ path: `/docs/cli/${t.slug}`, priority: 0.5, changeFrequency: "monthly" });

  // A doc can match both filters above only if misfiled; keep each URL once.
  const seen = new Set();
  return routes
    .filter((r) => (seen.has(r.path) ? false : seen.add(r.path)))
    .map((route) => ({
      url: `${BASE_URL}${route.path}`,
      lastModified: now,
      changeFrequency: route.changeFrequency,
      priority: route.priority,
    }));
}
