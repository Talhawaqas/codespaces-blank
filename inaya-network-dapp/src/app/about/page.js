// app/about/page.js
//
// Real, server-rendered, indexable About page — the SEO plan's core
// structural fix. The dApp's "About Us" tab (src/app/page.js) covers the
// same ground for connected-wallet users but only exists as client-side
// tab state on "/", which Google can't crawl or rank. This page is the
// content organic search visitors should actually land on. Content
// mirrors the dApp tab and the fundraising-docs pipeline (whitepaper.js,
// company-profile.js) — same facts, not invented separately.

export const metadata = {
  title: "About Inaya Network — Mission, Leadership & Roadmap",
  description: "Inaya Network is building sovereign data storage, business infrastructure, decentralized security, and AI into one ecosystem. Meet the team and see the roadmap.",
};

const leadership = [
  {
    name: "Talha Waqas",
    title: "Founder & CTO",
    bio: "Core system architect, smart contract architect, and lead Web3 full-stack engineer. Deep specialization in browser-layer cryptographic engineering, EVM smart contract architecture, and client-side encrypted storage protocols.",
  },
  {
    name: "Yakub Adnan",
    title: "Co-Founder & Growth Lead",
    bio: "Web3 growth operator and community strategist, specializing in DePIN, user acquisition, and AI-driven ecosystem scaling.",
  },
  {
    name: "Fibha Urooj",
    title: "Chief Financial Officer",
    bio: "B.Com in Accounting & Finance. Leads financial planning, budgeting, compliance, and operational finance.",
  },
];

const roadmap = [
  { phase: "Phase 01 — Deployment & Audit Proof", desc: "EVM contract deployment across BNB Chain scaling infrastructure, block-range scanning, and third-party security audits ahead of mainnet." },
  { phase: "Phase 02 — Incentivized Alpha & Sybil Resistance", desc: "Anti-sybil validation for edge-node operators, hardware identity verification, and active transaction-tracking pipelines." },
  { phase: "Phase 03 — TGE & Cross-Chain Expansion", desc: "Token Generation Event for $INAYA, cross-chain bridge deployment, and global expansion of the storage node network." },
];

const products = [
  { icon: "🔐", name: "Sovereign Storage", desc: "Client-side encryption, sharding, and decentralized custody — no single node ever holds a complete, readable copy of your data." },
  { icon: "🏢", name: "Business Workspace", desc: "Encrypted document management for companies — departments, projects, permissions, workflows, and secure sharing." },
  { icon: "🛡️", name: "Inaya Firewall", desc: "Decentralized threat intelligence, reputation-weighted node reporting, and on-chain confirmed threat records." },
  { icon: "🎓", name: "Inaya Learn", desc: "Web3, AI, and programming education with an integrated AI tutor for every video." },
  { icon: "📁", name: "Investor Data Room", desc: "NDA-gated, per-visitor-tracked document viewing for investors." },
  { icon: "🖥️", name: "Desktop & Mobile Apps", desc: "Native apps for Windows, Linux, and Android, running the full ecosystem outside the browser." },
];

const personJsonLd = leadership.map((p) => ({
  "@context": "https://schema.org",
  "@type": "Person",
  name: p.name,
  jobTitle: p.title,
  worksFor: { "@type": "Organization", name: "Inaya Network" },
}));

export default function AboutPage() {
  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-16 md:px-10 overflow-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px]" />
        <div className="absolute top-1/2 -right-24 w-96 h-96 rounded-full bg-[#c9a24d]/8 blur-[120px]" />
      </div>

      {personJsonLd.map((p, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(p) }} />
      ))}

      <div className="relative max-w-4xl mx-auto">
        <a href="/" className="inline-flex items-center gap-2 text-[#64748b] hover:text-[#00f2fe] text-xs font-mono mb-8 transition-colors">
          ← Back to Inaya Network
        </a>

        <span className="inline-block text-[10px] font-mono font-bold tracking-widest text-[#00f2fe] bg-cyan-500/10 border border-[#00f2fe]/30 rounded-full px-3 py-1 mb-4">
          ABOUT
        </span>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-4">About Inaya Network</h1>
        <p className="text-[#94a3b8] text-base leading-relaxed max-w-2xl mb-12">
          Inaya Network's primary objective is to re-establish absolute data sovereignty at the client-side execution layer. By eliminating institutional intermediaries and systemic runtime vectors, we empower edge-node operators with uncompromised asset management control — using client-side cryptographic sharding backed by PBKDF2 key derivation and AES-GCM encryption. Files are encrypted and split into independent fragments before they ever leave the browser; no single node, server, or administrator holds a complete, decryptable copy.
        </p>

        <section className="mb-14">
          <h2 className="text-xl font-bold text-white mb-5">The Ecosystem</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {products.map((p) => (
              <div key={p.name} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
                <span className="text-xl">{p.icon}</span>
                <div className="text-white font-bold text-sm mt-2">{p.name}</div>
                <p className="text-[#64748b] text-xs leading-relaxed mt-1">{p.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-14">
          <h2 className="text-xl font-bold text-white mb-5">Leadership</h2>
          <div className="space-y-4">
            {leadership.map((p) => (
              <div key={p.name} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="text-white font-bold">{p.name}</span>
                  <span className="text-[10px] font-bold text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/30 px-2.5 py-0.5 rounded-full uppercase tracking-wide">{p.title}</span>
                </div>
                <p className="text-[#94a3b8] text-sm leading-relaxed mt-2">{p.bio}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-14">
          <h2 className="text-xl font-bold text-white mb-5">Roadmap</h2>
          <div className="space-y-3">
            {roadmap.map((r) => (
              <div key={r.phase} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
                <div className="text-white font-bold text-sm">{r.phase}</div>
                <p className="text-[#64748b] text-xs leading-relaxed mt-1.5">{r.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap gap-3">
          <a href="/whitepaper" className="px-5 py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-lg hover:brightness-110 transition-all">
            Read the Whitepaper →
          </a>
          <a href="/security" className="px-5 py-2.5 bg-white/5 border border-white/10 text-white font-bold text-xs rounded-lg hover:bg-white/10 transition-all">
            Explore the Security Layer →
          </a>
          <a href="https://github.com/Talhawaqas/custody-sdk" target="_blank" rel="noreferrer" className="px-5 py-2.5 bg-white/5 border border-white/10 text-white font-bold text-xs rounded-lg hover:bg-white/10 transition-all">
            View SDK on GitHub ↗
          </a>
        </div>
      </div>
    </div>
  );
}
