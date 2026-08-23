// app/robots.js
//
// Native Next.js App Router robots convention — served automatically at
// /robots.txt. Blocks admin dashboards, the auth callback route, API
// routes, and private per-recipient share links; points crawlers at the
// sitemap.

const BASE_URL = "https://www.inayanetwork.com";

export default function robots() {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/oauth2redirect", "/api/", "/business/share/"],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
