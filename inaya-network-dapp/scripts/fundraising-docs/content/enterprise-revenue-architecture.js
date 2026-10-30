// Enterprise Revenue & Node Reward Architecture — editable content. Source
// of truth for public/documents/inaya-enterprise-revenue-node-reward-architecture.pdf.
// Edit this file, then run `node scripts/fundraising-docs/generate.mjs`.
// See README.md.
//
// The prior edition stated the RevenueRouter → CorporateEscrow handoff as a
// single atomic on-chain cascade ("RevenueRouter automatically calls
// createEscrow()... executed atomically within the same blockchain
// transaction"). That does not match the deployed checkout flow (page.js's
// handleCorporateCheckout): two separate, client-initiated transactions.
// Corrected throughout below.
//
// ADDITIVE EDIT (October 2026) — Section 08 gained one scope note: the
// October Secure Collaboration and Device Protection SOWs added no new
// on-chain revenue mechanics, so the settlement/escrow/vesting flow this
// whole document describes is unchanged by them.

export const enterpriseRevenueArchitecture = {
  cover: {
    company: "INAYA NETWORK",
    classification: "CONFIDENTIAL — INSTITUTIONAL REVIEW",
    kicker: "EXECUTIVE PRESENTATION DECK",
    title: "Enterprise Revenue & Node Reward Architecture",
    subtitle: "How a corporate storage payment actually flows through the protocol to a node operator's wallet.",
    docLine: "Document INAYA-REV-2026-V2 · Classification Confidential · October 2026",
  },
  docId: "INAYA-REV-2026-V2",
  sections: [
    {
      number: "01",
      title: "Revenue Router — Payment Settlement",
      blocks: [
        {
          type: "lead",
          text: "When an enterprise customer purchases a Corporate Reserve plan, they approve USDT and call RevenueRouter.processCorporateInvoice(usdtAmount) — a real, standalone on-chain transaction.",
        },
        {
          type: "table",
          headers: ["Allocation", "Purpose"],
          rows: [
            ["39%", "Node Reward Escrow"],
            ["51%", "Company Treasury"],
            ["10%", "Team & Platform Maintenance"],
          ],
        },
        {
          type: "note",
          label: "How the split works.",
          text: "The 39% node-operator share is a fixed value in the production payment code, not an estimate. The remaining 61% splits 51% to the company treasury and 10% to team and platform operations, which matches the protocol's EBITDA math (61% gross margin − 3% grants − 5% R&D − 2% admin, legal and marketing = 51%).",
        },
      ],
    },
    {
      number: "02",
      title: "Corporate Escrow — Funding The Operator Pool",
      blocks: [
        {
          type: "lead",
          text: "After the router transaction confirms, the client separately approves USDT and calls InayaCorporateEscrow.createEscrow(corporate, node, cogsAmount) — a second, independent transaction, not an automatic chain reaction triggered by the router itself.",
        },
        {
          type: "bullets",
          items: [
            "Creates a unique, auditable escrow record on-chain, keyed by an incrementing scheduleId.",
            "Locks the allocated funds for a fixed 12-month vesting period.",
            "Releases via releaseMonthlyPayout(scheduleId) — publicly callable by anyone once a release is due, not restricted to the protocol or the node operator.",
          ],
        },
        {
          type: "note",
          label: "Two transactions, not one.",
          text: "Escrow creation is a second, explicit transaction in the customer's checkout, not an automatic step of the router transaction. This matters for failure handling: if a wallet rejects the second approval after the first transaction has succeeded, the escrow is not created until it is retried.",
        },
      ],
    },
    {
      number: "03",
      title: "Vesting Mechanics",
      blocks: [
        {
          type: "lead",
          text: "Rather than paying operators immediately, the escrow distributes rewards gradually — protecting protocol liquidity while giving operators a predictable, recurring income stream.",
        },
        {
          type: "numbered",
          items: [
            { heading: "1.", body: "Annual allocation locked in InayaCorporateEscrow." },
            { heading: "2.", body: "12 fixed monthly releases, each unlocked once its due date passes." },
            { heading: "3.", body: "Anyone (not just the protocol) can call releaseMonthlyPayout() to trigger a due release." },
          ],
        },
        {
          type: "note",
          text: "Worked example, real tier: a 250 TB / Year Corporate Reserve customer pays 13,500 USDT/yr. At the 39% node-operator commission, that's 5,265 USDT/yr escrowed for the operator — 438.75 USDT/month across the 12 fixed releases, or roughly 14.63 USDT/day under a 30-day-month convention (438.75 ÷ 30).",
        },
      ],
    },
    {
      number: "04",
      title: "Node Registry — Performance Tracking",
      blocks: [
        {
          type: "lead",
          text: "InayaNodeRegistry continuously maintains each node's operational record: capacity, reputation score, historical uptime, active status, stake balance, and assigned workloads.",
        },
        {
          type: "note",
          label: "Trust-model honesty, on the record.",
          text: "The contract's own header comment is explicit: node metrics are coordinator-verified — an authorized verifier wallet attests uptime/capacity off-chain — not cryptographically proven. This document states that plainly rather than implying stronger guarantees than the contract actually makes.",
        },
      ],
    },
    {
      number: "05",
      title: "Proof Registry — Storage Verification",
      blocks: [
        {
          type: "lead",
          text: "At intervals, the protocol issues cryptographic storage challenges. Each node must prove it still holds its assigned encrypted shard.",
        },
        {
          type: "bullets",
          items: [
            "Merkle proof validity — the submitted proof correctly resolves against the expected root.",
            "Requested chunk availability — the challenged data segment is actually retrievable.",
            "Challenge response deadline — the proof must land within the required window.",
          ],
        },
        {
          type: "note",
          text: "Today, verifyChunkProof() is backend-checked (onlyOwner) — the contract's own header comment documents a planned future path to make this permissionless and stake-slashing-backed. Not yet built; stated as a roadmap item, not current behavior.",
        },
      ],
    },
    {
      number: "06",
      title: "Reward Authorization Flow",
      blocks: [
        {
          type: "lead",
          text: "A node satisfying both operational requirements and Proof-of-Storage verification becomes eligible for that period's reward release — nodes that fail verification simply don't receive that period's payout; repeated failures reduce reputation and may eventually result in removal.",
        },
      ],
    },
    {
      number: "07",
      title: "Swarm Reserve — Tokenomics",
      blocks: [
        {
          type: "lead",
          text: "Emissions from the Swarm Reserve (40% of total $INAYA supply) are uptime-gated to prevent mercenary liquidity dumping.",
        },
        {
          type: "table",
          headers: ["Tier", "Quarterly Uptime", "Monthly Cap", "Rating"],
          rows: [
            ["Tier 1 (Elite)", "98.0–100%", "30 $INAYA", "Enterprise-grade"],
            ["Tier 2 (Standard)", "95.0–97.9%", "20 $INAYA", "Commercial-grade"],
            ["Tier 3 (Baseline)", "90.0–94.9%", "10 $INAYA", "Minimum viable"],
            ["Ineligible", "< 90.0%", "0 $INAYA", "Slash / reputation penalty"],
          ],
        },
        {
          type: "note",
          text: "InayaNodeRegistry's tier/commission logic is confirmed directly in the deployed contract code; the emission-cap schedule above is the tokenomics design that logic implements.",
        },
      ],
    },
    {
      number: "08",
      title: "Why This Architecture Matters",
      blocks: [
        {
          type: "bullets",
          items: [
            "Enterprises pay in USDT through a familiar, predictable billing model.",
            "Node operators earn predictable recurring income, but only by continuously proving storage.",
            "The protocol preserves liquidity through escrowed vesting rather than immediate payouts.",
            "Revenue distribution is transparent and on-chain, auditable by anyone.",
          ],
        },
        {
          type: "note",
          text: "This ties operator compensation directly to verified network performance — real, on-chain, but via two client-initiated transactions rather than a single atomic cascade, as corrected above.",
        },
        {
          type: "note",
          label: "Scope note, October 2026.",
          text: "Business Workspace's October additions — a Filen/FileCloud-inspired Secure Collaboration suite and an Internxt-inspired Device Protection suite (hybrid post-quantum key establishment, a local-only Cleaner, Inaya Meet) — are SaaS-side features with no on-chain revenue mechanics of their own; the settlement, escrow, and vesting flow described in this document is unchanged. See the companion SaaS Business Model document for where they fit in the SaaS revenue line instead.",
        },
        {
          type: "note",
          label: "Scope note, October 2026 — Sovereign Infrastructure.",
          text: "Sovereign Infrastructure (bring-your-own-hardware virtual machines, storage, networking, AWS CLI compatibility, load balancing, and Kubernetes) also does not route through the 39% node-reward escrow this document describes: it runs on a customer's own hardware, not Inaya's storage node network, so there is no node operator to compensate for it. See the companion Storage Business Model document's October 2026 scope note for where this revenue line sits instead.",
        },
      ],
    },
  ],
};
