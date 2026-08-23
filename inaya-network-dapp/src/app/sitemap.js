// app/sitemap.js
//
// Native Next.js App Router sitemap convention — served automatically at
// /sitemap.xml, no package needed. Only lists real, public, indexable
// routes: excludes /admin/* (private dashboards), /oauth2redirect (auth
// callback), and /business/share/[token] (private per-recipient links,
// also disallowed in robots.js). /dataroom is deliberately excluded too —
// it's NDA-gated investor content, meant to be reached by direct/invite
// link, not organic search (see its own page metadata: robots: noindex).

const BASE_URL = "https://www.inayanetwork.com";

export default function sitemap() {
  const now = new Date();

  const routes = [
    { path: "/", priority: 1.0, changeFrequency: "daily" },
    { path: "/about", priority: 0.8, changeFrequency: "monthly" },
    { path: "/whitepaper", priority: 0.8, changeFrequency: "monthly" },
    { path: "/faq", priority: 0.7, changeFrequency: "monthly" },
    { path: "/security", priority: 0.8, changeFrequency: "weekly" },
    { path: "/stats", priority: 0.6, changeFrequency: "daily" },
    { path: "/business", priority: 0.7, changeFrequency: "monthly" },
    { path: "/business/pricing", priority: 0.7, changeFrequency: "monthly" },
    { path: "/business/roadmap", priority: 0.6, changeFrequency: "monthly" },
    { path: "/business/download", priority: 0.5, changeFrequency: "monthly" },
    { path: "/download", priority: 0.6, changeFrequency: "monthly" },
    { path: "/changelog", priority: 0.6, changeFrequency: "weekly" },
    { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
    { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
  ];

  return routes.map((route) => ({
    url: `${BASE_URL}${route.path}`,
    lastModified: now,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
