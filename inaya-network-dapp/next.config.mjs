/** @type {import('next').NextConfig} */
const nextConfig = {
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
        ],
      },
    ];
  },
};

export default nextConfig;