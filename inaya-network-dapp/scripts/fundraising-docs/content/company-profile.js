// Corporate Profile — editable content. Source of truth for
// public/documents/inaya-company-profile.pdf. Edit this file, then run
// `node scripts/fundraising-docs/generate.mjs`. See README.md.

export const companyProfile = {
  cover: {
    company: "INAYA NETWORK",
    classification: "PUBLIC",
    kicker: "CORPORATE PROFILE",
    title: "Inaya Network",
    subtitle: "Re-establishing absolute client-side data sovereignty — Web3 infrastructure and DePIN, built on BNB Chain.",
    docLine: "Document INAYA-PROFILE-2026-V2 · Classification Public · August 2026",
  },
  docId: "INAYA-PROFILE-2026-V2",
  sections: [
    {
      number: "01",
      title: "Executive Summary",
      blocks: [
        {
          type: "lead",
          text: "Inaya Network is a next-generation Decentralized Physical Infrastructure Network (DePIN) built to eliminate the vendor lock-in, data monopolies, and single-point-of-failure risk inherent in legacy centralized cloud storage.",
        },
        {
          type: "columns",
          items: [
            { heading: "Industry", body: "Web3 Infrastructure / DePIN" },
            { heading: "Focus", body: "Cryptographic Data Custody" },
            { heading: "Chain", body: "BNB Chain Testnet (EVM-native)" },
          ],
        },
      ],
    },
    {
      number: "02",
      title: "Core Technology",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Client-side encryption.", body: "Every file is encrypted locally (AES-GCM-256, PBKDF2 key derivation) before it ever leaves the device. Plaintext never traverses the network." },
            { heading: "Binary sharding.", body: "The encrypted file is split into two independent halves, distributed to independent storage nodes — neither half is meaningful alone." },
            { heading: "On-chain ownership anchoring.", body: "A tamper-evident ownership record — never the file itself — is written to a BNB Chain smart contract, permanent by design." },
          ],
        },
      ],
    },
    {
      number: "03",
      title: "Product Ecosystem",
      blocks: [
        {
          type: "lead",
          text: "What began as a storage protocol has grown into a full product ecosystem, spanning consumer, developer, and enterprise surfaces — all on the same underlying infrastructure.",
        },
        {
          type: "bullets",
          items: [
            "Web dApp — faucet, encrypted vault upload/download, staking, referrals, and a live Corporate Reserve purchase flow.",
            "Business Workspace — a standalone B2B SaaS product (organizations, departments, projects, documents, workflow, permissions, billing) plus real business operations (Tasks, CRM, Procurement, Inventory) and a Finance & HR layer (invoices, expenses, employee records, leave management), web and mobile.",
            "Security Layer (\"Inaya Firewall\") — decentralized, node-reported threat intelligence with on-chain-confirmed verdicts, surfaced publicly, on mobile, and enforced at the OS level on desktop.",
            "Inaya Learn — an educational video platform with an AI tutor, on web and mobile.",
            "Investor Data Room — access-controlled document sharing with per-visitor engagement analytics.",
            "Mobile app — a full superset of the web dApp's features, plus Business Workspace, Learn, and Security.",
            "Two native desktop apps (Windows + Linux) — one for the Business Workspace, one for the main dApp.",
            "Developer SDK & CLI — the custody-sdk client library plus a published node-operator daemon.",
            "Four purpose-built AI assistants (Docs, Business, Security, Learn) — Gemini-powered, each with a guardrail philosophy suited to its job; Docs, Security, and Learn are grounded by a shared RAG (retrieval-augmented generation) layer over a real, re-ingestable content index on MongoDB Atlas.",
            "Oracle & Automation Layer — an on-chain data registry and a self-operating keeper that executes pre-approved contract actions automatically, live on BSC Testnet.",
            "Sovereign Enterprise OS — the connecting layer across all of the above: unified identity, notifications, search, a real trust & health signal, and one AI assistant spanning business and security questions, on both web and Business Workspace.",
          ],
        },
      ],
    },
    {
      number: "04",
      title: "Leadership",
      blocks: [
        {
          type: "profile",
          name: "Talha Waqas — Founder & CTO",
          paragraphs: [
            "Core system architect and lead full-stack engineer. Deep specialization in browser-layer cryptographic engineering, EVM smart contract design, zero-knowledge storage protocols, and node telemetry systems — driving core codebase development end to end.",
          ],
        },
        {
          type: "profile",
          name: "Yakub Adnan — Co-Founder & Growth Lead",
          paragraphs: [
            "Web3 growth operator and community strategist. Specializes in DePIN, user acquisition, and AI-driven ecosystem scaling — leads growth architecture, community operations, and campaign distribution, bridging complex protocol features with on-chain adoption.",
          ],
        },
        {
          type: "profile",
          name: "Fibha Urooj — CFO",
          paragraphs: [
            "B.Com in Accounting & Finance. Leads financial planning, budgeting, compliance, and operational finance — building the financial foundation supporting Inaya Network's long-term growth.",
          ],
        },
      ],
    },
    {
      number: "05",
      title: "Roadmap",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Phase 01 — Deployment & Audit Proof.", body: "EVM contract deployment across BNB Chain scaling infrastructure, block-range scanning, and third-party security audits ahead of mainnet." },
            { heading: "Phase 02 — Incentivized Alpha & Sybil Resistance.", body: "Anti-sybil validation for edge-node operators, hardware identity verification, and active transaction-tracking pipelines." },
            { heading: "Phase 03 — TGE & Cross-Chain Expansion.", body: "Token Generation Event for $INAYA, cross-chain bridge deployment, and global expansion of the storage node network." },
          ],
        },
        {
          type: "note",
          text: "These three phases remain the core protocol-layer roadmap. The application layer (Section 03) — Business Workspace, Security Layer, Inaya Learn, and the Investor Data Room — has since grown into a significant, independently-scoped body of work alongside it, tracked on its own roadmap rather than folded into these three phases.",
        },
      ],
    },
    {
      number: "06",
      title: "Closing",
      blocks: [
        {
          type: "quote",
          text: "Absolute Protection, Vigilant Care, and Functional Grace — the guiding principles of a network built to guard what matters most.",
        },
      ],
    },
  ],
};
