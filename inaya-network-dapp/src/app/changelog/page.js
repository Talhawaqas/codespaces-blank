// app/changelog/page.js
//
// Real, indexable changelog — SEO plan Phase 05 ("Ongoing Content
// Engine"): Google rewards sites that keep publishing, and Inaya ships
// constantly but that momentum was previously changelog-only, invisible
// to search. Entries below are real shipped features, not placeholders —
// drawn from the actual roadmapPhases content already on the site.

export const metadata = {
  title: "Changelog — Inaya Network",
  description: "What's shipped on Inaya Network — the storage protocol, Business Workspace, Security Layer, Inaya Learn, and the desktop and mobile apps.",
};

const entries = [
  {
    group: "Security Layer",
    items: [
      "Inaya Firewall public transparency page — check any domain or IP against the network's decentralized threat intelligence, no wallet required.",
      "4 smart contracts deployed & verified on BSC Testnet: Threat Registry, Threat Reporter, Node Reputation, Security Policy.",
      "AI Security Assistant — grounded in real network data, answers questions about threats and how confirmation works.",
    ],
  },
  {
    group: "Inaya Learn",
    items: [
      "Curated Web3, AI, and programming video library with category browsing and search.",
      "Built-in AI tutor for every video — ask questions grounded in the video's own content.",
      "Progress tracking, saved videos, and continue-watching across web and mobile.",
    ],
  },
  {
    group: "Investor Data Room",
    items: [
      "NDA-gated, email-verified document viewing with per-visitor engagement tracking.",
    ],
  },
  {
    group: "Business Workspace",
    items: [
      "Full document lifecycle: Company → Department → Project → Document hierarchy with role-based permissions.",
      "Server-enforced approval workflows and a complete document activity audit trail.",
      "Secure external sharing with revocable, expiring links.",
      "Permission-aware AI Business Assistant.",
      "Google Sign-In alongside magic-link email authentication.",
      "Native mobile app support with biometric app lock and secure encrypted token storage.",
    ],
  },
  {
    group: "Core Protocol",
    items: [
      "Client-side AES-256-GCM encryption with PBKDF2 key derivation, binary sharding before any data leaves the browser.",
      "InayaNodeRegistry, InayaProofRegistry, RevenueRouter, and InayaCorporateEscrow live on BSC Testnet.",
      "Pay-As-You-Go and Corporate Reserve annual storage plans.",
      "Staking with 0/30/90-day lock tiers at 1.00x/1.25x/1.50x reward multipliers.",
      "Genesis Airdrop and KYC-verified referral program.",
    ],
  },
  {
    group: "Desktop & Mobile",
    items: [
      "Native desktop apps for Windows and Linux — both the core dApp and Business Workspace, with system-tray integration and auto-updates.",
      "Android mobile app (alpha) — Faucet, Sovereign Vault, Staking, Genesis Airdrop, Referrals, Business Workspace, Security, and Learn, all in one app.",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-16 md:px-10 overflow-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px]" />
      </div>

      <div className="relative max-w-3xl mx-auto">
        <a href="/" className="inline-flex items-center gap-2 text-[#8a96ab] hover:text-[#00f2fe] text-xs font-mono mb-8 transition-colors">
          ← Back to Inaya Network
        </a>

        <span className="inline-block text-[10px] font-mono font-bold tracking-widest text-[#00f2fe] bg-cyan-500/10 border border-[#00f2fe]/30 rounded-full px-3 py-1 mb-4">
          CHANGELOG
        </span>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">What's Shipped</h1>
        <p className="text-[#8a96ab] text-sm mb-10">BNB Chain Testnet · updated as features ship</p>

        <div className="space-y-8">
          {entries.map((e) => (
            <section key={e.group}>
              <h2 className="text-lg font-bold text-white mb-3">{e.group}</h2>
              <ul className="space-y-2">
                {e.items.map((item) => (
                  <li key={item} className="text-[#94a3b8] text-sm leading-relaxed flex gap-2 bg-[#090d16]/60 border border-white/5 rounded-lg p-3.5">
                    <span className="text-[#00f2fe] shrink-0">✓</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
