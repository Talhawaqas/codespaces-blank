// src/lib/saasRoadmap.js
//
// Canonical content for the public Business SaaS Roadmap
// (/business/roadmap on web, the "SaaS Roadmap" screen on mobile).
//
// This is the single source of truth for what the roadmap SAYS — pure
// static data, no database, no API, nothing user-specific. It exists so
// the web and mobile UIs can't drift into showing different claims about
// what's live vs. planned.
//
// inaya-mobile is a separate repository/npm boundary from this one (no
// shared package between them), so this file can't literally be imported
// by both — src/data/saasRoadmap.js in inaya-mobile is a deliberate,
// intentionally-identical mirror of this file's content. If you change a
// stage's status, description, or feature list here, make the same change
// there. Diff the two files against each other before shipping either.
//
// ACCURACY RULE (do not relax this): a stage or feature only gets marked
// LIVE here if it's actually shipped and working in this codebase today.
// As of this file's creation:
//   - Stages 1-3 (workspace, workflow, permissions/sharing) are the
//     Phase 1-3 Business Records Management build — real, tested, shipped.
//   - Stage 4 (AI Business Assistant) is real and shipped on BOTH web
//     (/business, "AI Assistant" tab) and mobile ("Ask the AI Assistant"
//     from each company card in the Business Workspace) — both call the
//     same POST /api/ai/business-chat and the same permission-scoped
//     tools. The mobile app's separate, older "Ask AI" screen (a general
//     docs assistant, /api/ai/chat) is unrelated and still exists
//     alongside it for non-business questions.
//   - Stage 6 (Business Operations) is now fully real and shipped —
//     Projects & Tasks, CRM, Procurement, and Inventory all have a real
//     schema, workflow/permission enforcement, API routes, an org-wide
//     activity log, dashboard summaries, AI tools, and web+mobile UI.
//     See BUSINESS_OPERATIONS_TASKS.md, _CRM.md, _PROCUREMENT.md, and
//     _INVENTORY.md at the repo root for what each module actually does
//     and what's still explicitly out of scope within it (e.g. no
//     warehouse-transfer UI yet, no PO line-item editing after creation).
//     Procurement's PO receiving genuinely moves real Inventory stock —
//     the two modules aren't just adjacent, they're integrated.
//   - Stage 7 (Finance & HR) is now real and shipped — Invoices, Expenses,
//     Payments, CSV reporting, Employee records, Employee documents, Leave
//     management, and Department Administration all have a real schema,
//     workflow/permission enforcement, API routes, an org-wide activity
//     log, dashboard summaries, AI tools, and web+mobile UI. See
//     BUSINESS_OPERATIONS_FINANCE.md and _HR.md at the repo root for what
//     each module actually does and what's explicitly out of scope (no
//     PDF invoice generation, no payroll/tax processing, no regulated
//     banking — this is a testnet demonstration/validation layer).
//   - Stage 8 (Business Intelligence) is now real and shipped too — the
//     Inaya Business Insights & KPI Dashboard: KPI cards, period-over-
//     period comparison, trend charts, and business alerts, computed from
//     the same permission-scoped data every other module already reads,
//     plus a dedicated AI tool (get_business_insights). Web + mobile
//     (mobile has KPIs/alerts, no trend charts yet). See
//     BUSINESS_OPERATIONS_INSIGHTS.md for what's covered and what's not.
//   - Stage 9 (AI-Powered Business Operations) moved from FUTURE to LIVE
//     2026-09-01 — the AI can now propose real (never self-execute) changes
//     across 9 domains, gated by the exact real permission the underlying
//     action requires, a mandatory 36h delay, risk classification, proposal
//     expiration, and a cryptographic audit trail with self-service export.
//     19 automated tests, 11 of them adversarial security scenarios. See
//     docs/ai-controlled-actions.md for the full breakdown, including what's
//     explicitly still not covered (AI-driven record creation, task
//     reassignment, transaction categorization, communication sending).

export const ROADMAP_STATUS = {
  LIVE: "LIVE",
  IN_PROGRESS: "IN_PROGRESS",
  NEXT: "NEXT",
  FUTURE: "FUTURE",
};

export const STATUS_LABELS = {
  LIVE: "Live",
  IN_PROGRESS: "In Progress",
  NEXT: "Next",
  FUTURE: "Future",
};

// Rendering hints only (web maps these to Tailwind classes, mobile maps
// them to RN style objects) — kept here so both stay in sync on which
// status means which color.
export const STATUS_COLORS = {
  LIVE: "#34d399", // emerald
  IN_PROGRESS: "#00f2fe", // cyan
  NEXT: "#f59e0b", // amber
  FUTURE: "#94a3b8", // slate
};

