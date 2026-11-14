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
//
// ADDITIVE EDIT (September 2026) — Section 08 gained one factual line on
// the now-real AWS S3/Azure Blob API compatibility and enterprise storage
// governance suite (scoped credentials, versioning, locked retention,
// legal hold, lifecycle policies, a desktop drive mount). No new numeric
// claims; every item named is real and tested against the actual AWS
// CLI/Azure SDK.
//
// ADDITIVE EDIT (October 2026) — Section 08 gained one more note covering
// the Filen/FileCloud-inspired Secure Collaboration suite and the
// Internxt-inspired Device Protection suite. No new numeric claims; hedged
// the same way the underlying verification ledgers hedge them.
//
// EDIT (29 October 2026) — Section 04's note rewritten without internal
// code paths or "correction from prior edition" wording (same figures);
// Section 05 now says egress-fee demand starts at mainnet, matching
// Section 02; Section 08 names the industry editions and ERP mode.
//
// REPRICING (13 November 2026, founder-approved) — pay-as-you-go storage
// 4.50 -> 6.49 USDT/TB/month; Corporate Reserve 13,500/27,000/54,000 ->
// 17,970/34,740/65,880 USDT/yr (a volume discount off pay-as-you-go);
// account fee 5 -> 12 USDT/yr; retrieval included up to the stored volume
// each month, $INAYA fee beyond that from mainnet; node-operator share
// 39% -> 35% (treasury 55%, team 10%). Competitor table refreshed to
// November 2026 list prices. Source of truth in code: src/lib/dappPricing.js.

