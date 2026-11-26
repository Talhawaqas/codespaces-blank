// src/middleware.js
//
// GCS Compatibility Extension SOW, Phase 3 -- virtual-hosted bucket
// addressing (https://<bucket>.<base-host>/<object>), implemented as a
// pure URL rewrite, not a change to the S3-compat routes/auth themselves.
// "The server must safely derive the bucket from the hostname and feed it
// into the existing internal object model" (SOW §5) is exactly what this
// does: a matching request is rewritten to the same path-style URL
// (/api/s3/<bucket>/<key-and-query>) the existing, already-tested
// [bucket]/[...key] routes already handle -- auth.js's deriveRequestTarget
// never looks at Host, so every existing test/behavior for the path-style
// surface is unchanged and this is the ONLY new code virtual-hosted
// addressing required.
//
// S3_COMPAT_VIRTUAL_HOST_BASE configures the base host (e.g.
// "s3.inayanetwork.com", so a request to "mybucket.s3.inayanetwork.com"
// resolves bucket "mybucket"). Unset by default -- virtual-hosted
// addressing is inert until an operator actually points a wildcard DNS
// record at this deployment and sets this variable; no behavior changes
// for anyone not using it. This file makes NO DNS/TLS changes itself (SOW
// §5's own "do not make uncontrolled production DNS changes") -- the
// wildcard record and certificate coverage are a deployment-time decision,
// documented in docs/gcs-virtual-hosted-addressing.md, not something this
// code provisions on its own.

import { NextResponse } from "next/server";

const BASE_HOST = process.env.S3_COMPAT_VIRTUAL_HOST_BASE || "";

// A bucket name may contain lowercase letters, digits, dots, and hyphens
// (real S3 bucket-naming rules) -- reject anything else outright rather
// than feed an attacker-controlled Host header substring into routing.
const VALID_BUCKET_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// AzCopy (found by running the real tool against this endpoint) treats everything after the host as one container name and sends it as a
// percent-encoded blob name: "/api/azure%2F<container>%2F<blob>" (it reads "api" as the container). Without this, every AzCopy request to /api/azure/... is a 404.
// Only that exact leading shape is rewritten, back to the normal path; the Azure routes and SAS verification are untouched.
const AZCOPY_ENCODED_BASE = /^\/api(\/|%2F)azure%2F/i;

export async function middleware(req) {
  const rawPath = new URL(req.url).pathname;
  if (AZCOPY_ENCODED_BASE.test(rawPath)) {
    const url = req.nextUrl.clone();
    url.pathname = rawPath.replace(/%2F/gi, "/");
    return NextResponse.rewrite(url);
  }
  // Host-based Azure addressing (what AzCopy and the Azure SDKs expect: https://<host>/<container>/<blob>). On the one dedicated host named by
  // AZURE_COMPAT_HOST_BASE every path is an Azure path, rewritten to the existing /api/azure routes. Inert unless the operator sets it and
  // points DNS/TLS at this deployment; the same-origin app routes on every other host are untouched.
  const azureBase = (process.env.AZURE_COMPAT_HOST_BASE || "").toLowerCase().split(":")[0];
  if (azureBase && (req.headers.get("host") || "").toLowerCase().split(":")[0] === azureBase && !rawPath.startsWith("/api/") && !rawPath.startsWith("/_next/")) {
    const url = req.nextUrl.clone();
    url.pathname = `/api/azure${rawPath === "/" ? "" : rawPath}`;
    return NextResponse.rewrite(url);
  }
  // Online stores (Commerce Phase 5): "<slug>.<STORE_HOST_BASE>" and, when ONLINE_STORE_CUSTOM_DOMAINS=1, a shop's own verified
  // domain are served by the storefront pages. Inert unless the operator sets them; Inaya's own hosts are never rewritten, and
  // /api and /_next pass through untouched (the storefront calls /api/shop/<slug>/... on the same origin).
  // Business OS custom domains (Business and Enterprise; src/lib/branding/branding.js): on a company's verified host the whole app is
  // served as-is and "/" opens the company's sign-in. Only unknown hosts are looked up (cached), never Inaya's own hosts.
  const ws = await workspaceHostRewrite(req, rawPath, azureBase);
  if (ws) return ws;
  const storeRewrite = storefrontRewrite(req, rawPath);
  if (storeRewrite) return storeRewrite;
  if (!BASE_HOST) return NextResponse.next();

  // Host header includes the port (e.g. "bucket.example.com:3000") for any
  // non-default port -- strip it before matching, or a real dev/staging
  // deployment on a custom port would never match at all.
  const host = (req.headers.get("host") || "").toLowerCase().split(":")[0];
  const suffix = `.${BASE_HOST.toLowerCase().split(":")[0]}`;
  if (!host.endsWith(suffix)) return NextResponse.next();

  const bucket = host.slice(0, -suffix.length);
  // Reject anything but a single, valid bucket label -- a multi-level
  // subdomain ("a.b.<base>") or an invalid character is refused rather
  // than silently truncated or passed through, closing off host-header
  // confusion/traversal attempts (SOW §5 Security).
  if (!bucket || bucket.includes(".") || !VALID_BUCKET_LABEL.test(bucket)) {
    return new NextResponse("Invalid bucket hostname.", { status: 400 });
  }

  const url = req.nextUrl.clone();
  // Never rewrite the app's own real routes (business console, admin,
  // auth, etc.) into the S3 surface -- virtual-hosted addressing only
  // ever targets the object API, and only when the Host header actually
  // matches a bucket subdomain of the configured base (already confirmed
  // above), so this can't be tricked into rewriting a legitimate
  // same-Host request to those routes.
  url.pathname = `/api/s3/${bucket}${url.pathname}`;
  return NextResponse.rewrite(url);
}

