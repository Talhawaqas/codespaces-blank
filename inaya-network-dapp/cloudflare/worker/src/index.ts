// Cloudflare Worker skeleton — NOT deployed, NOT connected to a real
// account or route. Scaffolding only, per cloudflare-rollout-plan.md Gate
// C (optional, operator-approved, later). Committed so the design is
// reviewable before any real deployment ever happens.
//
// Rules this skeleton follows (cloudflare-risk-register.md #7 and the
// SOW's own Worker rules):
//   - Never reads or forwards any client-supplied header as if it were
//     verified identity. Auth stays entirely origin-side (the app's five
//     real auth mechanisms, documented in cloudflare-audit.md section 9).
//   - Only does hostname allowlisting and a static-path cache decision --
//     never touches request/response bodies, never logs them.
//   - Default-deny: anything not explicitly matched is passed straight
//     through to the origin, unmodified, uncached.

const ALLOWED_HOST = "www.inayanetwork.com";

// Mirrors docs/architecture/cloudflare-data-classification.md's static,
// cacheable allowlist. Anything NOT matching one of these falls through
// to a plain pass-through fetch with no caching -- this must stay an
// allowlist, never a denylist (cloudflare-risk-register.md risk #5).
const CACHEABLE_PATH_PREFIXES = ["/downloads/", "/_next/static/"];

function isCacheablePath(pathname: string): boolean {
  return CACHEABLE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Hostname allowlist: refuse to proxy anything but the known app
    // host. Prevents this Worker ever being reachable as an open proxy
    // for an unrelated origin if it's ever misrouted.
    if (url.hostname !== ALLOWED_HOST) {
      return new Response("Not found", { status: 404 });
    }

    if (!isCacheablePath(url.pathname)) {
      // Pass through untouched -- no header injection, no body read.
      return fetch(request);
    }

    // Static asset: let Cloudflare's own cache (configured via
    // cloudflare/cache-rules.md, not this Worker) serve/populate as
    // normal. This Worker does not implement its own cache logic --
    // Cache Rules already cover this case; this branch exists only to
    // document the intent and to be a safe no-op pass-through today.
    return fetch(request);
  },
};
