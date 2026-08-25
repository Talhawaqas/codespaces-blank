// app/privacy/page.js
//
// Plain server component — static content, nothing to fetch or react to.
// Grounded in the actual data flows this codebase implements (Didit for
// KYC, Stripe for payments, MongoDB for app data, Pinata/IPFS for file
// storage, Vercel Analytics/Speed Insights, Google Sign-In for Business
// Workspace) rather than generic boilerplate. This is a solid founding
// draft — recommend legal review before treating it as final/binding,
// same as any early-stage product's first policy.

export const metadata = {
  title: "Privacy Policy — Inaya Network",
  description: "How Inaya Network collects, uses, and protects data across the dApp, Business Workspace, and mobile app.",
};

const sections = [
  {
    title: "1. What Inaya Network is architected to never see",
    body: "Files uploaded through the Sovereign Vault are encrypted (AES-256-GCM) and sharded entirely inside your own browser or device, using a key derived from your own passkey (PBKDF2), before anything ever reaches our servers or the storage network. Inaya Network does not hold your passkey, cannot recover it if lost, and cannot decrypt a complete copy of your file — this is an architectural guarantee, not a policy promise.",
  },
  {
    title: "2. Information we do collect",
    body: null,
    list: [
      "Wallet address, once you connect a wallet — used as your identity for on-chain features (staking, referrals, Genesis Airdrop, node registration).",
      "Identity verification data submitted during KYC, processed by our third-party verification provider, Didit — used to activate referral rewards and prevent Sybil abuse of reward programs.",
      "Email address, for Business Workspace accounts (magic-link sign-in or Google Sign-In), referral program activation, and Investor Data Room access requests.",
      "Encrypted file metadata (filename, size, shard locations, timestamps) — never the decrypted file contents.",
      "Payment information, processed entirely by Stripe for Business Workspace subscriptions and Corporate Reserve storage plans — Inaya Network never receives or stores your card details directly.",
      "Basic usage and performance data via Vercel Analytics and Speed Insights — page views, load performance, and general usage patterns, not tied to file contents.",
    ],
  },
  {
    title: "3. How we use it",
    body: "To operate the features you use directly — wallet-based rewards, KYC-gated referral payouts, Business Workspace accounts and billing, and Investor Data Room access control — and to monitor and improve the reliability of the app. We do not sell personal data to third parties.",
  },
  {
    title: "4. Where data is stored",
    body: "Application data (accounts, referral records, KYC verification status, document metadata) is stored in MongoDB. Encrypted file shards are stored on Pinata's IPFS pinning service — as ciphertext, not plaintext. On-chain data (wallet addresses, transaction history, staking positions) is public by the nature of a blockchain and not something Inaya Network controls or can delete.",
  },
  {
    title: "5. Third-party processors",
    body: null,
    list: [
      "Didit — identity verification (KYC) for referral program activation.",
      "Stripe — payment processing for Business Workspace and Corporate Reserve purchases.",
      "Google — OAuth sign-in for Business Workspace accounts (optional; magic-link email sign-in is always available as an alternative).",
      "Pinata (IPFS) — encrypted file storage.",
      "Vercel — application hosting, analytics, and performance monitoring.",
      "MongoDB Atlas — application database hosting.",
    ],
  },
  {
    title: "6. Your rights",
    body: "You can request a copy of the personal data we hold about you, request its deletion (where it doesn't conflict with an immutable on-chain record or an active legal/financial obligation), and withdraw consent for optional features like KYC or Google Sign-In at any time. Contact us using the details below to exercise any of these.",
  },
  {
    title: "7. Testnet status",
    body: "Inaya Network is currently deployed on BNB Chain Testnet. No real funds are at risk from on-chain interactions during this phase, but the off-chain data practices described above (KYC, account data, payment processing for real products like Business Workspace) already apply in full.",
  },
  {
    title: "8. Changes to this policy",
    body: "We'll update this page as the product evolves, and material changes will be reflected in the \"last updated\" date below. Continued use of Inaya Network after an update constitutes acceptance of the revised policy.",
  },
  {
    title: "9. Contact",
    body: "Questions about this policy or your data: contact@inayanetwork.com. Support: support@inayanetwork.com.",
  },
];

export default function PrivacyPolicyPage() {
  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-16 md:px-10 overflow-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px]" />
        <div className="absolute bottom-0 right-0 w-96 h-96 rounded-full bg-[#c9a24d]/5 blur-[120px]" />
      </div>

      <div className="relative max-w-3xl mx-auto">
        <a href="/" className="inline-flex items-center gap-2 text-[#8a96ab] hover:text-[#00f2fe] text-xs font-mono mb-8 transition-colors">
          ← Back to Inaya Network
        </a>

        <span className="inline-block text-[10px] font-mono font-bold tracking-widest text-[#00f2fe] bg-cyan-500/10 border border-[#00f2fe]/30 rounded-full px-3 py-1 mb-4">
          LEGAL
        </span>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Privacy Policy</h1>
        <p className="text-[#8a96ab] text-xs font-mono mb-10">Last updated: August 2026</p>

        <div className="space-y-8">
          {sections.map((s) => (
            <div key={s.title} className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
              <h2 className="text-white font-bold text-base mb-3">{s.title}</h2>
              {s.body && <p className="text-[#94a3b8] text-sm leading-relaxed">{s.body}</p>}
              {s.list && (
                <ul className="space-y-2 mt-1">
                  {s.list.map((item) => (
                    <li key={item} className="text-[#94a3b8] text-sm leading-relaxed flex gap-2">
                      <span className="text-[#00f2fe] shrink-0">▸</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        <p className="text-[#8a96ab] text-xs mt-10">
          See also our <a href="/terms" className="text-[#00f2fe] hover:underline">Terms of Service</a>.
        </p>
      </div>
    </div>
  );
}
