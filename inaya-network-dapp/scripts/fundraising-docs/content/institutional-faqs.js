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
          type: "note",
          label: "Correction from prior edition.",
          text: "An earlier version of this document stated a fixed \"0.1 USDT + 0.1 INAYA per GB\" dual-asset ingress model. That figure is stale and conflicts with the current live pricing structure. [VERIFY] the exact current per-GB rate with engineering before quoting a number in an institutional setting — it's read live from the contract and designed to move.",
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
            { heading: "2.", body: "The client separately approves USDT and calls InayaCorporateEscrow.createEscrow() to escrow the node-operator's COGS share — a second, independent transaction." },
            { heading: "3.", body: "The escrow releases that allocation over 12 fixed monthly payouts." },
          ],
        },
        {
          type: "note",
          label: "Correction from prior edition.",
          text: "An earlier version described this as a single atomic transaction with the router \"automatically\" invoking escrow creation. The deployed checkout flow is two separate, client-initiated transactions. [VERIFY] the specific revenue-split percentages (node/treasury/team) with the founders before restating them publicly — RevenueRouter's Solidity source isn't tracked in this repository, only its deployed address, so this document can't independently confirm the split from code.",
        },
      ],
    },
    {
      number: "Q6",
      title: "What does the unit-economics / margin structure look like?",
      blocks: [
        {
          type: "lead",
          text: "[VERIFY] Specific gross-margin and EBITDA figures before quoting them to an institutional counterparty — prior materials have stated figures in the 50–61% gross margin and ~50% EBITDA range, but this document doesn't have a source of truth to reconcile those numbers against. Get one figure agreed with the founders and cite it consistently across every investor-facing document rather than each one stating a slightly different number.",
        },
      ],
    },
    {
      number: "Q7",
      title: "Does Inaya offer anything beyond the storage protocol for enterprise buyers?",
      blocks: [
        {
          type: "lead",
          text: "Yes — Business Workspace is a fully independent B2B SaaS product built on the same infrastructure: organizations, departments, projects, documents, server-enforced approval workflows, granular permissions, secure external sharing, and a permission-aware AI assistant. It's priced and evaluated like any other business software — an institutional buyer never has to engage with the token economics above to use it.",
        },
      ],
    },
  ],
};
