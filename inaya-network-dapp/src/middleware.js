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

export function middleware(req) {
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

export const config = {
  // Skip Next.js internals and static assets -- there is no legitimate
  // virtual-hosted S3 request for those paths, and rewriting them would
  // only risk breaking the app's own asset serving for anyone who ever
  // sets S3_COMPAT_VIRTUAL_HOST_BASE to a host that also happens to serve
  // the main app (not the recommended setup, but defense in depth).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
