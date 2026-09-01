"use client";

// app/apps/page.js
//
// Web3 App Store — a curated directory of Inaya's OWN real, shipped
// applications. Not a third-party marketplace: there is no submission,
// review, or sandboxing system for arbitrary outside dApps in this
// codebase, and building one is a materially bigger, separate undertaking
// (a real trust/security model for running someone else's code). Scoped
// down deliberately to what's real today.
//
// "Independently verifiable" instead of a fabricated trust score: rather
// than inventing a security rating for Inaya's own apps, each entry links
// to the SAME real, on-chain, publicly-checkable contract data the app's
// own page already shows (e.g. the landing page's "Deployed Contracts"
// panel, testnet.bscscan.com links) — matching this codebase's "verify,
// don't trust our word" discipline elsewhere.

const CATEGORY_COLORS = {
  Storage: "#00f2fe",
  Business: "#c084fc",
  Bridge: "#34d399",
  Security: "#f87171",
  Network: "#facc15",
};

const APPS = [
  {
    key: "vault",
    name: "Storage & Custody Vault",
    icon: "🗄️",
    category: "Storage",
    href: "/",
    description: "Encrypt, shard, and anchor your files on-chain. Client-side AES-GCM-256 encryption — Inaya's servers never see your plaintext or your key.",
    verify: "Every anchored file's owner, shard CIDs, and timestamp is a public read on InayaCustody — see the Deployed Contracts panel on this app.",
  },
  {
    key: "nfts",
    name: "NFT Vault",
    icon: "🖼️",
    category: "Storage",
    href: "/nfts",
    description: "Discover the NFTs your connected wallet owns and back their metadata + image up to Inaya's own encrypted, redundant storage — independent of whatever gateway currently hosts them.",
    verify: "Backup eligibility is checked against the real on-chain ownerOf() of the NFT contract you point it at, not a claimed/self-reported owner.",
  },
  {
    key: "bridge",
    name: "Cross-Chain Bridge",
    icon: "🌉",
    category: "Bridge",
    href: "/bridge",
    description: "Move $INAYA natively across 8 chains — BSC, Ethereum, Avalanche, Arbitrum, Solana, Hedera, Aptos, and Sui — plus a parallel Wormhole route to 3 more.",
    verify: "Every route offered is a real, proven, on-chain transfer with a verified destination balance — see the bridge page's own \"Real, proven route\" markers.",
  },
  {
    key: "business",
    name: "Business Workspace",
    icon: "🏢",
    category: "Business",
    href: "/business",
    description: "Documents, CRM, procurement, finance, and HR, plus AI actions that are proposed and human-approved — never self-executed — and a cryptographic audit trail.",
    verify: "Every AI-guarded action and its approval is written to a tamper-evident hash chain you (or your org owner/admin) can independently verify and export.",
  },
  {
    key: "security",
    name: "Security Center",
    icon: "🛡️",
    category: "Security",
    href: "/security",
    description: "Check any address or destination against a decentralized, reputation-weighted threat registry. Free, public, no login required.",
    verify: "Threat confirmations are recorded on InayaThreatRegistry — a reputation-weighted confidence threshold gates anything before it's shown as confirmed.",
  },
  {
    key: "dataroom",
    name: "Data Room",
    icon: "🔒",
    category: "Business",
    href: "/dataroom",
    description: "An NDA-gated space for sharing sensitive documents with investors or partners, separate from day-to-day team storage.",
    verify: "Same client-side encryption as every other document in the Vault — access is explicitly granted, not implied by a link alone.",
  },
  {
    key: "stats",
    name: "Network Stats",
    icon: "📊",
    category: "Network",
    href: "/stats",
    description: "Live, public statistics for the Inaya network — storage, staking, and node activity, computed from what's actually readable on-chain.",
    verify: "Reports null rather than a fabricated figure for anything the deployed contracts genuinely don't expose — see the page's own honesty note.",
  },
  {
    key: "automation",
    name: "Oracle & Automation Status",
    icon: "⚙️",
    category: "Network",
    href: "/automation",
    description: "Real-time status of Inaya's on-chain oracle feeds and automated settlement/maintenance jobs.",
    verify: "Every job status shown is read from its own on-chain event log, not an internal dashboard claim.",
  },
];

export default function AppsPage() {
  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-12 md:px-10 overflow-hidden">
      <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px] pointer-events-none" />

      <div className="relative max-w-5xl mx-auto">
        <a href="/" className="text-[#8a96ab] text-sm hover:text-[#00f2fe] transition-colors">← Inaya Network</a>

        <div className="mt-6 mb-10">
          <span className="text-[11px] font-bold tracking-wider text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/30 rounded-full px-2 py-0.5">
            WEB3 APP STORE
          </span>
          <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mt-3 mb-3">Inaya App Store</h1>
          <p className="text-[#94a3b8] text-sm max-w-2xl leading-relaxed">
            A directory of Inaya&apos;s own real, shipped applications — not a marketplace for arbitrary
            third-party dApps. Every entry below is live today; none of this is a mockup or a roadmap
            promise. Each app links to how you can independently verify what it claims, the same
            &quot;verify, don&apos;t trust our word&quot; standard every technical doc in this project holds to.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          {APPS.map((app) => (
            <a
              key={app.key}
              href={app.href}
              className="group bg-[#0a0f1e] border border-white/10 rounded-xl p-5 hover:-translate-y-0.5 hover:border-white/20 transition-all flex flex-col gap-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-2xl">{app.icon}</span>
                <span
                  className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border"
                  style={{ color: CATEGORY_COLORS[app.category], borderColor: `${CATEGORY_COLORS[app.category]}4D`, backgroundColor: `${CATEGORY_COLORS[app.category]}1A` }}
                >
                  {app.category}
                </span>
              </div>
              <div>
                <h2 className="text-white font-bold text-base group-hover:text-[#00f2fe] transition-colors">{app.name}</h2>
                <p className="text-[#94a3b8] text-[13px] leading-relaxed mt-1.5">{app.description}</p>
              </div>
              <p className="text-[#5b6472] text-[11px] leading-relaxed border-t border-white/5 pt-3 mt-auto">
                <span className="text-emerald-400 font-bold">✓ Verifiable — </span>
                {app.verify}
              </p>
              <span className="text-[#00f2fe] text-xs font-bold flex items-center gap-1">
                Launch app <span className="group-hover:translate-x-0.5 transition-transform">→</span>
              </span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
