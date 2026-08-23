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

const faqs = [
  {
    q: "What is Inaya Network in simple terms?",
    a: "A private, encrypted vault for your most sensitive files. Unlike Google Drive or Dropbox, which store files whole on central servers, Inaya encrypts data on your own device first, then splits it into pieces before anything leaves your browser. No single company — not even Inaya — ever holds a complete, readable copy of your file.",
  },
  {
    q: "How does client-side encryption actually protect me?",
    a: "It happens inside your own browser before anything uploads. Your file is encrypted with AES-256-GCM, then split into two independent pieces at the exact binary midpoint. Either piece alone is meaningless, encrypted noise. Your file can only be reconstructed with your own private master passkey, which never leaves your device.",
  },
  {
    q: "How much does storage actually cost?",
    a: "The current live rate, read directly from the deployed contract, is 0.0044 USDT per GB stored — roughly 4.50 USDT per TB. Storage ingress currently has no $INAYA fee at all; $INAYA fees for egress (retrieval) are planned to activate at mainnet, not before.",
  },
  {
    q: "Do I need a monthly subscription?",
    a: "No. Corporate Reserve annual plans exist for large enterprise customers with predictable, high-volume needs. Everyday users pay Pay-As-You-Go — only for the exact amount of data actually stored, with zero commitment.",
  },
  {
    q: "What wallets are supported?",
    a: "Inaya is built natively on BNB Chain. On the web app, any standard Web3 browser extension wallet (e.g. MetaMask) works. On mobile, wallet connection works via MetaMask Connect Multichain. Business Workspace, Inaya Learn, and the public Security page don't require a wallet at all.",
  },
  {
    q: "What is the Genesis Airdrop?",
    a: "A 1,000,000 $INAYA pool (3.3% of the total hard cap) — automatic rewards for uploads, plus dedicated developer and community/moderator contributor application tracks. Testnet rewards convert to mainnet $INAYA allocations at TGE.",
  },
  {
    q: "Why should I trust a testnet-stage product?",
    a: "Inaya doesn't ask for blind trust — the encryption architecture is verifiable (files are provably split client-side before upload), the core contracts are deployed and verified on BscScan, and the custody-sdk powering the encryption is open-source on GitHub. Being upfront that this is testnet, not mainnet, is itself part of that verifiability.",
  },
  {
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
      </div>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />

      <div className="relative max-w-3xl mx-auto">
        <a href="/" className="inline-flex items-center gap-2 text-[#64748b] hover:text-[#00f2fe] text-xs font-mono mb-8 transition-colors">
          ← Back to Inaya Network
        </a>

        <span className="inline-block text-[10px] font-mono font-bold tracking-widest text-[#00f2fe] bg-cyan-500/10 border border-[#00f2fe]/30 rounded-full px-3 py-1 mb-4">
          FAQ
        </span>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-10">Frequently Asked Questions</h1>

        <div className="space-y-4">
          {faqs.map((f) => (
            <div key={f.q} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-6">
              <h2 className="text-white font-bold text-base mb-2">{f.q}</h2>
              <p className="text-[#94a3b8] text-sm leading-relaxed">{f.a}</p>
            </div>
          ))}
        </div>

        <p className="text-[#64748b] text-xs mt-8">
          More detail: <a href="/whitepaper" className="text-[#00f2fe] hover:underline">Whitepaper</a> · <a href="/about" className="text-[#00f2fe] hover:underline">About</a> · <a href="/security" className="text-[#00f2fe] hover:underline">Security</a>
        </p>
      </div>
    </div>
  );
}
