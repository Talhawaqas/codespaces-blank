// Inaya SaaS Business Model — editable content. Source of truth for
// public/documents/inaya-saas-business-model.pdf. Edit this file, then run
// `node scripts/fundraising-docs/generate.mjs`. See README.md.
//
// Companion to the existing inaya-business-model.pdf (which covers the
// Web3/DePIN storage engine's tokenomics) — this one covers the second,
// SaaS engine: Business Workspace. Content here is drawn only from what's
// actually built and already-approved language elsewhere in this repo:
// pricing/limits from src/lib/orgPlans.js, product scope from
// src/lib/saasRoadmap.js, and the "two-engine" framing + Business
// Workspace customer segmentation already approved for the Investment
// Memorandum/GTM Strategy. No new financial projections are introduced —
// Section 09 is explicitly labeled illustrative unit economics, not a
// forecast, and doesn't touch the Investment Memorandum's protected
// Section 13 figures.

export const saasBusinessModel = {
  cover: {
    company: "INAYA NETWORK",
    classification: "CONFIDENTIAL",
    kicker: "INAYA SAAS — BUSINESS MODEL",
    title: "Business Workspace: The SaaS Engine",
    subtitle:
      "A zero-knowledge, encrypted business collaboration platform — built on the same client-side encryption and decentralized storage infrastructure as Inaya's DePIN network, packaged as a recurring-revenue SaaS product for companies of every size.",
    docLine: "Document INAYA-SAAS-BM-2026-V1 · Classification Confidential · August 2026",
  },
  docId: "INAYA-SAAS-BM-2026-V1",
  sections: [
    {
      number: "01",
      title: "Executive Overview",
      blocks: [
        {
          type: "paragraphs",
          text: [
            "Inaya Network operates two complementary engines. The Web3/DePIN engine turns users into node operators and storage demand into on-chain network activity. The Business SaaS engine — Business Workspace — turns that same zero-knowledge storage infrastructure into a recurring-revenue product for companies: document management, team collaboration, and an AI business assistant, all encrypted client-side before it ever reaches a server.",
            "Business Workspace is not a hypothetical roadmap item. Company/department/project/document hierarchy, role-based permissions, secure sharing, a full document approval workflow, and a permission-aware AI assistant are built and live today. This document covers that product specifically: what it does, who it's for, how it's priced, and how it generates revenue.",
            "It's one of several products now built on Inaya's infrastructure alongside the core DePIN storage layer — a decentralized Security Layer, an Oracle & Automation Layer, Inaya Learn, an Investor Data Room, and two desktop apps — each covered in its own dedicated document; this one stays scoped to Business Workspace specifically.",
          ],
        },
      ],
    },
    {
      number: "02",
      title: "The Problem",
      blocks: [
        { type: "lead", text: "Small and mid-sized businesses face the same structural cloud problems enterprises do, with fewer resources to work around them." },
        {
          type: "bullets",
          items: [
            "Provider-managed encryption. Most business cloud storage is encrypted with keys the provider holds, not the customer — meaning the provider technically can access customer data, whether prompted by an internal breach, a compromised employee, or a legal request.",
            "Egress-driven lock-in. Cheap-to-enter, expensive-to-leave pricing structures make switching providers costly enough that businesses stay even when a better option exists.",
            "Fragmented tooling. Document storage, approvals, permissions, and team communication typically live in separate, loosely-integrated tools, each with its own access model to manage and audit.",
            "AI without data-ownership guarantees. As AI assistants increasingly read and act on company documents, businesses have no cryptographic guarantee that a provider (or a provider's AI training pipeline) can't access what's stored.",
          ],
        },
      ],
    },
    {
      number: "03",
      title: "The Solution — Business Workspace",
      blocks: [
        {
          type: "columns",
          items: [
            {
              heading: "Structured by Design",
              body: "Every company using Business Workspace organizes its documents in a real hierarchy — Company → Department → Project → Document — not a flat file dump. Role-based membership (owner, admin, member) governs who can see what, enforced server-side on every request.",
            },
            {
              heading: "Workflow, Not Just Storage",
              body: "Documents move through real states — draft, under review, approved, rejected, archived — with a full activity log. Approvals are a first-class feature, not a spreadsheet bolted on afterward.",
            },
            {
              heading: "Permission-Aware AI",
              body: "The built-in AI Business Assistant only ever operates over documents the asking user already has access to — permission scoping happens before the model sees anything, not as a prompt-level instruction the model could ignore.",
            },
          ],
        },
        {
          type: "lead",
          text: "Also included: secure, expiring document share links; per-document and per-project access grants; a dashboard and activity feed built from the same permission resolution as everything else; full mobile access via the Inaya app; and, as of September 2026, an OS Home screen — real-time trust & health status, cross-module notifications, one search across every module, and an AI assistant that answers both business and security questions in a single conversation.",
        },
      ],
    },
    {
      number: "04",
      title: "Why Zero-Knowledge Architecture Matters Here",
      blocks: [
        {
          type: "lead",
          text: "Business Workspace inherits the same client-side encryption model as Inaya's core storage layer — a business document is encrypted in the browser before it ever leaves the user's device.",
        },
        {
          type: "bullets",
          items: [
            "A breach of Inaya's storage backend reveals nothing usable — an attacker gets encrypted fragments, not documents.",
            "Inaya cannot comply with a data request it structurally cannot fulfill — there is no key on Inaya's side to hand over.",
            "The permission-aware AI Assistant means even Inaya's own AI layer never sees a document outside what the requesting user is already authorized to view.",
          ],
        },
        {
          type: "note",
          label: "Positioning:",
          text: "This is the product's core differentiator against traditional business collaboration SaaS — competitors encrypt data on their servers with keys they control; Business Workspace encrypts it before it arrives.",
        },
      ],
    },
    {
      number: "05",
      title: "Pricing & Plans",
      blocks: [
        {
          type: "lead",
          text: "Four self-serve tiers, priced monthly or annually (17% discount on annual billing), each with a 14-day free trial. Enterprise is contact-sales only.",
        },
        {
          type: "table",
          headers: ["Plan", "Price", "Users", "Storage", "Max File Size"],
          rows: [
            ["Starter", "$7.99/mo · $79/yr", "2", "250 GB", "5 GB"],
            ["Professional (Most Popular)", "$28/mo · $280/yr", "5", "1 TB", "10 GB"],
            ["Business", "$49.99/mo · $499/yr", "10", "5 TB", "25 GB"],
            ["Enterprise", "$799/mo · $7,990/yr", "Up to 25", "10 TB", "100 GB"],
          ],
        },
        {
          type: "bullets",
          lead: "Add-ons available on every plan:",
          items: [
            "Additional users — starting at $2.49/user/month",
            "Additional storage — $3.99/TB/month",
            "Enterprise (50+ users or 50+ TB) — custom pricing via direct sales engagement",
          ],
        },
      ],
    },
    {
      number: "06",
      title: "Revenue Model",
      blocks: [
        {
          type: "bullets",
          items: [
            "Recurring subscription revenue. Monthly or annual per-company billing across four tiers, collected via Stripe.",
            "Seat and storage expansion revenue. Companies that outgrow their tier's limits pay incrementally for additional users or storage rather than being forced into a full tier jump.",
            "Enterprise contracts. Larger organizations (25+ users or 10+ TB) are handled as direct sales engagements with custom pricing, not self-serve checkout.",
            "Shared infrastructure economics. Business Workspace runs on the same encrypted storage backend as Inaya's core DePIN product — SaaS subscription revenue and DePIN storage/staking revenue draw on shared infrastructure investment rather than requiring a separate cost base.",
          ],
        },
      ],
    },
    {
      number: "07",
      title: "Market Positioning",
      blocks: [
        {
          type: "lead",
          text: "Business Workspace competes in the business collaboration and document management category — the space occupied by mainstream cloud productivity suites and document platforms — on a specific, structural axis: who actually holds the encryption key.",
        },
        {
          type: "bullets",
          items: [
            "Most incumbent platforms in this category encrypt customer data with provider-managed keys — meaning the provider retains the technical ability to access customer data.",
            "Business Workspace encrypts client-side before data ever reaches a server, so Inaya never holds a decryption-capable key for any customer's documents.",
            "This isn't positioned as a replacement for full enterprise-suite platforms (email, calendaring, spreadsheets) — it's positioned specifically for the document storage, workflow, and permissioning layer, where the zero-knowledge guarantee matters most.",
          ],
        },
        {
          type: "note",
          label: "Note:",
          text: "This document intentionally avoids citing specific competitors' current pricing — third-party pricing changes independently of this document and should be verified directly against each provider's current published rates before use in any external-facing material.",
        },
      ],
    },
    {
      number: "08",
      title: "Go-to-Market",
      blocks: [
        {
          type: "bullets",
          items: [
            "Product-led growth. The 14-day free trial on every self-serve tier lets a company's own owner/admin activate and evaluate the product directly, without a sales conversation.",
            "Cross-promotion from the existing DePIN dApp. Wallet-connected users of Inaya's core network are shown Business Workspace directly inside the dApp, converting an already-engaged audience into a second product line.",
            "Regional partnership channel. A distribution relationship with a regional technology consultancy is in active development, including introductions to their existing enterprise client base — consistent with the channel strategy already outlined in the GTM Strategy document.",
            "Primary target segments: Web3 builders, AI startups, SaaS companies, healthcare technology, financial technology, legal technology, and any organization whose documents carry real confidentiality requirements.",
          ],
        },
      ],
    },
    {
      number: "09",
      title: "Illustrative Unit Economics",
      blocks: [
        {
          type: "note",
          label: "Illustrative only — not a forecast:",
          text: "The figures below are simple arithmetic on the published pricing in Section 05, shown to illustrate how the pricing tiers translate into recurring revenue at different levels of adoption. They are not a projection, do not assume any particular growth rate or timeline, and are independent of the Investment Memorandum's financial projections.",
        },
        {
          type: "table",
          headers: ["Scenario", "Mix", "Monthly Recurring Revenue"],
          rows: [
            ["Early traction", "100 Starter", "$799"],
            ["Modest adoption", "200 Starter + 100 Professional", "$4,398"],
            ["Established base", "300 Starter + 200 Professional + 50 Business", "$10,497"],
            ["Broader base", "500 Starter + 400 Professional + 150 Business + 10 Enterprise", "$30,684"],
          ],
        },
      ],
    },
    {
      number: "10",
      title: "Product Roadmap",
      blocks: [
        {
          type: "lead",
          text: "Business Workspace ships in stages — the first six are live today; the rest extend it toward a full business operations platform.",
        },
        {
          type: "numbered",
          items: [
            { heading: "Secure Business Foundation — LIVE.", body: "Company/department/project/document hierarchy, auth, and role-based access." },
            { heading: "Document Workflow — LIVE.", body: "Draft/review/approval states with a full activity log." },
            { heading: "Enterprise Permissions & Secure Sharing — LIVE.", body: "Per-document access grants and expiring share links." },
            { heading: "AI Business Assistant — LIVE.", body: "A permission-aware assistant scoped to each user's real access." },
            { heading: "Business Operations — LIVE.", body: "Projects & tasks, CRM (unified lead/customer records with a sales pipeline), procurement (purchase requests/orders with a real approval chain), and inventory (real stock movements, including purchase orders that actually move inventory on receipt)." },
            { heading: "Finance & HR — LIVE (testnet demonstration layer).", body: "Invoices, expenses, payments, and CSV financial reporting; employee records, employee documents, computed leave balances, and Department Manager administration — built on the exact same permission foundation as every earlier stage. Not regulated banking, tax filing, or payroll processing; every screen carries a visible \"Testnet / Beta\" badge." },
            { heading: "Business Intelligence — FUTURE.", body: "Reporting and analytics across everything stored in the workspace." },
            { heading: "AI-Powered Business Operations — FUTURE.", body: "The AI Assistant extends from answering questions to taking action across the platform." },
          ],
        },
      ],
    },
    {
      number: "11",
      title: "Conclusion",
      blocks: [
        {
          type: "paragraphs",
          text: [
            "Business Workspace turns Inaya's core zero-knowledge storage infrastructure into a second, independent revenue engine — recurring SaaS subscriptions from companies, rather than storage fees from individual users and node operators. The product is built, live, and priced today, not a roadmap promise.",
            "The two engines share infrastructure but serve different buyers and different revenue mechanics, giving Inaya Network two distinct paths to growth from a single underlying technology investment.",
          ],
        },
      ],
    },
  ],
};
