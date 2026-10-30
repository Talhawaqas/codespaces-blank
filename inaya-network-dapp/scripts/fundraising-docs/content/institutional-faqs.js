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
//
// ADDITIVE EDIT (October 2026) — one new Q8 added on the two October SOWs
// (Secure Collaboration; Device Protection), hedged the same way the
// underlying verification ledgers hedge them.

export const institutionalFaqs = {
  cover: {
    company: "INAYA NETWORK",
    classification: "CONFIDENTIAL — INSTITUTIONAL REVIEW",
    kicker: "INSTITUTIONAL & ENTERPRISE FAQS",
    title: "Institutional & Enterprise FAQs",
    subtitle: "Operational and compliance framework for institutional review of the Inaya Protocol.",
    docLine: "Document INAYA-FAQ-INST-2026-V2 · Classification Confidential · October 2026",
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
          label: "How the split works.",
          text: "Payment and escrow are two separate transactions started from the customer's checkout. The 39% node-operator share is a fixed value in the production payment code, not an estimate. The remaining 61% splits 51% to the company treasury and 10% to team and platform operations, which matches the protocol's EBITDA math (61% gross margin − 3% grants − 5% R&D − 2% admin, legal and marketing = 51%).",
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
          text: "Yes — Business Workspace is a fully independent B2B SaaS product built on the same infrastructure: organizations, departments, projects, documents, server-enforced approval workflows, granular permissions, secure external sharing, and a permission-aware AI assistant. It's priced and evaluated like any other business software — an institutional buyer never has to engage with the token economics above to use it. As of September 2026, a Sovereign Enterprise OS layer also ties the whole workspace together: one home screen showing real trust & health status (built from the actual audit trail and backup data, not a decorative dashboard), unified notifications, cross-module search, and a single AI assistant covering both business and security questions. Also as of September 2026: a public Trust Center where an outside party can independently, cryptographically verify Inaya's own audit chain in their own browser (rather than take Inaya's word for it); a scoped API-key developer platform for programmatic access; cross-organization trust primitives; recovery capability that's automatically re-tested daily against real infrastructure using synthetic, system-owned assets — never a real customer's data; real Microsoft Entra ID/Active Directory identity integration with MSP multi-tenancy; and an AI Bookkeeper. As of October 2026: Sovereign Infrastructure — an institutional buyer can connect their own server and run real virtual machines, block storage, and private networking on it from the Business Workspace, with a working subset of AWS CLI compatibility, a real HAProxy load balancer, and real Kubernetes (k3s) — their own hardware, managed through the same console, not a separate product to learn.",
        },
      ],
    },
    {
      number: "Q8",
      title: "What did the two October 2026 additions (Secure Collaboration; Device Protection) add, and what's still hedged?",
      blocks: [
        {
          type: "lead",
          text: "Secure Collaboration (Filen/FileCloud-inspired) added end-to-end encrypted Secure Chat (the MLS group-messaging standard, RFC 9420) and Secure Notes, Sharing 2.0 (expiring/password-protected/watermarked links, inbound file requests), Governance (classification, DLP, retention, legal hold, a secure viewer), device trust/block/revoke, and a Sovereign Gateway agent connecting a customer's own on-premises file servers. Device Protection (Internxt-inspired) added a hybrid post-quantum key-establishment layer, a local-only desktop duplicate/junk-file scanner (Inaya Cleaner), and private peer-to-peer video calls (Inaya Meet) that reuse Secure Chat for in-call messaging. Every feature in both additions is off by default per organization.",
        },
        {
          type: "table",
          headers: ["Claim", "What's actually true"],
          rows: [
            ["Post-quantum", "Hybrid key establishment — the existing classical X25519 exchange combined with ML-KEM-768 through a domain-separated HKDF. Additive to classical cryptography, not a replacement; file encryption itself (AES-256-GCM) is unchanged."],
            ["Chat security", "Real MLS group messaging; the server stores and relays ciphertext only. The open-source MLS library used has not had an independent security audit."],
            ["Meet", "Peer-to-peer/mesh video, not routed through an Inaya server, trading a scalable SFU for a stronger privacy property at a conservative default room size."],
            ["Cleaner", "Local-only; never uploads a file inventory anywhere; moves deletions to the OS trash rather than deleting permanently."],
          ],
        },
        {
          type: "note",
          text: "A full, line-item verification ledger (what's VERIFIED against real tests and a real browser versus IMPLEMENTED_NOT_LIVE versus PARTIAL) is available on request for an institutional reviewer's own technical diligence.",
        },
      ],
    },
  ],
};