const STORE_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
const OWN_HOST = /(^|\.)inayanetwork\.com$|\.vercel\.app$|^localhost$|^127\.0\.0\.1$|^\[::1\]$/;
const wsCache = new Map();
async function workspaceHostRewrite(req, rawPath, azureBase) {
  if (rawPath.startsWith("/api/") || rawPath.startsWith("/_next/")) return null;
  const host = (req.headers.get("host") || "").toLowerCase().split(":")[0];
  if (!host || OWN_HOST.test(host) || host === azureBase || !/^[a-z0-9.-]+$/.test(host)) return null;
  const s3 = BASE_HOST.toLowerCase().split(":")[0]; const store = (process.env.STORE_HOST_BASE || "").toLowerCase().split(":")[0];
  if ((s3 && host.endsWith("." + s3)) || (store && (host === store || host.endsWith("." + store)))) return null;
  let hit = wsCache.get(host);
  if (!hit || Date.now() - hit.at > 5 * 60 * 1000) {
    let workspace = false;
    try { const r = await fetch(new URL(`/api/public/workspace-domain?host=${encodeURIComponent(host)}`, req.url), { signal: AbortSignal.timeout(3000) }); if (r.ok) workspace = (await r.json()).workspace === true; } catch { workspace = false; }
    hit = { at: Date.now(), workspace }; wsCache.set(host, hit);
  }
  if (!hit.workspace) return null;
  if (rawPath === "/") { const url = req.nextUrl.clone(); url.pathname = "/business"; return NextResponse.rewrite(url); }
  return NextResponse.next();
}

function storefrontRewrite(req, rawPath) {
  const seo = rawPath.match(/^\/shop\/([a-z0-9-]+)\/(sitemap\.xml|robots\.txt)$/);
  if (seo && STORE_SLUG.test(seo[1])) { const u = req.nextUrl.clone(); u.pathname = `/api/shop/${seo[1]}/${seo[2]}`; return NextResponse.rewrite(u); }
  if (rawPath.startsWith("/api/") || rawPath.startsWith("/_next/") || rawPath.startsWith("/shop/")) return null;
  const host = (req.headers.get("host") || "").toLowerCase().split(":")[0];
  const base = (process.env.STORE_HOST_BASE || "").toLowerCase().split(":")[0];
  const url = req.nextUrl.clone(); const tail = rawPath === "/" ? "" : rawPath;
  if (base && host.endsWith(`.${base}`)) {
    const slug = host.slice(0, -(base.length + 1));
    if (!STORE_SLUG.test(slug)) return new NextResponse("Store not found.", { status: 404 });
    url.pathname = tail === "/sitemap.xml" || tail === "/robots.txt" ? `/api/shop/${slug}${tail}` : `/shop/${slug}${tail}`; return NextResponse.rewrite(url);
  }
  if (process.env.ONLINE_STORE_CUSTOM_DOMAINS === "1" && host && !OWN_HOST.test(host) && host !== base && !(BASE_HOST && host.endsWith("." + BASE_HOST.toLowerCase().split(":")[0])) && /^[a-z0-9.-]+$/.test(host)) {
    url.pathname = tail === "/sitemap.xml" || tail === "/robots.txt" ? `/api/shop/_host${tail}` : `/shop/_host/${host}${tail}`; return NextResponse.rewrite(url);
  }
  return null;
}

export const config = {
  // Skip Next.js internals and static assets -- there is no legitimate
  // virtual-hosted S3 request for those paths, and rewriting them would
  // only risk breaking the app's own asset serving for anyone who ever
  // sets S3_COMPAT_VIRTUAL_HOST_BASE to a host that also happens to serve
  // the main app (not the recommended setup, but defense in depth).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
