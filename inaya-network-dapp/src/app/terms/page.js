// app/terms/page.js — see app/privacy/page.js's header comment; same
// approach and same caveat (solid founding draft, recommend legal review
// before treating as final).

export const metadata = {
  title: "Terms of Service — Inaya Network",
  description: "The terms governing use of the Inaya Network dApp, Business Workspace, and mobile app.",
};

const sections = [
  {
    title: "1. Acceptance of terms",
    body: "By connecting a wallet, creating a Business Workspace account, or otherwise using Inaya Network, you agree to these terms. If you don't agree, don't use the service.",
  },
  {
    title: "2. Testnet status — read this first",
    body: "Inaya Network is currently deployed on BNB Chain Testnet only. No mainnet funds, tokens, or production data should be used with this interface. Testnet $INAYA and any Genesis Airdrop or referral rewards earned during this phase will convert to mainnet allocations at Token Generation Event (TGE), subject to the program's eligibility criteria and anti-Sybil verification requirements at that time — this is not a guarantee of value or a promise of a specific conversion rate.",
  },
  {
    title: "3. No custody, no recovery",
    body: "Files you upload are encrypted and sharded client-side using a passkey only you hold. Inaya Network cannot see, recover, or reset your passkey — if you lose it, the data encrypted with it is permanently unrecoverable by you or by us. This is a deliberate architectural choice, not a limitation we can override on request.",
  },
  {
    title: "4. Not financial advice",
    body: "Nothing on Inaya Network — including the Business Model, tokenomics, staking, or documentation pages — constitutes financial, investment, or legal advice. Evaluate any financial decision independently or with a licensed advisor.",
  },
  {
    title: "5. KYC and referral program",
    body: "Referral rewards require identity verification (KYC) through our third-party provider, Didit, to activate and to prevent self-referral or duplicate-identity abuse. We reserve the right to withhold or reverse rewards obtained through fraudulent, automated, or Sybil activity.",
  },
  {
    title: "6. Business Workspace subscriptions",
    body: "Business Workspace plans are billed through Stripe. You can manage or cancel your subscription at any time through the billing portal inside the Business Workspace. Seat limits, storage limits, and feature availability are determined by your active plan.",
  },
  {
    title: "7. Acceptable use",
    body: null,
    list: [
      "Don't use Inaya Network to store, transmit, or distribute unlawful content.",
      "Don't attempt to circumvent, exploit, or abuse the referral, staking, or Genesis Airdrop reward systems.",
      "Don't attempt to disrupt, overload, or gain unauthorized access to the network, its nodes, or its infrastructure.",
      "Don't misrepresent your identity during KYC verification.",
    ],
  },
  {
    title: "8. Intellectual property",
    body: "The Inaya Network name, logo, and branding are the property of Inaya Network. The @inaya-network/custody-sdk is separately open-sourced under its own license — see the GitHub repository for those specific terms.",
  },
  {
    title: "9. Service availability",
    body: "Inaya Network is provided \"as is\" during its testnet phase, without warranty of uptime, availability, or fitness for a particular purpose. Node operator performance, storage availability, and network conditions can affect service quality and are outside our direct control by design.",
  },
  {
    title: "10. Limitation of liability",
    body: "To the maximum extent permitted by law, Inaya Network is not liable for indirect, incidental, or consequential damages arising from your use of the service, including loss of data resulting from a lost passkey, testnet instability, or third-party service outages (wallet providers, Didit, Stripe, Pinata, or infrastructure providers).",
  },
  {
    title: "11. Termination",
    body: "We may suspend or terminate access to Business Workspace accounts or reward programs for violations of these terms, including fraudulent KYC or reward-system abuse. Wallet-based, on-chain interactions cannot be unilaterally revoked by us — that's the nature of the underlying blockchain.",
  },
  {
    title: "12. Changes to these terms",
    body: "We'll update this page as the product evolves, and material changes will be reflected in the \"last updated\" date below. Continued use after an update constitutes acceptance of the revised terms.",
  },
  {
    title: "13. Contact",
    body: "Questions about these terms: contact@inayanetwork.com.",
  },
];

export default function TermsOfServicePage() {
  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-16 md:px-10 overflow-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px]" />
        <div className="absolute bottom-0 left-0 w-96 h-96 rounded-full bg-[#c9a24d]/5 blur-[120px]" />
      </div>

      <div className="relative max-w-3xl mx-auto">
        <a href="/" className="inline-flex items-center gap-2 text-[#64748b] hover:text-[#00f2fe] text-xs font-mono mb-8 transition-colors">
          ← Back to Inaya Network
        </a>

        <span className="inline-block text-[10px] font-mono font-bold tracking-widest text-[#00f2fe] bg-cyan-500/10 border border-[#00f2fe]/30 rounded-full px-3 py-1 mb-4">
          LEGAL
        </span>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Terms of Service</h1>
        <p className="text-[#64748b] text-xs font-mono mb-10">Last updated: August 2026</p>

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

        <p className="text-[#64748b] text-xs mt-10">
          See also our <a href="/privacy" className="text-[#00f2fe] hover:underline">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}
