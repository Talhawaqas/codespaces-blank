// Executive Summary — editable content. This is the source of truth for the
// one-page executive summary PDF (public/documents/inaya-executive-summary.pdf).
// Edit this file, then run `node scripts/fundraising-docs/generate.mjs` to
// regenerate the PDF. See scripts/fundraising-docs/README.md.

export const executiveSummary = {
  meta: {
    kicker: "Sovereign Storage DePIN",
    title: "INAYA NETWORK",
    badge: "One-Page Executive Summary",
    date: "August 2026",
  },
  columns: [
    [
      {
        heading: "Problem",
        body: "Organizations and individuals must still trust centralized cloud providers with complete copies of their data. Traditional “encryption” often leaves key control or file reconstruction in the provider’s domain — breach risk, lock-in, unpredictable egress costs, and weak data sovereignty.",
      },
      {
        heading: "Solution",
        body: "Inaya Network provides client-side AES-256 encryption and binary midpoint sharding before data leaves the user’s device. Only the user holds the keys. A complete TypeScript SDK, React components, CLI, and scaffolding tools make integration straightforward. Transparent USDT pricing (PAYG + Corporate Reserve) removes token-volatility friction.",
      },
      {
        heading: "Market Opportunity",
        body: "Cloud storage is a massive, growing market; DePIN and privacy-preserving infrastructure are among the fastest-growing crypto narratives. AI companies and regulated entities increasingly require stronger custody guarantees. Inaya targets developers and Web3/AI startups first, then expands into broader enterprise use cases.",
      },
      {
        heading: "Product & Traction — Current Stage",
        bullets: [
          "Live on BNB Chain Testnet (~50 days since inception)",
          "Working web dApp + mobile application",
          "Custody SDK v1.0 complete (encryption, sharding, file/folder ops, sharing, events, retries)",
          "Open-source: React package, CLI, create-inaya-dapp, Storybook, templates",
          "Knowledge Base covering DePIN, encryption, and digital sovereignty",
          "Staking interface and business/pricing flows implemented",
          "Full interactive Proof-of-Storage scheduled for mainnet",
          "Also live: a decentralized Security Layer, an Oracle & Automation Layer, Inaya Learn, an Investor Data Room, two desktop apps, and four AI assistants (RAG-grounded Docs/Security/Learn plus a permission-scoped Business Assistant)",
          "September 2026: a Sovereign Enterprise OS layer now ties the product together — unified identity, notifications, search, trust/health status, and one AI assistant spanning business and security questions, plus multi-window desktop support",
        ],
        // Approved addition (2 sentences, see fundraising docs SOW §5) —
        // deliberately prose, not more bullets, to keep this a compression
        // exercise rather than an expansion of the one-page format.
        trailer:
          "Inaya now operates two connected engines: the DePIN storage protocol above, and a Business Workspace SaaS layer — document management, real business operations (tasks, CRM, procurement, inventory), and a Finance & HR layer, all on one permission foundation — built on the same infrastructure. Shipped and functional on web and mobile; proving repeated business usage and willingness to pay is the next milestone, not yet an established result.",
      },
    ],
    [
      {
        heading: "Business Model",
        body: "Pay-As-You-Go (USDT-denominated storage + egress) for developers and smaller users. Corporate Reserve annual capacity plans for institutional customers. On-chain revenue routing with transparent splits. Future node rewards and network effects at mainnet.",
      },
      {
        heading: "Team",
        body: "Talha Waqas (Founder & CTO), Yakub Adnan (Co-Founder & Growth Lead), Fibha Urooj (CFO). Founder-led with AI-assisted development driving extremely high execution velocity — a full product surface and developer platform shipped in under two months. Expanding the broader team is a core use of proceeds.",
      },
      {
        heading: "Fundraising Objective",
        body: "Raising to: (1) strengthen engineering and security (audits, mainnet, PoS); (2) grow the core team; (3) accelerate developer adoption and design-partner programs; and (4) prepare distribution and enterprise readiness. Exact round size and terms available on request.",
      },
      {
        heading: "Key Milestones",
        milestones: [
          { label: "Near-term:", text: "Mobile public launch, directory listings, first design partners, continued content engine." },
          { label: "Mid-term:", text: "Security audits, full Proof-of-Storage, mainnet preparation, early case studies." },
          { label: "Longer-term:", text: "Mainnet launch, node operator growth, measurable network effects, broader enterprise motion." },
        ],
      },
    ],
  ],
  footer: {
    contact: "Contact Talha Waqas, Founder & CTO · talhawaqas92@gmail.com · inayanetwork.com",
    note: "Materials: deck, technical docs, and live demo available on request. All claims refer to testnet status unless otherwise noted.",
  },
};