export const storageBusinessModel = {
  cover: {
    company: "INAYA NETWORK",
    classification: "CONFIDENTIAL — EXECUTION DECK",
    kicker: "STRATEGIC BUSINESS MODEL",
    title: "DePIN Disruption Architecture",
    subtitle: "Enterprise-grade sovereign storage at Web2-commodity pricing.",
    docLine: "Document INAYA-EXEC-2026-V2 · Classification Confidential · October 2026",
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
            "Storage is 6.49 USDT per TB per month (about 0.0063 USDT/GB), set on the deployed contracts. A one-time upload fee equals one month of storage, and a flat account fee of 12 USDT a year applies.",
            "Retrieval up to the customer's stored volume is included every month. Beyond that, a fee of 10 $INAYA per 0.5 TB applies from mainnet, not before.",
            "Staking $INAYA unlocks priority bandwidth routing.",
          ],
        },
        {
          type: "table",
          headers: ["Provider", "Storage (1 TB / month)", "Egress (1 TB)", "Minimums"],
          rows: [
            ["Amazon S3 (Standard)", "~23.00 USDT", "~90 USDT", "None"],
            ["Google Cloud Storage", "~20.00 USDT", "~120 USDT", "None"],
            ["Cloudflare R2", "15.00 USDT", "Free", "None"],
            ["Wasabi", "~7.99 USDT", "Free within limits", "1 TB, 90 days"],
            ["Storj", "7.00 USDT", "7 USDT", "5 USDT / month"],
            ["Backblaze B2", "6.95 USDT", "Free to 3x stored, then 10 USDT", "None"],
            ["Inaya Network (DePIN)", "6.49 USDT", "Included to 1x stored, then $INAYA fee at mainnet", "None"],
          ],
        },
        {
          type: "note",
          text: "Competitor figures are list prices in USD as of November 2026: Backblaze B2, Storj and Cloudflare R2 are from their own pricing pages; figures marked ~ are widely reported list prices. Inaya's figures are the values set on the deployed contracts.",
        },
        {
          type: "note",
          label: "Pricing headroom.",
          text: "Inaya's pay-as-you-go rate moved from 4.50 to 6.49 USDT per TB per month in November 2026 and is still the lowest list price in this table: about 7% under Backblaze B2 and Storj, 19% under Wasabi, 57% under Cloudflare R2 and 72% under Amazon S3. Storj's current prices took effect on 1 July 2026, and Backblaze and Wasabi are also reported to have raised prices during 2026. Prices are owner-settable on the deployed contracts, so they can be reviewed as the market moves.",
        },
      ],
    },
    {
      number: "03",
      title: "Corporate Reserve Plans (Annual)",
      blocks: [
        {
          type: "table",
          headers: ["Allocation", "Inaya Fee (USDT/yr)", "Per TB per month", "Annual Maintenance"],
          rows: [
            ["250 TB / Year", "17,970", "5.99 USDT", "500 USDT-eq."],
            ["500 TB / Year", "34,740", "5.79 USDT", "1,000 USDT-eq."],
            ["1000 TB / Year", "65,880", "5.49 USDT", "2,000 USDT-eq."],
          ],
        },
        {
          type: "note",
          text: "This is the real, live tier structure in the dApp's Business Model tab and checkout flow. Larger allocations carry a volume discount off the 6.49 USDT pay-as-you-go rate.",
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
            ["35%", "Node Reward Escrow"],
            ["55%", "Company Treasury"],
            ["10%", "Team & Platform Operations"],
          ],
        },
        {
          type: "note",
          label: "How the split works.",
          text: "Payment and escrow are two separate transactions started from the customer's checkout, not one automatic on-chain cascade. The 35% node-operator share is a fixed value in the production payment code, not an estimate. The remaining 65% splits 55% to the company treasury and 10% to team and platform operations, which matches the protocol's EBITDA math (65% gross margin − 3% grants − 5% R&D − 2% admin, legal and marketing = 55%). At 6.49 USDT per TB per month, node operators receive about 2.27 USDT and Inaya retains about 4.22 USDT per TB per month.",
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
            { heading: "Reduced Sell Pressure", body: "As operators favor accumulation over liquidation, circulating supply available for sale drops, while egress fees, once they activate at mainnet, create ongoing demand that absorbs it." },
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
          text: "Fixed 30,000,000 total supply, consistently published across every prior team document. The five allocations above sum to 29,000,000 tokens (96.7% of total supply); the remaining 1,000,000 INAYA (3.3%) is held unallocated pending a future allocation decision, not yet assigned to a named sector.",
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
          text: "This deck covers the core storage/DePIN economics specifically. Inaya has since grown a full application layer on the same infrastructure — Business Workspace (a genuinely independent SaaS revenue line, now including real business operations and a Finance & HR layer), the Security Layer, an Oracle & Automation Layer, Inaya Learn, an Investor Data Room, two desktop apps, four AI assistants, a Sovereign Enterprise OS layer connecting all of it, and — as of September 2026 — a public Trust Center, an Autonomous Resilience Layer, a Node Operator Dashboard, four new business primitives (Inaya Sign, DePIN Storage Manager, Milestone Escrow, Financial Attestation), Identity Integration with MSP multi-tenancy, an AI Bookkeeper, and a Managed Database/Document Intelligence/AI-ML Studio — and, as of October 2026, six industry editions of Business Workspace (Health, Legal, Regulated Enterprise, Financial, Government and Education) with an optional ERP-style layout.",
        },
        {
          type: "note",
          label: "Enterprise interoperability, September 2026.",
          text: "The storage layer itself now speaks the two protocols enterprise IT already standardizes on: a real, tested AWS S3-compatible API and Azure Blob Storage-compatible API (verified against the actual AWS CLI and the official Azure SDK — not a simplified approximation). On top of that sits an enterprise storage governance suite: scoped, time-limited access credentials; object version history with one-click restore; immutable locked retention for compliance; legal hold; automated lifecycle/retention policies; and a native desktop drive mount so storage appears as an ordinary drive letter. This closes the single largest objection enterprise storage buyers raise — migration cost — since existing tools and scripts connect with no rewrite.",
        },
        {
          type: "note",
          label: "Secure Collaboration & Device Protection, October 2026.",
          text: "Two further additions to Business Workspace, both off by default per organization: a Filen/FileCloud-inspired Secure Collaboration suite (end-to-end encrypted Secure Chat and Secure Notes, Sharing 2.0, Governance, device control, a Sovereign Gateway agent for on-premises file servers), and an Internxt-inspired Device Protection suite (a hybrid post-quantum key-establishment layer combining classical X25519 with ML-KEM-768, a local-only Cleaner, and Inaya Meet private peer-to-peer video calls). Neither changes the storage/DePIN revenue mechanics described above.",
        },
        {
          type: "note",
          label: "Sovereign Infrastructure, October 2026.",
          text: "A third addition, structurally distinct from the storage/DePIN protocol above: a customer can now connect their own server and run real virtual machines, block storage, and private networking on it, managed from the Business Workspace, with a working subset of AWS CLI compatibility, a real HAProxy load balancer, and real Kubernetes (k3s) on guest VMs this stage creates. This is customer-owned hardware — it does not route through the storage network's node-reward economics described elsewhere in this document.",
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