export const ARCHITECTURE_LAYERS = [
  "Inaya DePIN Infrastructure",
  "Secure Decentralized Storage",
  "Business Workspace",
  "Document & Workflow Management",
  "AI Business Assistant",
  "Business SaaS / ERP Modules",
];

export const POSITIONING_STATEMENT =
  "Inaya is building a business software layer that makes decentralized infrastructure simple and invisible to Web2 users.";

export const POSITIONING_SUBTEXT =
  "The underlying DePIN infrastructure remains the foundation. The SaaS layer on top is what businesses actually see and use.";

// Stage 2's approval workflow, structured for rendering (not prose) —
// mirrors the real state machine in src/lib/document-workflow.js exactly.
export const DOCUMENT_WORKFLOW_DIAGRAM = {
  linear: [
    { id: "DRAFT", label: "Draft" },
    { id: "PENDING", label: "Pending" },
    { id: "UNDER_REVIEW", label: "Under Review" },
  ],
  splits: [
    { from: "UNDER_REVIEW", to: "APPROVED", label: "Approve" },
    { from: "UNDER_REVIEW", to: "REJECTED", label: "Reject" },
  ],
  loops: [
    { from: "REJECTED", to: "DRAFT", label: "Revise & resubmit" },
    { from: "APPROVED", to: "ARCHIVED", label: "Archive" },
    { from: "ARCHIVED", to: "APPROVED", label: "Restore" },
  ],
};

