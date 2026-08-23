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

export const enterpriseRevenueArchitecture = {
  cover: {
    company: "INAYA NETWORK",
    classification: "CONFIDENTIAL — INSTITUTIONAL REVIEW",
    kicker: "EXECUTIVE PRESENTATION DECK",
    title: "Enterprise Revenue & Node Reward Architecture",
    subtitle: "How a corporate storage payment actually flows through the protocol to a node operator's wallet.",
    docLine: "Document INAYA-REV-2026-V2 · Classification Confidential · August 2026",
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
            ["[VERIFY]%", "Node Reward Escrow"],
            ["[VERIFY]%", "Company Treasury"],
            ["[VERIFY]%", "Team & Platform Maintenance"],
          ],
        },
        {
          type: "note",
          label: "What changed from the prior edition.",
          text: "The revenue-split percentages are stated as [VERIFY] rather than restated as fact, since RevenueRouter's Solidity source isn't tracked in this repository — only its deployed address and an inline ABI fragment are. Confirm the current split with the founders before quoting it in an institutional setting.",
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
          label: "Correction from prior edition.",
          text: "Earlier material described escrow creation as automatic — \"no manual approval step,\" happening as part of the same settlement flow as the router transaction. It is, in fact, a second explicit transaction in the client's checkout code. The distinction matters for anyone reasoning about transaction atomicity or failure modes (e.g. what happens if a user's wallet rejects the second approval after the first transaction already succeeded).",
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
          text: "[VERIFY] a specific worked-example dollar figure with the founders before publishing one — a prior edition used a placeholder \"5,265 USDT/year\" example that doesn't map to the real 250/500/1000 TB tier pricing (13,500 / 27,000 / 54,000 USDT/yr) and should not be reused without recalculating from real numbers.",
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
          text: "[VERIFY] these specific thresholds and caps with the founders — this is a tokenomics design decision, not something currently enforced directly by InayaNodeRegistry's on-chain commission logic (which is confirmed in code). Confirm whichever system actually governs $INAYA emission before restating these numbers as current fact.",
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
      ],
    },
  ],
};
