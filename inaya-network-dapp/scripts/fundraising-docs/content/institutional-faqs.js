// Institutional & Enterprise FAQs — editable content. Source of truth for
// public/documents/inaya-institutional-faqs.pdf. Edit this file, then run
// `node scripts/fundraising-docs/generate.mjs`. See README.md.
//
// Significantly corrected from the prior edition. Two concrete errors fixed:
// (1) the "Scale Matrix / Established Swarm / Institutional Node" API-volume
// subscription tiers referenced in the old Q3 don't exist anywhere in the
// codebase — the custody-sdk guide's own corrected edition says so
// explicitly. Replaced with the real Corporate Reserve annual tiers.
// (2) the old Q2's "0.1 USDT + 0.1 INAYA per GB" dual-asset ingress pricing
// contradicts the already-corrected Community FAQ, which states storage
// ingress currently has no required $INAYA fee. Aligned to match.

export const institutionalFaqs = {
  cover: {
    company: "INAYA NETWORK",
    classification: "CONFIDENTIAL — INSTITUTIONAL REVIEW",
    kicker: "INSTITUTIONAL & ENTERPRISE FAQS",
    title: "Institutional & Enterprise FAQs",
    subtitle: "Operational and compliance framework for institutional review of the Inaya Protocol.",
    docLine: "Document INAYA-FAQ-INST-2026-V2 · Classification Confidential · August 2026",
  },
  docId: "INAYA-FAQ-INST-2026-V2",
  sections: [
    {
      number: "Q1",
      title: "How is Inaya architecturally different from legacy decentralized storage?",
      blocks: [
        {
          type: "lead",
          text: "Legacy decentralized storage protocols (Filecoin, Arweave) focus on commodity file hosting, where complete files often reside intact on a single node. Inaya operates as a zero-knowledge custody orchestration layer: files never leave the enterprise user's device in a unified state. Client-side encryption and binary sharding happen before anything reaches the network — the blockchain is used purely as an immutable metadata attestation log, never as file storage itself.",
        },
      ],
    },
    {
      number: "Q2",
      title: "What is the current storage pricing model?",
      blocks: [
        {
          type: "lead",
          text: "Pay-As-You-Go storage is billed in USDT, read live from the deployed contract's per-GB fee rate. As of this writing, storage ingress does not require a separate $INAYA fee — $INAYA's utility centers on staking, governance, and egress (retrieval), not the upload itself.",
        },
        {
          type: "table",
          headers: ["Fee", "Current Rate", "Basis"],
          rows: [
            ["Storage ingress (USDT)", "0.0044 USDT / GB (~4.50 USDT / TB)", "Live on-chain rate, read directly from the deployed InayaCustody contract"],
            ["Storage ingress ($INAYA)", "0 — not charged", "$INAYA plays no role in ingress pricing today"],
            ["Egress / retrieval ($INAYA)", "Not yet active", "Activates at mainnet, by design — not a testnet gap"],
          ],
        },
        {
          type: "note",
          label: "Correction from prior edition.",
          text: "An earlier version of this document stated a fixed \"0.1 USDT + 0.1 INAYA per GB\" dual-asset ingress model. That figure was stale — confirmed against a live on-chain read of the deployed contract's usdtFeePerGB() and inayaFeePerGB() view functions, and directly confirmed by the founder.",
        },
      ],
    },
    {
      number: "Q3",
      title: "What are the enterprise storage tier options?",
      blocks: [
        {
          type: "lead",
          text: "The real, implemented structure is the Corporate Reserve annual plan — a fixed data allocation billed once a year in USDT, with maintenance settled in $INAYA-equivalent value.",
        },
        {
          type: "table",
          headers: ["Allocation", "Reserve Fee (USDT/yr)", "Annual Maintenance"],
          rows: [
            ["250 TB / Year", "13,500", "500 USDT-eq."],
            ["500 TB / Year", "27,000", "1,000 USDT-eq."],
            ["1000 TB / Year", "54,000", "2,000 USDT-eq."],
          ],
        },
        {
          type: "note",
          label: "Correction from prior edition.",
          text: "An earlier version of this document described three API-request-volume subscription tiers (\"Scale Matrix,\" \"Established Swarm,\" \"Institutional Node\" at $999–$35,000/month). Those names and pricing do not exist anywhere in the codebase — confirmed against the custody-sdk's own corrected developer guide, which explicitly flags them as incorrect. The table above is what a corporate customer actually purchases today, verified against the live checkout flow.",
        },
      ],
    },
    {
      number: "Q4",
      title: "How does client-side binary sharding work, mathematically?",
      blocks: [
        {
          type: "lead",
          text: "On file ingestion, the browser runtime derives a key via PBKDF2 (100,000 iterations, HMAC-SHA256, 16-byte random salt), encrypts with AES-GCM-256, then splits the resulting ciphertext at its exact midpoint byte into two shards.",
        },
        {
          type: "code",
          text: "Mp = floor(length(C) / 2)\nShard Alpha = C[0 ... Mp-1]\nShard Beta  = C[Mp ... end]",
        },
        {
          type: "note",
          text: "Because neither shard contains a contiguous bit structure, an isolated compromise of any single storage node yields only random binary noise — external exfiltration from one node alone is not viable.",
        },
      ],
    },
    {
      number: "Q5",
      title: "How does corporate revenue actually settle on-chain?",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "1.", body: "The customer approves USDT and calls RevenueRouter.processCorporateInvoice() — one on-chain transaction." },
            { heading: "2.", body: "The client separately approves USDT and calls InayaCorporateEscrow.createEscrow() to escrow the node-operator's 39% COGS share — a second, independent transaction." },
            { heading: "3.", body: "The escrow releases that allocation over 12 fixed monthly payouts." },
          ],
        },
        {
          type: "table",
          headers: ["Allocation", "Purpose"],
          rows: [
            ["39%", "Node Reward Escrow — 12-month vesting to the operator who serviced the invoice"],
            ["51%", "Company Treasury"],
            ["10%", "Team & Platform Operations"],
          ],
        },
        {
          type: "note",
          label: "Correction from prior edition.",
          text: "An earlier version described the router-to-escrow handoff as a single atomic transaction with the router \"automatically\" invoking escrow creation. The deployed checkout flow is two separate, client-initiated transactions — that part was corrected. The 39% figure itself is not a marketing estimate: it's hardcoded in the live settlement route (src/app/api/stripe-webhook/route.js — cogsAmountWei = (invoiceAmountWei * 39n) / 100n). The remaining 61% split into 51% Treasury / 10% Team reconciles exactly with the Financial Model's own gross-margin math (Q6).",
        },
      ],
    },
    {
      number: "Q6",
      title: "What does the unit-economics / margin structure look like?",
      blocks: [
        {
          type: "table",
          headers: ["Line item", "% of Gross Network Inflow"],
          rows: [
            ["Gross Network Inflow (Total Sales)", "100%"],
            ["Node Operator Commissions (COGS)", "39%"],
            ["Protocol Net Retention (Gross Margin)", "61%"],
            ["Ecosystem Grants & Scholarships", "3%"],
            ["Tech R&D & Global Telemetry Scaling", "5%"],
            ["Admin, Legal & Marketing", "2%"],
            ["Target Protocol EBITDA Margin", "51%"],
          ],
        },
        {
          type: "note",
          text: "This reconciles exactly: 61% gross margin minus 3% grants, 5% R&D, and 2% admin/legal/marketing leaves 51% — the same 51% that appears as the Company Treasury's share of the RevenueRouter split in Q5, since Treasury is where that margin actually accrues before the smaller opex lines are drawn down against it.",
        },
      ],
    },
    {
      number: "Q7",
      title: "Does Inaya offer anything beyond the storage protocol for enterprise buyers?",
      blocks: [
        {
          type: "lead",
          text: "Yes — Business Workspace is a fully independent B2B SaaS product built on the same infrastructure: organizations, departments, projects, documents, server-enforced approval workflows, granular permissions, secure external sharing, and a permission-aware AI assistant. It's priced and evaluated like any other business software — an institutional buyer never has to engage with the token economics above to use it. As of September 2026, a Sovereign Enterprise OS layer also ties the whole workspace together: one home screen showing real trust & health status (built from the actual audit trail and backup data, not a decorative dashboard), unified notifications, cross-module search, and a single AI assistant covering both business and security questions.",
        },
      ],
    },
  ],
};
