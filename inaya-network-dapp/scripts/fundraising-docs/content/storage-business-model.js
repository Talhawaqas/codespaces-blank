// Strategic Business Model (storage/DePIN) — editable content. Source of
// truth for public/documents/inaya-business-model.pdf. Edit this file, then
// run `node scripts/fundraising-docs/generate.mjs`. See README.md.
//
// Named storage-business-model.js (not business-model.js) to keep it
// unambiguous from saas-business-model.js — this one covers the core
// storage/DePIN economics; that one covers the Business Workspace SaaS
// product. Same correction notes as whitepaper.js/enterprise-revenue.js
// apply here (RevenueRouter/Escrow flow). All financial figures are
// confirmed real values — live on-chain reads, production-hardcoded
// constants, or founder-confirmed facts — not placeholders.

export const storageBusinessModel = {
  cover: {
    company: "INAYA NETWORK",
    classification: "CONFIDENTIAL — EXECUTION DECK",
    kicker: "STRATEGIC BUSINESS MODEL",
    title: "DePIN Disruption Architecture",
    subtitle: "Enterprise-grade sovereign storage at Web2-commodity pricing.",
    docLine: "Document INAYA-EXEC-2026-V2 · Classification Confidential · August 2026",
  },
  docId: "INAYA-EXEC-2026-V2",
  sections: [
    {
      number: "01",
      title: "Executive Overview",
      blocks: [
        {
          type: "columns",
          items: [
            { heading: "The Market Friction", body: "Traditional cloud enforces unpredictable pricing, volatile egress fees, and opaque storage policies." },
            { heading: "The Inaya Solution", body: "A DePIN infrastructure offering sovereign data control, client-side encryption, and binary sharding anchored on BNB Chain." },
          ],
        },
        {
          type: "note",
          text: "Retaining pure stablecoin payment simplicity for consumer onboarding, while structurally driving token demand and ecosystem liquidity.",
        },
      ],
    },
    {
      number: "02",
      title: "Pay-As-You-Go Pricing",
      blocks: [
        {
          type: "bullets",
          items: [
            "Billed in stablecoin (USDT), no multi-token friction for developers and retail users.",
            "Storage ingress is 0.0044 USDT/GB (~4.50 USDT/TB), read live from the deployed contract. $INAYA carries zero ingress fee today — $INAYA egress/retrieval fees are planned to activate at mainnet.",
            "Staking $INAYA unlocks priority bandwidth routing.",
          ],
        },
        {
          type: "table",
          headers: ["Provider", "Storage (1TB/mo)", "Egress (1TB)", "Min. duration"],
          rows: [
            ["Amazon S3 (Standard)", "~23.00 USDT", "~90.00 USDT", "30 days"],
            ["Google Cloud Storage", "~20.00 USDT", "~80.00 USDT", "30 days"],
            ["Legacy Web2 (B2)", "~6.00 USDT", "~10.00 USDT", "None"],
            ["Inaya Network (DePIN)", "~4.50 USDT", "$INAYA fee at mainnet", "Zero constraints"],
          ],
        },
        {
          type: "note",
          text: "Competitor pricing above is indicative market reference. Inaya's own figures are read live from the deployed contract as of this writing.",
        },
      ],
    },
    {
      number: "03",
      title: "Corporate Reserve Plans (Annual)",
      blocks: [
        {
          type: "table",
          headers: ["Allocation", "Inaya Fee (USDT/yr)", "Annual Maintenance"],
          rows: [
            ["250 TB / Year", "13,500", "500 USDT-eq."],
            ["500 TB / Year", "27,000", "1,000 USDT-eq."],
            ["1000 TB / Year", "54,000", "2,000 USDT-eq."],
          ],
        },
        {
          type: "note",
          text: "This is the real, live tier structure in the dApp's Business Model tab and checkout flow.",
        },
      ],
    },
    {
      number: "04",
      title: "Revenue Flow",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "1. Customer pays.", body: "A corporate or retail customer settles a storage invoice in USDT." },
            { heading: "2. Router processes.", body: "RevenueRouter.processCorporateInvoice() executes on-chain." },
            { heading: "3. Escrow funds operators.", body: "A separate client-initiated transaction calls InayaCorporateEscrow.createEscrow(), locking the node-operator COGS share for a 12-month, monthly-release vesting schedule." },
          ],
        },
        {
          type: "table",
          headers: ["Allocation", "Purpose"],
          rows: [
            ["39%", "Node Reward Escrow"],
            ["51%", "Company Treasury"],
            ["10%", "Team & Platform Operations"],
          ],
        },
        {
          type: "note",
          label: "Correction from prior edition.",
          text: "This is two client-initiated transactions, not one atomic router-to-escrow cascade — corrected against the actual checkout code (page.js's handleCorporateCheckout). The 39% split is not an estimate: it's hardcoded in production (src/app/api/stripe-webhook/route.js), and the remaining 61% splits 51%/10% between Treasury and Team, reconciling exactly with the protocol's own published EBITDA math (61% gross margin − 3% grants − 5% R&D − 2% admin/legal/marketing = 51%).",
        },
      ],
    },
    {
      number: "05",
      title: "The Staking Flywheel",
      blocks: [
        {
          type: "columns",
          items: [
            { heading: "Staking Multiplier Loop", body: "Node operators locking earned rewards back into staking generate a secondary passive income stream instead of immediately liquidating." },
            { heading: "Reduced Sell Pressure", body: "As operators favor accumulation over liquidation, circulating supply available for sale drops, while ongoing egress-fee demand continues absorbing it." },
          ],
        },
        {
          type: "note",
          text: "Real, implemented mechanic: InayaStaking offers 0/30/90-day lock tiers at 1.00x/1.25x/1.50x reward multipliers, enforced on-chain via a real withdrawal lock, not just a UI label.",
        },
      ],
    },
    {
      number: "06",
      title: "Token Allocation",
      blocks: [
        {
          type: "table",
          headers: ["Sector", "%", "Tokens"],
          rows: [
            ["Swarm Reserve (Nodes)", "40.0%", "12,000,000 INAYA"],
            ["Staking Rewards Pool", "26.7%", "8,000,000 INAYA"],
            ["Liquidity Pool", "21.7%", "6,500,000 INAYA"],
            ["Team Runway", "5.0%", "1,500,000 INAYA"],
            ["Core Ecosystem Fund", "3.3%", "1,000,000 INAYA"],
          ],
        },
        {
          type: "note",
          text: "Fixed 30,000,000 total supply, consistently published across every prior team document and cross-checked here: the six allocations above sum to exactly 30,000,000 tokens.",
        },
      ],
    },
    {
      number: "07",
      title: "Foundation Scholarship",
      blocks: [
        {
          type: "bullets",
          items: [
            "Total commitment: 3% of protocol revenue — 54,000 USDT annually under the illustrative 1,800,000 USDT gross-inflow scenario the team has previously modeled (a mix of Corporate Reserve tier sales plus PAYG volume; 3% × 1,800,000 = 54,000).",
            "Non-dilutive, objective-focused micro-grants for young developers, cryptography students, and independent open-source builders using the Inaya Custody SDK.",
            "Not yet accepting applications as of this writing — planned to open after mainnet launch.",
          ],
        },
      ],
    },
    {
      number: "08",
      title: "Beyond Storage — The Full Ecosystem",
      blocks: [
        {
          type: "lead",
          text: "This deck covers the core storage/DePIN economics specifically. Inaya has since grown a full application layer on the same infrastructure — Business Workspace (a genuinely independent SaaS revenue line), the Security Layer, Inaya Learn, an Investor Data Room, two desktop apps, and three AI assistants.",
        },
        {
          type: "note",
          text: "See the companion \"Complete Ecosystem Architecture\" and \"SaaS Business Model\" documents for full detail on the application layer's own economics.",
        },
      ],
    },
    {
      number: "09",
      title: "Leadership",
      blocks: [
        {
          type: "profile",
          name: "Talha Waqas — Founder & CTO",
          paragraphs: ["Web3 full-stack engineer specializing in client-side cryptographic infrastructure and secure data-routing pipelines."],
        },
        {
          type: "profile",
          name: "Yakub Adnan — Co-Founder & Growth Lead",
          paragraphs: ["Drives growth architecture, community operations, and campaign distribution across the ecosystem."],
        },
        {
          type: "profile",
          name: "Fibha Urooj — CFO",
          paragraphs: ["Leads financial planning, budgeting, compliance, and operational finance."],
        },
      ],
    },
  ],
};
