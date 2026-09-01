// app/apps/page.js
//
// Web3 App Store — a curated directory of Inaya's OWN real, shipped
// applications, plus community-submitted apps that have passed admin
// review (see appStoreListings.js's header for the full security model:
// wallet-signed submission, a live Security Layer threat check both at
// submission and review time, and nothing goes public without an admin
// approving it — Options A/IPFS and B/sandboxed-iframe only, Option C
// same-origin hosting and Option D unvetted-registry were both rejected).
//
// "Independently verifiable" instead of a fabricated trust score for
// Inaya's own apps: each entry links to the SAME real, on-chain,
// publicly-checkable contract data the app's own page already shows.
// Community apps get an explicit "Community" badge and a disclaimer
// instead — they're reviewed for a known-threat check, not vouched for
// the way Inaya's own apps are.
//
// Server component — fetches approved community listings directly
// (listApprovedListings(), the exact same function the admin queue and
// the embed page use) rather than a client round trip.

import { listApprovedListings } from "../../lib/appStoreListings";

// Without this, Next.js statically prerenders this page at BUILD time
// (it has no dynamic route param the way /apps/embed/[slug] does to force
// the issue automatically) — a newly approved community listing would
// never appear until the next deploy. Caught during verification.
export const dynamic = "force-dynamic";

const CATEGORY_COLORS = {
  Storage: "#00f2fe",
  Business: "#c084fc",
  Bridge: "#34d399",
  Security: "#f87171",
  Network: "#facc15",
  DeFi: "#34d399",
  Social: "#c084fc",
  Gaming: "#f472b6",
  Tools: "#facc15",
  Other: "#94a3b8",
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

function AppCard({ icon, category, name, description, verify, href, external }) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="group bg-[#0a0f1e] border border-white/10 rounded-xl p-5 hover:-translate-y-0.5 hover:border-white/20 transition-all flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-2xl">{icon}</span>
        <span
          className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border"
          style={{ color: CATEGORY_COLORS[category] || CATEGORY_COLORS.Other, borderColor: `${CATEGORY_COLORS[category] || CATEGORY_COLORS.Other}4D`, backgroundColor: `${CATEGORY_COLORS[category] || CATEGORY_COLORS.Other}1A` }}
        >
          {category}
        </span>
      </div>
      <div>
        <h2 className="text-white font-bold text-base group-hover:text-[#00f2fe] transition-colors">{name}</h2>
        <p className="text-[#94a3b8] text-[13px] leading-relaxed mt-1.5">{description}</p>
      </div>
      <p className="text-[#5b6472] text-[11px] leading-relaxed border-t border-white/5 pt-3 mt-auto">
        {verify}
      </p>
      <span className="text-[#00f2fe] text-xs font-bold flex items-center gap-1">
        {external ? "Launch app (opens IPFS gateway)" : "Launch app"} <span className="group-hover:translate-x-0.5 transition-transform">→</span>
      </span>
    </a>
  );
}

export default async function AppsPage() {
  const community = await listApprovedListings().catch(() => []);

  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-12 md:px-10 overflow-hidden">
      <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px] pointer-events-none" />

      <div className="relative max-w-5xl mx-auto">
        <a href="/" className="text-[#8a96ab] text-sm hover:text-[#00f2fe] transition-colors">← Inaya Network</a>

        <div className="mt-6 mb-8 flex items-start justify-between flex-wrap gap-4">
          <div>
            <span className="text-[11px] font-bold tracking-wider text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/30 rounded-full px-2 py-0.5">
              WEB3 APP STORE
            </span>
            <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mt-3 mb-3">Inaya App Store</h1>
            <p className="text-[#94a3b8] text-sm max-w-2xl leading-relaxed">
              Inaya&apos;s own real, shipped applications, plus community apps that passed admin review.
              Every app links to how you can independently verify what it claims — the same
              &quot;verify, don&apos;t trust our word&quot; standard every technical doc in this project holds to.
            </p>
          </div>
          <a href="/apps/submit" className="shrink-0 text-xs font-bold uppercase px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors">
            + Submit Your App
          </a>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          {APPS.map((app) => <AppCard key={app.key} {...app} verify={<><span className="text-emerald-400 font-bold">✓ Verifiable — </span>{app.verify}</>} />)}
        </div>

        {community.length > 0 && (
          <div className="mt-12">
            <h2 className="text-white font-bold text-lg mb-1">Community Apps</h2>
            <p className="text-[#5b6472] text-xs mb-5">
              Submitted by their own developers, admin-reviewed and checked against Inaya&apos;s Security
              Layer threat registry before listing — not built or run by Inaya. Verify you trust an app
              before connecting a wallet inside it.
            </p>
            <div className="grid sm:grid-cols-2 gap-4">
              {community.map((c) => (
                <AppCard
                  key={c.slug}
                  icon="🧩"
                  category={c.category}
                  name={c.name}
                  description={c.description}
                  verify={<><span className="text-[#00f2fe] font-bold">Community — </span>reviewed and checked against Inaya&apos;s live threat registry before listing; hosted and run by its own developer.</>}
                  href={c.hostType === "ipfs" ? `https://gateway.pinata.cloud/ipfs/${c.cid}` : `/apps/embed/${c.slug}`}
                  external={c.hostType === "ipfs"}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
