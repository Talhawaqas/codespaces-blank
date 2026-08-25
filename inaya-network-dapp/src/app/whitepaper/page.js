// app/whitepaper/page.js
//
// Real, indexable summary of the tokenomics/economics content that
// otherwise only lives inside the dApp's "White Paper" tab (client-side
// state on "/") and the downloadable PDF. Figures match
// scripts/fundraising-docs/content/whitepaper.js exactly — live
// contract reads, hardcoded settlement-code constants, and previously
// published tokenomics, not restated from memory.

export const metadata = {
  title: "Whitepaper & Tokenomics — Inaya Network",
  description: "Inaya Network's technical & economic whitepaper summary — $INAYA tokenomics, storage pricing, and the RevenueRouter settlement flow, with a link to the full PDF.",
};

const allocations = [
  { label: "Swarm Reserve (Node Rewards)", pct: "40.0%", tokens: "12,000,000" },
  { label: "Staking Rewards Pool", pct: "26.7%", tokens: "8,000,000" },
  { label: "Liquidity Pool", pct: "21.7%", tokens: "6,500,000" },
  { label: "Team Runway", pct: "5.0%", tokens: "1,500,000" },
  { label: "Core Ecosystem Fund", pct: "3.3%", tokens: "1,000,000" },
  { label: "Genesis Airdrop", pct: "3.3%", tokens: "1,000,000" },
];

const revenueSplit = [
  { label: "Node Reward Escrow", pct: "39%", note: "Hardcoded in production settlement code" },
  { label: "Company Treasury", pct: "51%", note: "Reconciles with published EBITDA math" },
  { label: "Team & Platform Operations", pct: "10%", note: "" },
];

export default function WhitepaperPage() {
  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-16 md:px-10 overflow-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px]" />
      </div>

      <div className="relative max-w-4xl mx-auto">
        <a href="/" className="inline-flex items-center gap-2 text-[#8a96ab] hover:text-[#00f2fe] text-xs font-mono mb-8 transition-colors">
          ← Back to Inaya Network
        </a>

        <span className="inline-block text-[12px] font-mono font-bold tracking-widest text-[#00f2fe] bg-cyan-500/10 border border-[#00f2fe]/30 rounded-full px-3 py-1 mb-4">
          WHITEPAPER
        </span>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-4">Whitepaper &amp; Tokenomics</h1>
        <p className="text-[#94a3b8] text-base leading-relaxed max-w-2xl mb-10">
          A decentralized sovereign custody network for high-value data — client-side encryption and binary sharding anchored on BNB Chain. Below is a summary of the economics; the full technical whitepaper is available as a PDF.
        </p>

        <section className="mb-10">
          <h2 className="text-xl font-bold text-white mb-4">Storage Pricing</h2>
          <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-6">
            <p className="text-[#94a3b8] text-sm leading-relaxed">
              Storage ingress is <span className="text-white font-bold">0.0044 USDT/GB (~4.50 USDT/TB)</span>, read live from the deployed InayaCustody contract. $INAYA carries zero ingress fee today — $INAYA egress/retrieval fees activate at mainnet, not before.
            </p>
          </div>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-bold text-white mb-4">$INAYA Token Allocation</h2>
          <div className="bg-[#090d16]/80 border border-white/5 rounded-xl overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/5 text-[#8a96ab] text-[12px] uppercase tracking-wider">
                  <th className="p-4 font-bold">Allocation</th>
                  <th className="p-4 font-bold">%</th>
                  <th className="p-4 font-bold">Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {allocations.map((a) => (
                  <tr key={a.label}>
                    <td className="p-4 text-white">{a.label}</td>
                    <td className="p-4 text-[#00f2fe] font-bold">{a.pct}</td>
                    <td className="p-4 text-[#94a3b8] font-mono">{a.tokens} INAYA</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[#8a96ab] text-xs mt-2">Fixed 30,000,000 total supply — the six allocations above sum to exactly 30,000,000 tokens.</p>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-bold text-white mb-4">Revenue Distribution</h2>
          <div className="bg-[#090d16]/80 border border-white/5 rounded-xl overflow-hidden mb-3">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/5 text-[#8a96ab] text-[12px] uppercase tracking-wider">
                  <th className="p-4 font-bold">Allocation</th>
                  <th className="p-4 font-bold">%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {revenueSplit.map((r) => (
                  <tr key={r.label}>
                    <td className="p-4 text-white">{r.label}</td>
                    <td className="p-4 text-[#00f2fe] font-bold">{r.pct}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[#8a96ab] text-xs leading-relaxed">
            The 39% node-operator share is not a marketing estimate — it's hardcoded in production settlement code. Corporate invoices settle via RevenueRouter, then a second transaction escrows the node-operator share over a 12-month vesting schedule.
          </p>
        </section>

        <a
          href="/documents/inaya-whitepaper.pdf"
          target="_blank"
          rel="noreferrer"
          className="inline-block px-6 py-3 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-sm rounded-xl hover:brightness-110 transition-all"
        >
          📄 Download Full Whitepaper (PDF) →
        </a>
      </div>
    </div>
  );
}