export const ROADMAP_STAGES = [
  {
    number: 1,
    title: "Secure Business Foundation",
    status: ROADMAP_STATUS.LIVE,
    description:
      "A secure workspace where businesses can organize teams, projects and documents while using Inaya's privacy-first storage infrastructure underneath.",
    features: [
      "Business Workspace",
      "Company / organization accounts",
      "Passwordless magic-link authentication",
      "Departments",
      "Projects",
      "Team members",
      "Invitations",
      "Business document management",
      "Encrypted document storage",
      "Decentralized storage infrastructure",
    ],
  },
  {
    number: 2,
    title: "Document Workflow",
    status: ROADMAP_STATUS.LIVE,
    description:
      "Transform business documents from simple stored files into controlled business records with approval workflows and traceable history.",
    features: [
      "Document ownership",
      "Draft state",
      "Pending submission",
      "Under review",
      "Approved",
      "Rejected",
      "Revision & resubmission",
      "Archived",
      "Restore",
      "Immutable activity history",
    ],
    diagram: "DOCUMENT_WORKFLOW_DIAGRAM",
  },
  {
    number: 3,
    title: "Enterprise Permissions & Secure Sharing",
    status: ROADMAP_STATUS.LIVE,
    description:
      "Give businesses granular control over who can access, edit, manage and share business information.",
    features: [
      "VIEW / EDIT / MANAGE permission levels",
      "Organization-level (owner/admin) access",
      "Explicit per-document grants",
      "Department & project scoped access",
      "Private documents",
      "Cross-organization isolation",
      "Secure external sharing links",
      "Share expiration",
      "Share revocation",
      "Maximum share usage limits",
      "Hashed share tokens",
      "Activity tracking",
    ],
  },
  {
    number: 4,
    title: "AI Business Assistant",
    status: ROADMAP_STATUS.LIVE,
    highlight: true,
    description:
      "Ask questions about your business workspace using natural language. The AI operates only on information the authenticated user is already authorized to access.",
    securityStatement: "AI permissions never exceed the user's permissions.",
    features: [
      "Permission-aware AI",
      "Business document search",
      "Department discovery",
      "Project discovery",
      "Activity & history queries",
      "Document access queries",
      "Natural-language business questions",
      "Integrated into the Business Workspace",
      "Available on web and mobile",
    ],
    tools: [
      "list_documents", "list_departments", "list_projects", "list_tasks", "list_contacts",
      "list_deals", "list_suppliers", "list_purchase_orders", "list_purchase_requests",
      "list_products", "list_invoices", "list_expenses", "list_employees", "list_leave_requests",
      "find_employee_document", "get_activity", "get_document_access", "get_business_insights",
      "get_business_brief",
    ],
    notes:
      "Live today in both the web and mobile Business Workspace, powered by the exact same permission-scoped tools on the backend. Read-only here — for the AI's ability to propose real changes (never execute them directly), see Stage 9.",
  },
  {
    number: 5,
    title: "Desktop & Native Apps",
    status: ROADMAP_STATUS.LIVE,
    description:
      "The Business Workspace as a real installed application — its own icon, tray presence, native notifications and auto-updates, not just a browser tab.",
    features: [
      "Windows installer (NSIS)",
      "Linux installer (AppImage)",
      "Linux installer (.deb)",
      "System tray & minimize-to-tray",
      "Native application menu (File / Edit / View)",
      "Native desktop notifications for pending approvals",
      "Signed, auto-updating releases",
      "Google Sign-In support inside the native app window",
      "Magic-link email sign-in support",
      "Combined download page for Windows & Linux",
    ],
    notes:
      "Same Business Workspace, same permissions and encryption, running in its own window instead of a browser tab. macOS is not available yet.",
  },
  {
    number: 6,
    title: "Business Operations",
    status: ROADMAP_STATUS.LIVE,
    description: "Manage projects, tasks, customers, purchasing, and inventory from the same secure workspace as your documents.",
    groups: [
      { title: "Projects & Tasks", items: ["Tasks", "Assignments", "Deadlines", "Status tracking", "Team collaboration"] },
      { title: "CRM", items: ["Customers", "Leads", "Deals", "Customer records", "Sales pipeline"] },
      { title: "Procurement", items: ["Suppliers", "Purchase requests", "Purchase orders", "Approval workflows"] },
      { title: "Inventory", items: ["Products / items", "Stock levels", "Warehouses", "Stock movements"] },
    ],
    notes:
      "All four modules are real and shipped: task status workflows, a unified Lead/Customer CRM with a sales pipeline, purchase requests/orders with a real approval chain, and inventory with real stock movements — including purchase orders that actually move inventory when received. Every record is department-scoped and queryable by the AI assistant. See BUSINESS_OPERATIONS_TASKS.md, _CRM.md, _PROCUREMENT.md, and _INVENTORY.md for what's covered and what's explicitly not yet (e.g. warehouse-to-warehouse transfer UI, PO line-item editing after creation).",
  },
  {
    number: 7,
    title: "Finance & HR",
    status: ROADMAP_STATUS.LIVE,
    description: "Secure financial and people-management capabilities built directly into the Business Workspace.",
    groups: [
      {
        title: "Finance",
        items: ["Invoices", "Expenses", "Payments", "Accounting records", "Financial workflows", "Financial reporting"],
      },
      {
        title: "HR",
        items: ["Employee records", "Employee documents", "Leave management", "HR workflows", "Department administration"],
      },
    ],
    notes:
      "Both modules are real and shipped: invoices with a cron-driven overdue status, expense approval workflows, payment recording/approval, and CSV financial reporting; employee lifecycle management, computed leave balances, leave approval, and Department Manager assignment. A testnet demonstration/validation layer, not regulated banking, tax filing, or payroll processing — every Finance/HR screen carries a visible \"Testnet / Beta\" badge. See BUSINESS_OPERATIONS_FINANCE.md and _HR.md for what's covered and what's explicitly not yet (e.g. no PDF invoice generation, no multi-currency conversion).",
  },
  {
    number: 8,
    title: "Business Intelligence",
    status: ROADMAP_STATUS.LIVE,
    description: "Inaya Business Insights & KPI Dashboard — business activity turned into live dashboards and AI-generated insight.",
    features: [
      "Business dashboards",
      "KPI cards (revenue, expenses, pipeline, task completion, headcount, low stock, pending approvals)",
      "Period-over-period comparison",
      "Revenue/expense/task/deal trend charts",
      "Business alerts (overdue invoices, low stock, overdue tasks, significant KPI swings)",
      "AI-generated summaries",
      "AI business insights",
      "Natural-language reporting",
      "Daily / Weekly / Monthly / Yearly Business Brief",
    ],
    examples: [
      "“How's the business doing this month?”",
      "“Any alerts I should know about?”",
      "“Explain why revenue changed this period.”",
      "“Give me my weekly brief.”",
    ],
    notes:
      "Real and shipped: KPI cards, period-over-period comparison, trend charts, and business alerts all compute from the same permission-scoped data every other Business Workspace module already reads — no separate, weaker-scoped path. The AI Business Assistant answers KPI/trend/alert questions directly via a dedicated get_business_insights tool. The Business Brief (new 2026-09-01) is a periodic recap on the same real data — deterministic highlight bullets plus a best-effort AI narrative paragraph on top, available as its own Workspace view and conversationally via get_business_brief. See BUSINESS_OPERATIONS_INSIGHTS.md for what's covered and what's explicitly not yet (no custom date-range picker, no trend charts on mobile yet).",
  },
  {
    number: 9,
    title: "AI-Powered Business Operations",
    status: ROADMAP_STATUS.LIVE,
    highlight: true,
    description:
      "The AI Business Assistant can propose real changes across 9 business domains — it never executes anything itself. A human with the exact same real authority the underlying action would require must approve; the server independently re-validates that authority; a mandatory 36-hour delay passes; only then does the change execute — and every step is recorded in a tamper-evident, cryptographically verifiable audit trail.",
    securityStatement: "AI recommends. Humans authorize. The server validates. The system executes. The audit trail remembers.",
    features: [
      "Guarded task status changes",
      "Guarded expense decisions",
      "Guarded document workflow transitions",
      "Guarded employee status changes",
      "Guarded invoice actions",
      "Guarded leave request decisions",
      "Guarded purchase order transitions",
      "Guarded purchase request transitions",
      "Guarded CRM deal pipeline moves",
      "Risk classification (LOW / MEDIUM / HIGH)",
      "Proposal expiration for unreviewed requests",
      "36-hour mandatory delay after approval",
      "Cryptographically hash-chained, tamper-evident audit trail",
      "Self-service, independently verifiable audit export (JSON / CSV)",
    ],
    notes:
      "Real and shipped across 9 domains, covered by 19 automated tests including 11 adversarial security scenarios (forged approval, cross-tenant access, replay, expired-proposal execution, prompt injection, and more — all fail safely). Explicitly not yet covered: AI-driven record creation (a new task/contact/etc.), task reassignment, transaction categorization, and drafting/sending customer communications — none of these exist anywhere in the app yet, gated or not, so there's nothing yet to guard. See docs/ai-controlled-actions.md for the full phase-by-phase breakdown.",
  },
  {
    number: 10,
    title: "Healthcare & Legal OS",
    status: ROADMAP_STATUS.IN_PROGRESS,
    description:
      "Two vertical specializations of the Business Workspace — Health OS and Legal OS — for organizations handling patient or client/matter data, picked at company signup or changed later in Settings.",
    securityStatement: "Patient and matter visibility is assignment-based, not department-based — being in the right department is never enough on its own.",
    features: [
      "Patient registry & Patient 360 — appointments, consent, ROI, billing, care team (Health OS)",
      "Emergency access review & de-identified research datasets (Health OS)",
      "Matter registry & Matter Workspace — team, deadlines, evidence, holds, discovery, redaction, contracts, time & billing, trust accounting (Legal OS)",
      "Clients, Prospects, and Corporate Entities (Legal OS)",
      "Care-team / matter-team assignment-based access",
      "Break-glass emergency access (audited, time-limited, reviewable)",
      "Legal holds that actually block deletion",
      "Trust accounting with an overdraft-safety guard",
      "Vertical-locked API — a general or mismatched-vertical org is rejected, not just hidden from",
      "Mobile screens for both verticals (Health OS, Legal OS)",
      "Health/Legal AI assistants (read/summarize/draft only — no diagnosis, no legal advice, no filing, no hold release, no evidence deletion)",
    ],
    notes:
      "Every domain module for both verticals now has a real, working screen in Business Workspace — not just Patients and Matters — live-verified end-to-end against the running app, including the trust ledger's server-side overdraft rejection. Mobile now has real screens for both verticals too (Health OS, Legal OS, and their patient/matter detail screens), built against the exact same vertical-locked API routes as web; these are written and syntax-verified but not yet exercised on a live device/simulator, which is the one thing still holding this at IN_PROGRESS rather than LIVE. FHIR/HL7/e-filing/e-signature/SSO and every other third-party integration are documented adapter interfaces with an honest not-configured stub, not live integrations. No HIPAA/ABA/eDiscovery compliance certification exists or is claimed.",
  },
  {
    number: 11,
    title: "Financial Services & Regulated Enterprise OS",
    status: ROADMAP_STATUS.LIVE,
    description:
      "A third and fourth vertical specialization of the Business Workspace — Financial Services OS (hedge funds/asset managers), Private Capital OS (PE/VC), and Regulated Enterprise OS (cross-industry compliance for banks, insurers, pharma, and other regulated organizations) — sharing one platform core with Health OS and Legal OS. All ten phases of the SOW are now built.",
    securityStatement: "A framework or control mapping is never presented as a compliance certification — and a control with no test on file shows as \"unknown,\" never as passing.",
    features: [
      "Regulatory Framework Engine — pluggable reference mappings (NIST CSF 2.0, ISO 27001, SOC 2, DORA, GDPR, GLBA/Reg S-P, SEC IA) with an explicit compliance-is-not-certification disclaimer",
      "Compliance Control Library, Evidence vault, Findings & Remediation, versioned Policy Management, compliance exceptions, internal audit plans, and a Regulatory Examination Workspace with scoped one-time-use external examiner links",
      "Financial Entity Core — funds, entities, investors, counterparties, entity-scoped (not org-wide) permissions",
      "Investment Management — research provenance, investment thesis lifecycle, Investment Committee workflow, portfolio/position/exposure tracking, liquidity, valuation, performance",
      "Private Capital — deal CRM, screening scorecards, due diligence workspace, term sheets, cap-table ingest (not a transactional share registry), portfolio-company workspace, board management, value creation plans, fundraising, exits, SPVs",
      "Security & Resilience — vendor-risk monitoring, ICT asset inventory, BCP/DR, resilience testing, data residency, privileged access & break-glass, segregation-of-duties rules",
      "Role-specific AI copilots (CIO/COO/CCO/CRO/CFO/GC/analyst/deal-team/security/auditor) on the same guarded-execution infrastructure as every other AI tool in the app",
      "Integration Adapter Architecture — fund admin/custodian/prime broker/market-data/cap-table/KYC-AML/SSO, honest stub-by-default (configured:false) until a real credential exists",
      "Executive/Board Layer — Financial Services & Regulated Enterprise OS Homes, board reporting with the same publish-immutable discipline as policies",
      "External Data Rooms — investor, diligence, and audit rooms, generalizing the examiner-access pattern",
      "Enterprise Hardening — tamper-evident regulated export packages, pre-import migration validation",
      "Vertical-locked API across every phase — a general or mismatched-vertical org is rejected, not just hidden from",
    ],
    notes:
      "Live-verified end-to-end against the running app across every phase: control creation and activation, a failing test auto-opening a finding and walking its full state machine to closed, the dashboard's unknown/failing/passing distinction, the full policy lifecycle including the immutability guard and amend-creates-a-new-version behavior, an examiner magic-link's issue/exchange/one-time-use cycle, entity-scoped fund/deal visibility, and the board-report/export-package immutability guards. Not yet built: mobile screens for these verticals (Financial Services OS/Private Capital OS/Regulated Enterprise OS have zero mobile presence today — web only), and real third-party integrations (every adapter is a documented, honest not-configured stub). No compliance certification of any kind exists or is claimed.",
  },
  {
    number: 12,
    title: "Government & Public Sector Sovereign OS",
    status: ROADMAP_STATUS.IN_PROGRESS,
    description:
      "A fifth vertical specialization of the Business Workspace, for government departments and agencies handling citizen, legal, financial, procurement, health, and operational data — sharing the same platform core as every other vertical above.",
    securityStatement: "Citizen-record visibility is assignment-based, not department-based — being in the right department, or even holding staff-level government access, is never enough on its own to see a specific person's record.",
    features: [
      "Citizen Records — need-to-know, assignment-based access, mirroring Health OS's care-team model exactly",
      "Case Management — a 6-state case workflow, optionally linked to a citizen record, with need-to-know inherited from that link",
      "Policy Knowledge Base — the same publish-immutable, versioned lifecycle as Regulated Enterprise OS's Policy Management",
      "A government-only stricter chain-of-custody rule — every document READ is logged, not just every write",
      "Break-glass emergency access — reused unchanged from the Financial/Regulated Enterprise SOW's cross-vertical privileged-access module",
      "Operations + Security Readiness dashboard — case KPIs and audit-chain integrity, always reported as separate honest panels, never a single fabricated score",
      "Government AI assistant — 6 read-only tools; need-to-know is enforced inside the tool itself, not just at the API layer, so it can never see more than the human it's acting for could",
      "Procurement/Contracts/Finance/HR/Tasks/Approvals — the same modules every other vertical already uses, now vertical-gated for Government orgs too",
      "5 stub-by-default government-system integration providers (civil/national ID registry, legacy government ERP, GIS/land records, public records portal, interagency data exchange)",
      "Vertical-locked API — a general or mismatched-vertical org is rejected, not just hidden from",
    ],
    notes:
      "Live-verified: the Government OS vertical option renders correctly in the org-creation flow, and every new API route is statically confirmed to lock to the government vertical. 51 new automated tests cover the two load-bearing properties (citizen-record access requires an actual assignment; a published policy knowledge base entry can never be mutated in place) plus case-workflow transition legality, dashboard honesty (unknown is never shown as passing), and AI tool need-to-know enforcement. Not yet built: mobile screens (Government OS has zero mobile presence today, same gap as Financial/Private Capital/Regulated Enterprise OS), a real pilot-agency onboarding, and any government-specific procurement rule beyond an explicitly informational, non-binding competitive-bid threshold flag. No government certification, accreditation, FedRAMP authorization, or jurisdiction-specific compliance claim exists or is claimed — that requires separate authorities entirely outside this codebase.",
  },
  {
    number: 13,
    title: "Storage Interoperability & Inaya Drive",
    status: ROADMAP_STATUS.LIVE,
    description:
      "Makes Business Workspace storage consumable through the exact tools an enterprise IT team already has — real AWS S3, Azure Blob, and Google Cloud Storage protocol compatibility, a real mounted drive letter on Windows and Linux, and a local migration tool that moves existing cloud data in — without rebuilding or weakening the encryption/sharding/DePIN pipeline underneath any of it.",
    securityStatement: "A signed URL or federated Google sign-in can never grant more access than the credential or membership it's built on already has — verified by adversarial test, not just by design intent.",
    features: [
      "Real AWS SigV4 (AWS4-HMAC-SHA256) and native Google Cloud Storage (GOOG4-HMAC-SHA256) request signing on one endpoint",
      "Real Azure Blob Shared Key compatibility, plus Microsoft Entra ID identity federation",
      "Google Sign-In as a direct authentication path for the storage endpoint itself, mapped to existing organization membership — no separate Google-only permission tier",
      "Temporary signed download URLs with real, tested expiration, tamper rejection, and method restriction",
      "Virtual-hosted bucket addressing (bucket-name-in-the-hostname, matching real AWS/GCS convention), off by default until an operator configures it",
      "Inaya Drive — a real Windows drive letter (WinFSP) and a real Linux mount (FUSE), including genuine empty-folder creation, file read/write, rename, and delete, all proven to survive a full mount-process restart",
      "Local Data Migration Agent — moves existing AWS S3, Azure Blob, or Google Cloud Storage data into Inaya, resumable and integrity-verified, with every credential staying on the operator's own machine",
      "Compliance Evidence Exporter — a read-only, downloadable JSON/PDF evidence package built from the organization's own existing audit chain and storage protection settings, with a cryptographic export hash",
      "Validated against real, unmodified third-party tools: the AWS CLI, rclone, Terraform, and Google's own gcloud storage CLI",
      "Object tags/labels, a real independently-verifiable checksum on every upload, a one-click storage inventory export (JSON/CSV), bulk tag/retention/legal-hold operations across up to 1,000 objects, per-bucket storage analytics, and a read-only storage-credential policy analyzer",
    ],
    notes:
      "Live-verified end-to-end: real SigV4/GOOG4/Shared-Key signature verification, a real signed-URL adversarial test suite (including waiting for genuine wall-clock expiration, not a simulated clock), real Terraform init/apply/plan/destroy and rclone upload/sync/download runs against the live endpoint, and Inaya Drive mounted for real on both a Windows machine and a Linux kernel (WSL2) with a full helper-process kill-and-restart persistence proof. macOS Drive support is written but not yet compiled or tested on real Mac hardware — explicitly not claimed until it is. The September 2026 storage feature expansion (tags, checksum, inventory, batch operations, analytics, policy analyzer) is covered by 9 additional automated tests, with zero regressions to the 57 pre-existing storage tests — a genuine, previously-unnoticed misconfiguration in the Pinata backup-provider credential was also found and fixed along the way. No official AWS/Microsoft/Google partnership, certification, or full protocol parity is claimed anywhere; only what's been directly tested.",
  },
  {
    number: 14,
    title: "Evidence Graph & Digital Twin — Trusted Business Events and What-If Simulation",
    status: ROADMAP_STATUS.LIVE,
    description:
      "Connects existing invoices, purchase orders, purchase requests, and AI-proposed actions into one traceable Business Event — with a plain-language \"Why?\" explanation, a portable cryptographic-proof passport, and a read-only \"What If?\" simulator — then extends that same simulation discipline into a broader Digital Twin that can answer \"what would happen if a supplier became unavailable, an employee lost project access, a project was delayed, or a warehouse went offline\" using the organization's own real, already-connected data.",
    securityStatement: "A simulation can compute what a real change would affect, but it can never make that change happen — verified by tests that snapshot every touched record before and after, and confirm every one is left byte-for-byte identical.",
    features: [
      "Business Event model — references an existing invoice/PO/PR/AI-action by ID rather than copying it, department-scoped exactly like every other Business Operations record",
      "\"Why?\" explainability — permission-aware evidence resolution (a record you can't otherwise see is disclosed only as existing, never its contents), real AI-recommendation fields only, never internal model reasoning",
      "Business Event Passport — a JSON+PDF evidence package with an independently re-verifiable cryptographic manifest hash, reusing the same canonicalization the existing Compliance Evidence Exporter already uses",
      "\"What If?\" simulation for a single business decision, and a Digital Twin dependency graph for broader organizational scenarios — both read-only by construction, with zero import of any function that could actually execute a change",
      "Digital Twin scenarios: supplier unavailable, employee access removed, project delayed, warehouse unavailable — each honestly reports \"unknown\" for any consequence no real stored field can back, rather than inventing a plausible-sounding number",
      "Additive integration into Unified Search, the Activity Center digest, Trust Health, and manager notifications for high-risk events — none of it changing how those existing systems already worked",
    ],
    notes:
      "Live-verified: 47 tests for the Evidence Graph layer and 9 tests for the Digital Twin layer, all passing against the real database, with zero regressions to any pre-existing test suite. The single strongest test in both layers is the same: run every simulation/scenario type, snapshot every record it reads before and after, and assert byte-for-byte equality — proving a simulation can never silently become a real action. Cross-organization Digital Twins (e.g., one company privately checking another's fulfilment capacity without seeing their internal data) were researched — zero-knowledge proofs, secure multiparty computation, and trusted-execution options were all evaluated — and deliberately deferred rather than built, since no validated customer need for it exists yet and building that cryptography speculatively isn't justified. Not yet built: a graph-visualization UI, versioned Twin snapshots for reproducibility, and natural-language scenario creation — the underlying model and API are complete and tested; the UI layer that would sit on top of them is a later pass.",
  },
  {
    number: 15,
    title: "Modular Enterprise Adoption Layer — DirectSync, Data Room Templates, Cloud Backup Scheduler & What-If Studio",
    status: ROADMAP_STATUS.LIVE,
    description:
      "Four self-contained features that make the existing platform materially easier for a real company to adopt without changing how it already works — automatic local-folder backup, ready-made secure data-room templates, a recurring cloud-to-Inaya backup scheduler, and a visual front-end over the existing Digital Twin simulation layer — all built strictly on top of existing storage, permissions, audit, migration, and simulation infrastructure rather than as four disconnected new products.",
    securityStatement: "A local file's own delete action can never delete its backup, a rename can never create a duplicate remote copy, and a what-if simulation can never mutate a real record — each guarantee proven by a real, non-mocked automated test, not just asserted by design.",
    features: [
      "DirectSync — a background local-folder watcher inside the Inaya desktop app; automatically, incrementally uploads new/changed files via the existing S3-compatible API, duplicate-safe and resumable across restarts, reusing the same real S3 client Inaya Drive already uses",
      "Zero-Knowledge Data Room Templates — four ready-made room configurations (Fundraising, M&A, Legal Review, Web3 Due-Diligence) built on the existing Data Room, NDA, and audit infrastructure, not a second document-sharing system",
      "Smart Cloud Backup & Health Scheduler — recurring, incremental AWS S3/Azure Blob/Google Cloud Storage backup into Inaya, orchestrating the existing, already-tested migration engine rather than a second copy of it, with real size-verified integrity checks and a six-state health status",
      "Interactive What-If Scenario Studio — a Business Workspace view over the existing Digital Twin simulation API (not a second simulation engine), with scenario history, current-vs-simulated comparison, dependency impact, and integrity-hashed provenance",
      "A mandatory capability audit was produced and published before any of the four features was built, classifying every proposed capability as already-implemented, reusable, or a genuine gap — nothing here duplicates an existing system",
    ],
    notes:
      "Live-verified: Data Room Templates covered by 8 automated tests (zero regressions to the pre-existing external-data-room suite); Cloud Backup Scheduler by 12 tests, including a genuine end-to-end run through the real migration engine and real storage write path via Node's module-mocking (only the external cloud source is substituted); What-If Studio extends the existing, already-tested Digital Twin test suite with 2 additional tests. DirectSync is covered by 7 unit tests plus 1 real, non-mocked end-to-end test — a real folder watched, real files uploaded, real duplicate-safety, real rename, and real delete-preserves-remote-copy behavior, all run on real Windows hardware. DirectSync's Windows support is real and tested; Linux is built on the same already-proven cross-platform components (the identical S3 client already verified working on Linux elsewhere in the platform) but has not yet been run on a real Linux machine, so it is stated as not yet verified rather than claimed. A real bug — a rename only updating local bookkeeping without actually relocating the object in storage — was found by the end-to-end test and fixed before this stage was marked live.",
  },
  {
    number: 16,
    title: "Storage Control Plane & Terraform Provider — Volumes, Snapshots, Backup Policies, and Infrastructure-as-Code",
    status: ROADMAP_STATUS.LIVE,
    description:
      "An IBM Cloud VPC Storage-inspired control plane for Inaya's own storage — a unified resource registry (volumes and file shares), a real point-in-time snapshot engine, consistency groups, cross-org snapshot sharing, and a tag-driven automated backup policy engine — plus a real Terraform provider so an IT team can declare all of it as code, the same way they already automate their other cloud infrastructure.",
    securityStatement: "A capacity decrease is always rejected rather than silently ignored, a deleted backup policy stops being picked up by the automated cron sweep rather than continuing to run invisibly, and every automatic retention deletion is audited — none of it happens silently.",
    features: [
      "Storage Resource Registry — volumes and file shares as a real, taggable, resizable control-plane record, each backed by a real S3-compatible bucket, with a static, honest physicalCapability field stating plainly that Inaya has no compute/VM layer for a volume to physically attach to",
      "Volume attach/detach as a real reservation/lock mechanism, and file-share mount targets as declared bookkeeping — neither ever claims to be a physical device mount or a real NFS server",
      "Snapshot engine built entirely on existing S3-compatible object versioning — genuinely incremental at capture time (references, not copies), with a real, independently recomputable integrity hash, real copy-forward restore, consistency groups that honestly disclose a sequential (not atomic) capture boundary, cross-region copy, and cross-organization sharing that fails closed on wrong org, revocation, or expiry",
      "Automated backup policy engine — tag-selector-scoped policies with daily/weekly/monthly/long-term plans, real retention enforcement (oldest snapshots beyond a configured count are deleted, every deletion audited), and a six-state health status shared with the existing Cloud Backup Scheduler for a consistent operator experience",
      "terraform-provider-inaya — a real Go-based Terraform provider (inaya_storage_resource, inaya_snapshot, inaya_backup_policy, inaya_backup_plan) authenticated with an org API key, talking to a new bearer-token /api/public/v1/storage/* route namespace built specifically because Terraform runs headless and can't use the existing browser-session storage routes",
    ],
    notes:
      "Live-verified: 35 automated tests across the storage resource, snapshot, backup policy, and Digital Twin integration layers, all passing against the real database and real S3-compatible storage write path, plus the Terraform provider's full create/read/update/delete cycle run against a real local Inaya deployment with real MongoDB-backed state — not a dry run. That testing caught and fixed a real bug (the provider's computed health/created_at fields were briefly blank immediately after creation, before the next refresh). Not built: fast/accelerated restore (no backend primitive exists to make one honestly faster than a normal restore), real physical block-volume attach or real multi-client NFS mounting (structurally impossible without a compute layer Inaya doesn't have), and live interop validation against real IBM Cloud Object Storage (blocked on IBM's own account sign-up, not on anything left to build). The Terraform provider is not yet published to the Terraform Registry — it runs from a local build today.",
  },
  {
    number: 17,
    title: "Official Documentation Platform — Product Guides, API/SDK/CLI Reference, Search, and an OpenAPI Spec",
    status: ROADMAP_STATUS.LIVE,
    description:
      "An IBM Cloud Docs-inspired official documentation portal at inayanetwork.com/docs — real product guides, a hand-verified API/SDK/CLI reference, a real keyword search, release notes, and a downloadable OpenAPI spec, all built directly from the actual shipped implementation rather than aspirational copy.",
    securityStatement: "Every page's status badge (Live/Testnet/Beta/Planned/Deprecated) is enforced by the content loader itself — a page with a missing or invalid status fails to build rather than silently defaulting to a reassuring label.",
    features: [
      "Product Guides, API Reference (all 11 public/v1 endpoints), SDK Reference (all 5 published npm packages), and CLI Reference (all 3 published CLI tools) — every fact hand-verified against the real route files, package.json/README content, and exports, not generated or assumed",
      "A real markdown+frontmatter content engine with automatic table-of-contents generation, explicit related-doc cross-references, and a content loader that fails loudly on a missing field or duplicate slug rather than rendering a broken page",
      "A real client-side keyword search, kept deliberately separate from — and linking out to — the existing semantic AI Docs Assistant, which the new content was wired into as a new RAG source rather than a second AI stack",
      "A downloadable OpenAPI 3.0 spec generated directly from the same verified API reference data (no OpenAPI spec existed anywhere in this codebase before), validated with a real OpenAPI parser",
      "Release Notes rendered directly from this same roadmap's own stage data, so it can never drift into a second, hand-maintained changelog",
      "The site's first-ever \"Documentation\" navigation entry point — confirmed absent anywhere before this",
    ],
    notes:
      "Live-verified: 10 automated tests (frontmatter/slug/status validation, cross-reference integrity, and an OpenAPI-spec-matches-reference-data regression guard), a clean production build, and real browser verification including a genuine mobile-layout bug found and fixed (a search button overlapping its own placeholder text at narrow widths). Shipping this also surfaced and fixed an unrelated, pre-existing production issue: Vercel deployments had been silently failing for roughly 20 hours because a sibling local package's own dependencies were never installed in that environment — fixed with a postinstall hook, verified by simulating a clean install before shipping. Not built: a Tutorials/Solutions/FAQ-as-a-system content type, API/SDK/CLI drift checking against the live route files, a full CI validation/accessibility/SEO suite, an admin/governance interface, and an API playground — the SOW's own 15-phase plan spans well beyond this pass, and this stage covers Phases 0–3 plus slices of 4–7.",
  },
];

export const VISION = {
  title: "The Inaya Business Platform",
  paragraphs: [
    "Inaya's long-term goal is to make decentralized infrastructure invisible to everyday business users.",
    "Businesses should experience a familiar SaaS platform for documents, projects, teams, workflows, operations and business intelligence.",
    "Underneath that experience, Inaya provides privacy-focused decentralized infrastructure, encrypted storage and verifiable data integrity.",
  ],
  closingStatement: "Make decentralized infrastructure as easy to use as traditional cloud software.",
};
