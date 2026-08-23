// Technical & Economic Whitepaper — editable content. Source of truth for
// public/documents/inaya-whitepaper.pdf. Edit this file, then run
// `node scripts/fundraising-docs/generate.mjs`. See README.md.
//
// Rewritten August 2026 to give this document a real, versioned source (it
// previously had none — see fundraising-docs/README.md). Content carried
// forward from the prior binary where it checks out against the actual
// code; corrected where it didn't (see the note in Section 07 on the
// RevenueRouter/Escrow flow); flagged with [VERIFY] where a specific
// financial figure is a business decision this document can't independently
// confirm from the codebase — resolve those with the founders before this
// goes out publicly again.

export const whitepaper = {
  cover: {
    company: "INAYA NETWORK",
    classification: "PUBLIC DISCLOSURE",
    kicker: "TECHNICAL & ECONOMIC WHITEPAPER",
    title: "The Inaya Protocol",
    subtitle: "A decentralized sovereign custody network for high-value enterprise and personal data assets.",
    docLine: "Document INAYA-WP-2026-V2 · Classification Public · August 2026",
  },
  docId: "INAYA-WP-2026-V2",
  sections: [
    {
      number: "01",
      title: "Abstract",
      blocks: [
        {
          type: "paragraphs",
          text: [
            "Contemporary high-value enterprise data storage carries a structural single-point-of-failure risk: centralized cloud platforms hold complete, whole files, meaning a single breach of infrastructure or credentials exposes the entire asset.",
            "The Inaya Protocol eliminates this by never letting a complete, readable copy of a file exist anywhere outside the owner's own device. Every file is encrypted locally, split into two independent shards, and pinned to decentralized storage — with only a tamper-evident ownership record, never the file itself, ever touching the blockchain.",
            "This document covers the cryptographic mechanics, the on-chain custody model, the token economics, and — new since the protocol's original whitepaper — the application layer now built on top of it: a Business SaaS workspace, a decentralized security/threat-intelligence layer, an educational platform, an investor data room, two desktop apps, and three purpose-built AI assistants. All of it runs on BNB Chain Testnet today; nothing in this document describes a mainnet-live system yet.",
          ],
        },
        {
          type: "table",
          headers: ["Shard vectors per asset", "Encryption", "$INAYA total supply"],
          rows: [["2", "256-bit AES-GCM", "30,000,000 (fixed)"]],
        },
      ],
    },
    {
      number: "02",
      title: "The Problem With Centralized Storage",
      blocks: [
        { type: "lead", text: "When a file is saved to a classical server, it resides whole. If the administrative boundary is breached, the cleartext contents are entirely compromised." },
        {
          type: "columns",
          items: [
            { heading: "Perimeter exfiltration", body: "Attackers targeting network interfaces to capture whole files in transit." },
            { heading: "Multi-tenant contamination", body: "Hardware-level bleeds inside shared hypervisors, exposing one customer's data to another." },
            { heading: "Custody key forgery", body: "Forced access to a central database holding system-managed master encryption keys." },
          ],
        },
        {
          type: "note",
          text: "\"Inaya\" is derived from the Arabic term for absolute protection, vigilant care, and functional grace — the operating philosophy behind treating storage as an active guardian process rather than a passive database write.",
        },
      ],
    },
    {
      number: "03",
      title: "Client-Side Encryption & Sharding",
      blocks: [
        { type: "lead", text: "Files never leave the user's device in a unified, readable form. Every step below happens locally — verified directly against the custody-sdk source, not assumed." },
        {
          type: "code",
          label: "Key derivation",
          text: "Kv = PBKDF2(passkey, salt, iterations = 100,000, HMAC-SHA256, len = 256)",
        },
        {
          type: "paragraphs",
          text: [
            "The master passkey (P) and a fresh, cryptographically random 16-byte salt (S) derive a 256-bit AES key locally — the passkey itself is never transmitted anywhere, at any point, in either direction.",
            "The file is then encrypted with AES-GCM-256 and the resulting ciphertext (C) is bisected at its exact midpoint into two shards:",
          ],
        },
        {
          type: "code",
          label: "Binary sharding",
          text: "Mp = floor(length(C) / 2)\nShard Alpha = C[0 ... Mp-1]\nShard Beta  = C[Mp ... end]",
        },
        {
          type: "note",
          text: "Neither shard alone contains a contiguous, decryptable structure — an isolated compromise of a single storage node yields random binary noise, not a usable file fragment. This is literal midpoint bisection, not erasure coding.",
        },
      ],
    },
    {
      number: "04",
      title: "On-Chain Ledger Attestation",
      blocks: [
        {
          type: "lead",
          text: "Inaya eliminates the need for a central database cluster for asset ownership — the registry lives on-chain, tracking only shard pointers (IPFS CIDs) and a file hash, never file content.",
        },
        {
          type: "code",
          label: "Registry write (InayaCustody)",
          text: "function batchRegisterAssets(\n  bytes32[] fileHashes,\n  uint256[] fileSizes,\n  string[] shardACIDs,\n  string[] shardBCIDs\n) external",
        },
        {
          type: "note",
          text: "This write is permanent by design — there is no update or delete function for a registered asset. Renaming, moving, or deleting a file is an off-chain metadata operation, not a contract mutation.",
        },
      ],
    },
    {
      number: "05",
      title: "Pay-As-You-Go Storage",
      blocks: [
        {
          type: "bullets",
          items: [
            "Storage is billed in stablecoin (USDT) to remove multi-token friction for developers and retail users.",
            "Fee rates are read live from the deployed contract (usdtFeePerGB / inayaFeePerGB) rather than hardcoded — the protocol can adjust pricing over time without a client update.",
            "[VERIFY] Baseline rate and egress/retrieval pricing — prior published figures (4.5 USDT/TB/month storage, 5–10 INAYA per 0.5–1 TB egress) should be re-confirmed against the live contract values before being restated publicly; rates are designed to move.",
            "Staking $INAYA unlocks priority bandwidth routing and a share of network fee yield (Section 09).",
          ],
        },
      ],
    },
    {
      number: "06",
      title: "Corporate Reserve — Annual Plans",
      blocks: [
        {
          type: "lead",
          text: "For institutions with fixed large-scale storage needs. This is the real, implemented tier structure — three fixed annual allocations, not an API-call-volume tier system.",
        },
        {
          type: "table",
          headers: ["Allocation", "Reserve Fee (USDT/yr)", "Annual Maintenance (INAYA-eq/yr)"],
          rows: [
            ["250 TB / Year", "13,500", "500"],
            ["500 TB / Year", "27,000", "1,000"],
            ["1000 TB / Year", "54,000", "2,000"],
          ],
        },
        {
          type: "note",
          text: "[VERIFY] These figures match the live pricing shown in the dApp's Business Model tab as of this writing — reconfirm before restating, since the UI reads them from config that can change.",
        },
      ],
    },
    {
      number: "07",
      title: "Revenue Distribution — RevenueRouter & Corporate Escrow",
      blocks: [
        {
          type: "lead",
          text: "Corrected from the prior edition of this document, against the real transaction flow in the dApp's checkout code.",
        },
        {
          type: "numbered",
          items: [
            { heading: "1.", body: "A corporate customer approves USDT and calls RevenueRouter.processCorporateInvoice(usdtAmount) — this is a real, standalone on-chain transaction." },
            { heading: "2.", body: "The client then separately approves USDT and calls InayaCorporateEscrow.createEscrow(corporate, node, cogsAmount) for the node-operator's COGS share — a second, independent transaction, not an automatic cascade triggered by the router itself." },
            { heading: "3.", body: "InayaCorporateEscrow locks that allocation and releases it over 12 fixed monthly payouts (releaseMonthlyPayout(), callable by anyone once a release is due)." },
          ],
        },
        {
          type: "note",
          label: "Correction, stated plainly.",
          text: "An earlier version of this material described the router→escrow handoff as happening \"atomically within the same blockchain transaction\" with RevenueRouter \"automatically\" calling createEscrow(). That is not what the deployed contracts do — it's two separate transactions, both client-initiated. The revenue-split percentages themselves ([VERIFY] 39% node / 51% treasury / 10% team, if still current) are a business decision this document doesn't independently confirm from RevenueRouter's source, since that contract's Solidity isn't tracked in this repository — only its deployed address and interface are known.",
        },
      ],
    },
    {
      number: "08",
      title: "Node Performance & Proof of Storage",
      blocks: [
        {
          type: "bullets",
          items: [
            "InayaNodeRegistry tracks each node's capacity, tier, uptime, and stake — but per the contract's own header comment, this is coordinator-verified telemetry (an authorized verifier wallet attests it), not cryptographic proof-of-storage. Described accurately here, not oversold.",
            "InayaProofRegistry separately stores a Merkle root per asset and verifies chunk-level proofs — today this verification is backend-checked (onlyOwner); the contract's own comment documents a planned path to make it permissionless and stake-slashing-backed, not yet built.",
            "Settlement is deliberately timelocked: a verifier queues a settlement (computing commission, not moving funds), and only after a 36-hour delay can anyone call releaseSettlement — protecting the reserve from a single compromised key.",
          ],
        },
      ],
    },
    {
      number: "09",
      title: "Token Economics",
      blocks: [
        {
          type: "table",
          headers: ["Allocation", "%", "Tokens"],
          rows: [
            ["Swarm Reserve (Node Rewards)", "40.0%", "12,000,000 INAYA"],
            ["Staking Rewards Pool", "26.7%", "8,000,000 INAYA"],
            ["Liquidity Pool", "21.7%", "6,500,000 INAYA"],
            ["Team Runway", "5.0%", "1,500,000 INAYA"],
            ["Core Ecosystem Fund", "3.3%", "1,000,000 INAYA"],
            ["Genesis Airdrop", "3.3%", "1,000,000 INAYA"],
          ],
        },
        {
          type: "note",
          text: "[VERIFY] Fixed 30,000,000 total supply and the allocation split above are stated as previously published — this document doesn't independently re-derive them from on-chain state, since $INAYA's Solidity source isn't tracked in this repo (only its deployed address). Confirm before external distribution.",
        },
        {
          type: "bullets",
          lead: "Swarm Reserve emissions are uptime-gated, not automatic:",
          items: [
            "[VERIFY] A 3-month, 90%-uptime commitment cliff before a node qualifies for any Swarm Reserve emission.",
            "[VERIFY] Monthly cap by tier: 30 $INAYA (98%+ uptime), 20 $INAYA (95–97.9%), 10 $INAYA (90–94.9%), 0 below 90%.",
            "These specific thresholds are a tokenomics design decision, not something the current contracts enforce directly (InayaNodeRegistry's tier/commission logic is confirmed in code; the emission-cap schedule above should be checked against whatever governs actual $INAYA distribution before being restated as fact).",
          ],
        },
      ],
    },
    {
      number: "10",
      title: "Beyond The Protocol — The Application Layer",
      blocks: [
        {
          type: "lead",
          text: "Everything above is the foundation. Since the protocol's original whitepaper, a full application layer has shipped on top of it — most of which a user never has to know is running on a blockchain at all.",
        },
        {
          type: "bullets",
          items: [
            "Business Workspace — a B2B SaaS product: organizations, departments, projects, and documents with server-enforced approval workflows, granular permissions, secure sharing, and a permission-aware AI assistant. Email sign-in, no wallet required.",
            "Security Layer (\"Inaya Firewall\") — a decentralized, node-reported threat-intelligence network with reputation-weighted confirmation and on-chain-anchored verdicts, surfaced on a public web page, in the mobile app, and via real OS-level enforcement on desktop.",
            "Inaya Learn — a YouTube-based educational discovery platform with an AI tutor, built to make the apps a daily-use destination beyond storage and staking.",
            "Investor Data Room — a branded, access-controlled document room with per-visitor engagement tracking.",
            "Two Tauri desktop apps — thin native wrappers around the Business Workspace and the main dApp, with system tray, native notifications, and signed auto-updates.",
            "Three Gemini-powered AI assistants — Business, Security, and Learn — sharing one technical pattern but opposite guardrail philosophies suited to their purpose (see the Ecosystem Architecture document for full detail).",
          ],
        },
        {
          type: "note",
          text: "Full technical depth on every one of these lives in the companion \"Complete Ecosystem Architecture\" document — this whitepaper stays focused on the core protocol.",
        },
      ],
    },
    {
      number: "11",
      title: "Leadership",
      blocks: [
        {
          type: "profile",
          name: "Talha Waqas — Founder & CTO",
          paragraphs: ["Web3 full-stack engineer specializing in client-side cryptographic infrastructure, EVM smart contract architecture, and secure data-routing pipelines. Drives core protocol development end to end."],
        },
        {
          type: "profile",
          name: "Yakub Adnan — Co-Founder & Growth Lead",
          paragraphs: ["Web3 growth operator and community strategist specializing in DePIN, user acquisition, and AI-driven ecosystem scaling. Leads growth architecture, community operations, and campaign distribution."],
        },
        {
          type: "profile",
          name: "Fibha Urooj — CFO",
          paragraphs: ["Leads financial planning, budgeting, compliance, and operational finance — building the financial foundation supporting Inaya Network's long-term growth."],
        },
      ],
    },
    {
      number: "12",
      title: "Conclusion",
      blocks: [
        {
          type: "quote",
          text: "Absolute Protection, Vigilant Care, and Functional Grace — the guiding principles of a network built to guard what matters most.",
        },
        {
          type: "lead",
          text: "The Inaya Protocol demonstrates that data integrity doesn't require a centralized database — it can be achieved through client-side encryption, decentralized storage, and a public, tamper-evident ledger. Everything described in this document runs today on BNB Chain Testnet.",
        },
      ],
    },
  ],
};
