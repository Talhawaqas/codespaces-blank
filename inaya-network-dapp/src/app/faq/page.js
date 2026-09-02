// app/faq/page.js
//
// Real, indexable FAQ page with FAQPage structured data — FAQ rich
// results are one of the highest-value SERP features available to a
// page like this. Content matches the facts already established in
// scripts/fundraising-docs/content/community-faqs.js and
// institutional-faqs.js (same live contract reads, same figures).

export const metadata = {
  title: "Frequently Asked Questions — Inaya Network",
  description: "Answers about Inaya Network's storage pricing, encryption, wallet support, KYC, and the Genesis Airdrop.",
};

// Exported (not just a local const) so src/lib/rag/sources/docsSources.js
// can ingest the exact same content shown on this page into the Docs RAG
// knowledge base — one source of truth, not a duplicated copy.
export const faqs = [
  {
    icon: "🔐",
    q: "What is Inaya Network in simple terms?",
    a: "A private, encrypted vault for your most sensitive files. Unlike Google Drive or Dropbox, which store files whole on central servers, Inaya encrypts data on your own device first, then splits it into pieces before anything leaves your browser. No single company — not even Inaya — ever holds a complete, readable copy of your file.",
  },
  {
    icon: "🛡️",
    q: "How does client-side encryption actually protect me?",
    a: "It happens inside your own browser before anything uploads. Your file is encrypted with AES-256-GCM, then split into two independent pieces at the exact binary midpoint. Either piece alone is meaningless, encrypted noise. Your file can only be reconstructed with your own private master passkey, which never leaves your device.",
  },
  {
    icon: "💰",
    q: "How much does storage actually cost?",
    a: "The current live rate, read directly from the deployed contract, is 0.0044 USDT per GB stored — roughly 4.50 USDT per TB. Storage ingress currently has no $INAYA fee at all; $INAYA fees for egress (retrieval) are planned to activate at mainnet, not before.",
  },
  {
    icon: "📅",
    q: "Do I need a monthly subscription?",
    a: "No. Corporate Reserve annual plans exist for large enterprise customers with predictable, high-volume needs. Everyday users pay Pay-As-You-Go — only for the exact amount of data actually stored, with zero commitment.",
  },
  {
    icon: "👛",
    q: "What wallets are supported?",
    a: "Inaya is built natively on BNB Chain. On the web app, any standard Web3 browser extension wallet (e.g. MetaMask) works. On mobile, wallet connection works via MetaMask Connect Multichain. Business Workspace, Inaya Learn, and the public Security page don't require a wallet at all.",
  },
  {
    icon: "🎁",
    q: "What is the Genesis Airdrop?",
    a: "A 1,000,000 $INAYA pool (3.3% of the total hard cap) — automatic rewards for uploads, plus dedicated developer and community/moderator contributor application tracks. Testnet rewards convert to mainnet $INAYA allocations at TGE.",
  },
  {
    icon: "✅",
    q: "Why should I trust a testnet-stage product?",
    a: "Inaya doesn't ask for blind trust — the encryption architecture is verifiable (files are provably split client-side before upload), the core contracts are deployed and verified on BscScan, and web and mobile both run the exact same open-source custody-sdk for encryption, not separate implementations. Every release publishes a cryptographic hash you (or anyone) can independently reproduce and check, and release artifacts are also available via content-addressed IPFS delivery — see /build for the details and current build ID. Being upfront that this is testnet, not mainnet, is itself part of that verifiability.",
  },
  {
    icon: "🚀",
    q: "What can I do with Inaya today, beyond storage?",
    a: "Inaya Learn — curated Web3/AI/programming videos with a built-in AI tutor, no wallet needed. Security — check whether a domain or IP has been flagged by the decentralized threat-intelligence network, right from the public website. Business Workspace — document management with real approval workflows and permissions for companies.",
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
};

export default function FaqPage() {
  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-16 md:px-10 overflow-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px]" />
        <div className="absolute -bottom-32 -right-24 w-[28rem] h-[28rem] rounded-full bg-violet-500/10 blur-[130px]" />
      </div>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />

      <div className="relative max-w-3xl mx-auto">
        <a href="/" className="inline-flex items-center gap-2 text-[#8a96ab] hover:text-[#00f2fe] text-xs font-mono mb-8 transition-colors">
          ← Back to Inaya Network
        </a>

        <div className="inaya-fade-in-up">
          <span className="inline-block text-[12px] font-mono font-bold tracking-widest text-[#00f2fe] bg-cyan-500/10 border border-[#00f2fe]/30 rounded-full px-3 py-1 mb-4">
            FAQ
          </span>
          <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Frequently Asked Questions</h1>
          <p className="text-[#94a3b8] text-base mb-1 max-w-xl">
            Real answers about real, verifiable infrastructure — no marketing fluff, just what's actually deployed and live on BNB Chain today.
          </p>
          <p className="text-[#8a96ab] text-xs mb-8">Tap a question to expand it.</p>

          <div className="flex flex-wrap gap-3 mb-10">
            <a
              href="/"
              className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-5 py-2.5 rounded-full hover:brightness-110 transition"
            >
              🔐 Try the Vault
            </a>
            <a
              href="/whitepaper"
              className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-[#e2e8f0] bg-white/5 border border-white/10 px-5 py-2.5 rounded-full hover:bg-white/10 transition"
            >
              Read the Whitepaper
            </a>
          </div>
        </div>

        <div className="space-y-3">
          {faqs.map((f, i) => (
            <details
              key={f.q}
              open={i === 0}
              className="group bg-[#090d16]/80 border border-white/5 open:border-[#00f2fe]/20 rounded-xl transition-colors inaya-fade-in-up"
              style={{ animationDelay: `${i * 0.06}s` }}
            >
              <summary className="list-none flex items-center gap-4 p-5 sm:p-6 cursor-pointer select-none">
                <span className="w-10 h-10 rounded-xl bg-[#00f2fe]/10 flex items-center justify-center text-lg shrink-0" aria-hidden="true">
                  {f.icon}
                </span>
                <h2 className="text-white font-bold text-base flex-1">{f.q}</h2>
                <svg
                  className="w-4 h-4 text-[#8a96ab] shrink-0 transition-transform duration-200 group-open:rotate-180 group-open:text-[#00f2fe]"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </summary>
              <p className="text-[#94a3b8] text-sm leading-relaxed px-5 sm:px-6 pb-5 sm:pb-6 pl-[4.75rem] sm:pl-[5rem]">{f.a}</p>
            </details>
          ))}
        </div>

        <p className="text-[#8a96ab] text-xs mt-8">
          More detail: <a href="/whitepaper" className="text-[#00f2fe] hover:underline">Whitepaper</a> · <a href="/about" className="text-[#00f2fe] hover:underline">About</a> · <a href="/security" className="text-[#00f2fe] hover:underline">Security</a>
        </p>
      </div>
    </div>
  );
}
