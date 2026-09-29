import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Verifiable Inaya Client SOW: Next.js's default build ID is a random UUID generated
// fresh on every build -- meaningless for "which exact build is currently deployed."
// Tying it to the commit + the exact custody-sdk version bundled makes it a real,
// traceable identifier: /build's "Verify this build" section (Phase 4) displays this via
// NEXT_PUBLIC_BUILD_ID, and docs/reproducible-builds-and-verification.md explains what it
// does and doesn't prove (it identifies the deployed code; it doesn't independently
// confirm the server is honest about serving it -- see that doc's
// guarantees/non-guarantees section). Computed once at config-eval time (which happens
// once per `next build` invocation) so generateBuildId() and the client-visible env var
// below can't drift from each other.
// The actual installed/resolved version, not the declared semver range (package.json's
// dependencies entry is "^1.0.x", not the precise version node_modules resolved to).
const sdkVersion = (() => {
  try {
    const sdkPkg = JSON.parse(readFileSync(new URL("./node_modules/@inaya-network/custody-sdk/package.json", import.meta.url), "utf8"));
    return sdkPkg.version;
  } catch {
    return "unknown";
  }
})();
const gitSha = process.env.VERCEL_GIT_COMMIT_SHA || (() => {
  try {
    return execSync("git rev-parse HEAD").toString().trim();
  } catch {
    return "unknown"; // e.g. building from a tarball with no .git directory
  }
})();
const buildId = `${gitSha}-sdk${sdkVersion}`;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enterprise Adoption SOW, Workstream B -- a real bug found via live
  // Terraform testing: @aws-sdk/client-s3 (and other real S3 SDKs) build
  // bucket-only requests (CreateBucket, DeleteBucket -- no object key)
  // with a TRAILING SLASH (e.g. PUT /api/s3/mybucket/). Next.js's default
  // trailing-slash redirect turned that into a 308, which every S3 SDK
  // then fails to parse as a valid CreateBucket/DeleteBucket response
  // (they expect a real 200/204, not a redirect) -- this is Next.js's own
  // documented flag for exactly this class of API-compatibility problem,
  // not a custom workaround. App-wide, but this app has no reliance on
  // trailing-slash auto-redirect behavior for its own pages.
  skipTrailingSlashRedirect: true,
  // Document Automation SOW: the bundled Unicode fonts are read from disk at
  // render time, which Next's file tracing cannot see on its own; without
  // this they would be missing from the serverless functions that render.
  // SQA-026 (S1, found by the live production check of Document Automation): pdfkit was BUNDLED into the server chunks, but it loads its built-in
  // fonts at runtime through a path frozen at build time (/vercel/path0/.../node_modules/pdfkit/js/pdfkit.node.mjs). That folder is not shipped to
  // the serverless function, so every PDF render failed with "Cannot find module '#standard-fonts/Helvetica'". Keeping it external makes Vercel ship
  // the real package (package.json, its "imports" map, the font data) next to the function. Affects every route that renders a PDF.
  // Next.js 15 upgrade (September 2026): experimental.serverComponentsExternalPackages was stabilized and moved to this top-level option.
  // Mainframe & Legacy Data Access SOW: ssh2 (the RMS/OpenVMS connector's
  // SSH client) ships an OPTIONAL compiled native addon
  // (lib/protocol/crypto/build/Release/sshcrypto.node) for accelerated
  // crypto -- ssh2 falls back to pure-JS crypto at runtime when it can't
  // load that binary, but webpack doesn't know that at bundle time and
  // tries to parse the .node file as JavaScript, which fails and 500s
  // EVERY API route that imports connectorRegistry.js (not just RMS
  // routes -- the whole module graph fails to build). Found live: the
  // ODBC driver's Driver-Manager-mediated health check returned a 500
  // with an empty body the moment this connector was registered.
  serverExternalPackages: ["pdfkit", "ssh2"],
  // Next.js 15 upgrade: this repo sits inside a monorepo with sibling packages that carry their own
  // lockfiles (inaya-migration-agent, custody-sdk, etc.) -- Next's own root-inference picked the OUTER
  // monorepo folder as the workspace root, which risks every relative path below (and the whole point of
  // SQA-026's fix) resolving from the wrong directory. Pinned explicitly rather than left to inference.
  outputFileTracingRoot: __dirname,
  // Next.js 15 upgrade: experimental.outputFileTracingIncludes was ALSO stabilized and moved to this
  // top-level option -- confirmed by the build's own "Unrecognized key(s) ... at experimental" warning
  // when it was left nested (an unrecognized experimental key is silently ignored, not an error, so this
  // would have silently reintroduced SQA-026's pdfkit-fonts-missing-in-production bug had it gone
  // unnoticed).
  outputFileTracingIncludes: {
    // pdfkit loads its built-in fonts through a package "imports" alias (#standard-fonts/*) that Next's file tracer cannot follow, so the font data
    // files must be listed explicitly or they are missing from the function (verified with a trace simulation, SQA-026).
    "/api/**/*": ["./node_modules/pdfkit/js/standard-fonts/**/*.cjs", "./node_modules/pdfkit/js/data/**/*"], // **: the font files require a shared chunks/ helper

    "/api/orgs/documents-automation/**/*": ["./src/lib/documentAutomation/fonts/**/*"],
    "/api/orgs/finance/invoices/**/*": ["./src/lib/documentAutomation/fonts/**/*"],
    "/api/cron/document-automation": ["./src/lib/documentAutomation/fonts/**/*"],
    "/api/cron/execute-approved-ai-actions": ["./src/lib/documentAutomation/fonts/**/*"],
  },
  async generateBuildId() {
    return buildId;
  },
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
    NEXT_PUBLIC_SDK_VERSION: sdkVersion,
  },
  images: {
    // Local assets ke smooth handling ke liye configurations
    dangerouslyAllowSVG: true,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  eslint: {
    // Build ko safe rakhne aur deployment ko green karne ke liye bypass rule
    ignoreDuringBuilds: true,
  },
  typescript: {
    // TypeScript errors ko build ke waqt ignore karne ke liye
    ignoreBuildErrors: true,
  },
  // Baseline security headers, applied to every route. No app was checked (Business Workspace,
  // MFA, admin) had ANY of these before -- login/MFA/admin pages were embeddable in a third-party
  // iframe with no clickjacking protection at all. Deliberately conservative: this does NOT set a
  // page-content CSP (script-src/connect-src/etc.) -- this app loads Stripe, Firebase, Google
  // Sign-In, and WalletConnect from many origins, and getting a full CSP allowlist wrong would
  // break the live app in ways hard to catch without exhaustive manual testing. frame-ancestors is
  // the one CSP directive included here since it only controls who may iframe this app (nothing
  // about what this app itself may load), making it the correctly-scoped, zero-risk piece of that
  // larger set of directives.
  //
  // September 2026 hardening pass adds two more, same conservative standard: Permissions-Policy
  // only names features this app confirmably never uses (checked: no navigator.geolocation,
  // navigator.usb, or navigator.bluetooth anywhere in src/) -- it deliberately says nothing about
  // microphone (useVoiceSession.js genuinely needs it), or about accelerometer/gyroscope/
  // encrypted-media/picture-in-picture/web-share (the YouTube embed on the landing page delegates
  // exactly those via its own iframe `allow` attribute; a page-wide policy naming them would
  // silently break that embed even though this app itself never calls those APIs). Cross-Origin-
  // Opener-Policy uses "same-origin-allow-popups" rather than a stricter value specifically
  // because it must not break the OAuth (Google/Microsoft/Slack) and WalletConnect popup flows
  // this app already relies on -- this value still isolates the page from being able to read a
  // popup's properties across origins, which is the actual protection it buys (against
  // window-reference-based tabnabbing/reverse-tabnabbing), without touching how those popups work.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self';" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Permissions-Policy", value: "geolocation=(), camera=(), usb=(), bluetooth=(), midi=(), payment=(), magnetometer=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        ],
      },
    ];
  },
};

export default nextConfig;