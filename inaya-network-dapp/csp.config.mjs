// csp.config.mjs -- the site-wide Content-Security-Policy (SQA 17 Nov 2026), used by next.config.mjs headers().
//
// Before this, the only CSP was "frame-ancestors 'self'". This policy was built from an inventory of every outside
// origin the browser loads, then verified by crawling every Business Workspace module (desktop and phone) and the
// public pages in a production build with zero CSP violations (scripts/sqa/crawl-workspace.mjs records them).
//
// What it locks down:
//   - script-src: only this site plus the named script hosts (Google sign-in, Firebase phone check / reCAPTCHA,
//     Vercel analytics). An injected <script src="https://evil.example/..."> is refused. 'unsafe-inline' stays
//     because Next.js App Router emits inline bootstrap scripts on statically rendered pages (a nonce would force
//     every page to render dynamically); 'wasm-unsafe-eval' is for the WebAssembly crypto. No 'unsafe-eval' in
//     production.
//   - object-src 'none' (no plugins), base-uri 'self' (no <base> hijack), frame-ancestors (no clickjacking),
//     form-action (forms post only to this site or https), upgrade-insecure-requests on the deployed site.
// What it deliberately leaves broad, and why:
//   - connect-src https: wss: -- wallets talk to many chain RPCs, WalletConnect relays, IPFS gateways and the Gemini
//     Live socket; a fixed list would break wallet features whenever a user picks another network. Plain http:/ws:
//     are still refused (except this site itself in local development).
//   - img-src / media-src https: -- NFT images, avatars and logos come from user-chosen hosts.
//   - frame-src https: -- App Store listings embed the developer's own https site (sandboxed iframe).

const isDev = process.env.NODE_ENV !== "production";
// Only the deployed site is guaranteed to be HTTPS; a local production build (npm run start:testdb) is plain http.
const isDeployed = !!process.env.VERCEL;

const SCRIPT_HOSTS = [
  "https://accounts.google.com", // Google sign-in (gsi/client)
  "https://apis.google.com", // Firebase auth helpers
  "https://www.google.com", // reCAPTCHA (Firebase phone check)
  "https://www.gstatic.com", // reCAPTCHA / Firebase assets
  "https://va.vercel-scripts.com", // Vercel Analytics / Speed Insights outside the /_vercel proxy
];

/** @param {{ frameAncestors?: string[], extraScriptHosts?: string[] }} [opts] */
export function buildContentSecurityPolicy({ frameAncestors = ["'self'"], extraScriptHosts = [] } = {}) {
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", ...(isDev ? ["'unsafe-eval'"] : []), ...SCRIPT_HOSTS, ...extraScriptHosts],
    "style-src": ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://fonts.googleapis.com"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    "media-src": ["'self'", "data:", "blob:", "https:"],
    "connect-src": ["'self'", "data:", "blob:", "https:", "wss:", ...(isDev ? ["ws:", "http://localhost:*", "http://127.0.0.1:*"] : [])],
    "frame-src": ["'self'", "data:", "blob:", "https:"],
    "worker-src": ["'self'", "blob:"],
    "child-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'", "https:"],
    "frame-ancestors": frameAncestors,
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (isDeployed) parts.push("upgrade-insecure-requests");
  return parts.join("; ") + ";";
}
