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
      "Same Business Workspace, same permissions and encryption, running in its own window instead of a browser tab. macOS is not available yet. October 2026: found and fixed a real bug where the desktop app's security allowlist never actually granted the website permission to call most of its native features (chat notifications, tray unread count, pop-out module windows, DirectSync, Inaya Drive mount) — every installed copy needed a new signed build to pick up the fix, since that allowlist is compiled into the app, not loaded from the website. Also rotated the auto-update signing key after the original key's password turned out to be unrecoverable, and fixed the updater checking the wrong app's release.",
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
  {
    number: 18,
    title: "Mainframe & Legacy Data Access — Real-Time SQL Virtualization, a Connector Framework, and Real JDBC + ODBC Drivers",
    status: ROADMAP_STATUS.LIVE,
    description:
      "A Software AG CONNX-inspired live SQL virtualization layer: connect a data source, publish it as a versioned virtual schema, and query it in real time with standard SQL and standard client tooling — without moving the data or replacing the source system. A real connector framework, a real reference connector, and now a real RMS/OpenVMS connector proven against a genuine OpenVMS x86-64 instance.",
    securityStatement: "A query can only touch a table that has actually been published as a virtual table for that data source — an unpublished or unauthorized table fails closed with a real 403, never a silent partial result — and write operations are rejected outright rather than silently no-opped, since the gateway is read-only this pass.",
    features: [
      "Connector framework/SDK — a pluggable connector interface (isConfigured/testConnection/discoverMetadata/executeQuery/health/capabilities), following the same pattern already established by Inaya's storage pinning providers",
      "A real relational reference connector (Node's own node:sqlite) — real connection, real metadata discovery, real SQL execution, proven end-to-end",
      "A real RMS/OpenVMS connector (connectors/rmsOpenVms.js) — SSH + real DCL against a genuine OpenVMS x86-64 instance, since there's no ODBC/JDBC bridge for RMS without Oracle Rdb/DBMS; metadata discovery parses OpenVMS's own FDL output, not an invented schema; real record reads for text-organized sequential files, with fixed-format binary and indexed files honestly reported as needing a compiled OpenVMS-side reader",
      "Metadata & virtual schema engine — real schema discovery with explicit, versioned publishing; a re-import never silently overwrites a previously published schema",
      "SQL gateway — a real SQL parser, authorization against exactly what's been published, real query execution with row/timeout limits, and every query (succeeded, denied, or failed) audited to the same shared audit trail every other Inaya feature uses",
      "A real JDBC driver (jdbc-driver/) — a genuine, compiled java.sql.Driver implementation, tested end-to-end including a standalone-jar smoke test with zero other classpath dependencies",
      "A real ODBC driver (odbc-driver/) — a genuine, compiled Win32 DLL exporting 34 standard ODBC entry points, built with MinGW-w64 GCC against the real ODBC SDK, verified end-to-end (19/19 checks) by loading the compiled DLL directly, AND now proven to register and connect through the real Windows ODBC Driver Manager itself (the path Excel/Power BI actually use)",
      "A real REST API (/api/public/v1/data-sources/**) and Business Workspace admin UI (Data Sources + SQL Console tabs)",
    ],
    notes:
      "Live-verified: 11 automated tests for the connector/metadata/gateway layer, 7 automated JDBC integration tests, 19 automated ODBC direct-load tests, and 7 automated RMS/OpenVMS tests against a live OpenVMS instance. Real bugs found and fixed this pass, each confirmed against the real system: getting OpenVMS itself to boot under a hypervisor took five separate genuine firmware/controller/boot-order fixes; the RMS connector's SSH dependency broke Next.js's production bundling for every route that touches the connector registry; and getting the ODBC driver through the real Windows Driver Manager for the first time surfaced five more real bugs (a PowerShell script parameter colliding with a built-in variable, two connection-attribute handlers that hard-errored instead of no-opping, a DSN-resolution gap, and a missing mandatory ODBC Core function whose absence crashed the Driver Manager itself). ODBC registration and a real Driver-Manager-mediated connection are now proven; query execution through that same path still crashes, isolated via the Windows Event Log to a fault inside Microsoft's own odbc32.dll, not this driver — documented honestly as open. Not built: Adabas, VSAM and IMS connectors (Adabas's test environment — a real Docker container — is up and healthy, but the connector code isn't written; VSAM/IMS require a genuine z/OS environment, a much larger undertaking), write-back, and federated cross-source joins. See docs/mainframe-legacy-data-access-report.md for the full breakdown.",
  },
  {
    number: 19,
    title: "Sovereign NAS — an On-Premises SMB/NFS Storage Appliance Managed and Audited by Inaya",
    status: ROADMAP_STATUS.LIVE,
    description:
      "A control plane and appliance agent that turn a Linux machine into a managed on-premises file server: Windows, Mac and Linux computers use it like any office file server (SMB and NFS), while Inaya sets it up, controls who can open what, snapshots it, protects it from ransomware, backs it up and records every action in the tamper-evident audit trail. The office keeps working when the internet is down.",
    securityStatement: "Access fails closed: a share grants only what the person's organization membership, NAS role and folder permissions allow, and a revoked member is locked out on the appliance itself. Immutable (WORM) content cannot be deleted or changed, even by an administrator or root, until its retention date; governance mode needs an owner override with a recorded reason, compliance mode has no override at all.",
    features: [
      "SMB shares and NFSv4 exports generated from a spec, with fail-closed configuration validation and rollback, verified against a real Windows SMB client and the Linux kernel NFS client",
      "Storage pools on real RAID1 or single disks with Btrfs, disk inventory, guarded failure injection, replace/rebuild and scrub; a deliberately corrupted block is detected and the read fails rather than returning bad bytes",
      "Copy-on-write snapshots (manual, scheduled, retention) with file and share restore, and immutable snapshots and WORM shares that root-level deletion, modification and rename cannot defeat",
      "Identity and permissions tied to the organization: NAS accounts only for members holding a NAS role, groups, service accounts, password rotation, lockout policy, POSIX ACLs with explicit deny, department boundaries",
      "Quotas with warning/near-limit/hard-limit states, real file locking with plain-language lock explanations, and a recycle bin whose restore never silently overwrites",
      "Ransomware detection (change and delete ratios, extension changes, entropy jumps, ransom notes, failed logons, snapshot-deletion attempts) with automatic immutable snapshot, alert, time-limited lockdown and recovery from the last clean snapshot",
      "Backup with file-level dedup, resumable runs, read-back verification and restore drills; replication with manifest verification; recovery runbook",
      "Local autonomy: after an unclean restart the pools re-attach, mirrors reassemble and services start by themselves, with cloud reachability shown as degraded, not fatal",
      "49 API route files, an 18-section Business Workspace console and a background worker, reusing the existing permissions, audit chain, Evidence Graph, Digital Twin and encrypted storage",
    ],
    notes:
      "Implemented and tested end to end on ONE documented profile: a Linux VM appliance (Ubuntu 26.04, Samba, NFSv4.2, mdadm, Btrfs) with real disk failure, crash recovery and real Windows and Linux clients. NOT validated on physical hardware (SMART, temperature and UPS are reported UNKNOWN on virtual disks) — the largest remaining gap and the next step before selling hardware. NAS-to-NAS replication was tested on one host only; Active Directory/LDAP login, iSCSI, a local S3 gateway and Kubernetes CSI are not implemented; macOS is untested.",
  },
  {
    number: 20,
    title: "AI Security Workflow — One Checked, Recorded Checkpoint for Every Text AI in Inaya",
    status: ROADMAP_STATUS.LIVE,
    description:
      "A single AI Security Gateway that sits in front of Inaya's AI assistants so the AI cannot be tricked by hidden instructions, cannot leak personal data, and cannot act without permission. Every request passes identity, guardrails, model policy and monitoring, and every decision is recorded so a company can later see why something was allowed, warned, redacted, blocked or sent for human approval.",
    securityStatement: "Retrieved documents and user text are treated as untrusted data: instructions hidden inside them cannot widen permissions or trigger actions, and a risky AI action still goes through the existing human-approval flow (approval, then a 36-hour delay, then execution). The gateway blocks and records; it is strong protection, not a certification, and does not claim to make an AI model perfect.",
    features: [
      "Deterministic prompt-injection detection and personal/sensitive-data detection on user input and documents, before the model sees them",
      "A policy engine per organization (allow, warn, redact, block, require human approval), a model registry, and rate limiting wired into every route",
      "Decisions written to the existing tamper-evident audit chain and to the Evidence Graph as a new AI_SECURITY_CHECK subject — no second audit system",
      "Coverage of all six text AI routes: the business assistant, wallet assistant, security assistant, Learn assistant, documentation assistant and the OS chat",
      "An AI Security view in the Business Workspace showing what each request was allowed to see, which checks ran and why one was blocked or redacted",
    ],
    notes:
      "Live-verified: 23/23 adversarial tests, and a real HTTP round trip against the running server in which a real injection attempt on the business assistant was blocked while normal chat was unaffected. Known boundaries: the voice assistant (speech goes browser to Gemini Live directly) is not gateway-covered; the documentation assistant streams with input-side checks only; routes that have no organization log without an organization audit chain. No independent security certification is claimed.",
  },
  {
    number: 21,
    title: "Native Document & Invoice Automation Engine — Generate, Approve, Store and Send Business Documents",
    status: ROADMAP_STATUS.LIVE,
    description:
      "One pipeline that creates professional business documents from the records Inaya already holds (Finance, CRM, Procurement): data, template, exact calculation, document, validation, approval, evidence, encrypted storage, secure delivery, verification. Nine document types run through the same engine: invoices (standard and professional layouts), purchase orders, quotations, receipts, customer statements, credit notes, debit notes, delivery notes and business reports.",
    securityStatement: "Documents are always derived from the authoritative records, never retyped; a template can contain no executable code; finalized documents are locked (Object Lock) and encrypted; every step is written to the audit chain and Evidence Graph. An AI proposal only ever produces a DRAFT that a person must approve.",
    features: [
      "Exact money handling: decimal parsing, per-currency exponents (USD/EUR/GBP/AED/PKR two decimals, JPY none, KWD/BHD/OMR three), rounding modes, pro-rata discount allocation, tax, shipping and fees, and a running balance on statements",
      "Type-specific rules: approved-only purchase orders, quotations from deals, receipts from approved payments, credit notes limited to the invoice, partial delivery notes, permission-scoped reports",
      "A safe template language: whitelisted fields and formats, controlled conditions, size and depth limits, no code execution and no template injection",
      "Approval and segregation of duties, evidence linking each document to its source records, encrypted sharded storage, and secure link delivery or identity-verified delivery through the Data Room",
      "Honest failure states (storage outage, renderer failure, evidence gap, delivery failure) with resumable jobs; a failed document never appears complete and keeps its allocated number for the retry",
      "Search, Business Brief, Activity Center and trust-health integration, permission-aware",
    ],
    notes:
      "Verified against the real database, including a storage-outage simulation and provider fallback. The Pinata plan limit blocked storage during testing; storage now falls back across configured providers. Live PDF generation, including Arabic and Urdu, was confirmed on the production site on 2026-09-27 (a bundler defect that broke every PDF export on Vercel was found by this live check and fixed the same day; see SQA-026 in the defect registry). A secure link is bearer access — the recipient's email is recorded, not verified, except in Data Room delivery. Country-specific e-invoicing formats are not built. Follow-up under investigation: one document-number ledger assertion in the lifecycle suite after an invoice cancel.",
  },
  {
    number: 22,
    title: "AI Business Operations Manager — Visual Automations, Approvals, Evidence and Notifications",
    status: ROADMAP_STATUS.LIVE,
    description:
      "A visual, node-based workflow builder inside the Business Workspace. A company draws its own routines (a schedule, a webhook or an event as the trigger, then steps that read its own data, ask the AI to summarize or decide, send notifications, or wait for a person's approval), publishes them, and Inaya runs them on its own with a full step-by-step record. Ready-made templates cover daily business health, invoice follow-up, support escalation, and the Finance Operations Manager routine for the AI Bookkeeper.",
    securityStatement: "The AI reads only what the person who owns the automation may see, can suggest but never change records by itself, and every consequential step goes through the existing Controlled Actions approval flow. Connection credentials are stored encrypted, shown once and never returned, logged or audited.",
    features: [
      "A visual editor with validation, publishing, versions, and safe replay that never repeats an action",
      "Triggers: schedule, signed webhook, API key and event; a durable queue with retries, idempotency and stale-run recovery, driven by the existing cron (no second scheduler)",
      "Nodes for permission-scoped data, an AI agent with workflow-scoped memory, conditions, approvals, Slack and email notifications, and evidence",
      "Every run explains itself: inputs, decisions and the reason behind each step, linked into the Evidence Graph and the Business Event Passport",
      "Data readers and action nodes added by later features (support tickets, bookkeeping) through the same engine",
    ],
    notes:
      "Verified against the real database. Slack sending and Gmail delivery were each verified live from a published production workflow on 2026-09-26. A real external helpdesk product is NOT verified (tested against a local stand-in only).",
  },
  {
    number: 23,
    title: "Customer Portal & Customer Service — Tickets, Portal, SLAs, Knowledge Base, AI Assist, and Help & Support for Inaya Users",
    status: ROADMAP_STATUS.LIVE,
    description:
      "A complete support desk built into Inaya, on the customer and invoice records the company already has. Customers sign in to their own portal to raise tickets, attach files and follow the conversation; the company's team works them in a console with queues, assignment, business-hours SLAs that pause and resume correctly, saved replies, internal notes customers never see, a help centre with search, an AI helper that answers from the company's own articles with citations, satisfaction ratings, idea voting, analytics and an open API. Inaya's own users get Help & Support: Business Workspace members raise a ticket to Inaya's support desk, with an email copy to the support mailbox, and dApp visitors are pointed to the portal.",
    securityStatement: "One company's customers can never see another's, and one customer can never see another's tickets; internal notes never reach customers; the AI is untrusted input, cannot change anything by itself and hands over to a person when unsure. Every uploaded file is scanned for malware and stored encrypted; portal sign-in links are single-use and login never reveals whether an address exists.",
    features: [
      "Ticketing with routing, priority policy, business-hours SLAs (nights, weekends, holidays, time zones, pause/resume), macros, merge/relate, incidents and bulk actions",
      "A responsive, accessible customer portal at /portal/<name> with one-time-link sign-in (and company single sign-on via OpenID Connect with PKCE)",
      "A knowledge base with search, an AI answer helper with citations and human hand-off, ratings, ideas and voting, analytics that show honest empty states",
      "Open API with scoped API keys, signed webhooks (SSRF-safe) and export; a native workflow node and support data scope for Automations",
      "Help & Support: a Business Workspace view that files tickets in Inaya's own support desk from the verified account, five requests per hour, idempotent against double submission, with an email copy to the support mailbox (Reply-To set to the requester)",
    ],
    notes:
      "Verified against the real database; Help & Support verified by seven automated tests and a live production check of the endpoints. NOT yet verified against real providers: reply-by-email through the inbound email provider (built, setup pending), company single sign-on, and the malware scanner. To make Help & Support fully visible to dApp visitors, the Inaya Network organization's portal must be switched on in Customer Support settings.",
  },
  {
    number: 24,
    title: "Identity Integration — Microsoft Entra, Active Directory, SCIM, Rewst and MSP Multi-Tenancy",
    status: ROADMAP_STATUS.LIVE,
    description:
      "When a company hires, changes or dismisses someone in its own directory, Inaya follows automatically and can prove the person really lost access. Access is keyed to the provider's immutable identity, changes are planned, executed and verified, and a leaver's revocation is checked step by step: freeze, sessions, credentials, permissions, sharing and break-glass, with failed steps listed and retryable. Managed-service providers can look after several customer companies with strict separation.",
    securityStatement: "Nothing widens access silently: an owner can never be granted by a directory rule, administrator changes go through Controlled Actions, manual exceptions carry a recorded reason, and ambiguous identity matches fail closed. Webhooks require HTTPS, signature, timestamp, replay protection and tenant checks.",
    features: [
      "Joiner, mover and leaver lifecycle with dry-run, approval, idempotency and an evidence trail (audit chain and Evidence Graph)",
      "Standard SCIM 2.0 (Users and Groups) endpoints and an optional Microsoft Graph directory pull",
      "Six independently verified revocation steps with states PENDING / PARTIAL / COMPLETE / FAILED and retry of only the unverified steps",
      "Group and attribute mapping (versioned), temporary access, access reviews, orphan detection, manager replacement, incident restrict/restore, credential lifecycle",
      "MSP delegation with two-sided links and four delegated roles, re-verified on every request; a REST API and outbound events for automation platforms such as Rewst",
      "Reconciliation (MATCH / DRIFT / CONFLICT / UNRESOLVED) and an Identity & Access console (15 tabs) with no fabricated metrics",
      "A real, standalone on-prem Active Directory sync agent (ad-sync-agent/) — outbound-only LDAP to the customer's own DC, HTTPS to Inaya, never the reverse; real full and incremental sync via AD's own uSNChanged watermark, feeding the same signed webhook and unmodified engine already proven against Entra",
    ],
    notes:
      "Verified against a REAL Microsoft Entra tenant: the Graph directory pull, and the SCIM connection test, joiner and leaver as sent by Entra's own provisioning service, including a leaver with six verified revocation steps. Active Directory is now ALSO verified for real: a genuine Windows Server domain controller was stood up, a real test user (with mail/department/title) was created in it, and the new sync agent pulled her and pushed her through the unmodified engine end to end — PROCESSED, with real identity/membership records to show for it. Three real bugs were found and fixed along the way (tenantId derivation, AD's GeneralizedTime timestamp format, an async client-shutdown race that crashed the agent on Windows). NOT verified: group-membership push from Entra, Rewst (a paid product not available to test; Inaya works with any automation platform through its open API), Okta, and HR/PSA/RMM tools, which are built as generic adapters only. Documentation labels each integration VERIFIED, PARTIAL, UNVERIFIED, UNSUPPORTED or FUTURE.",
  },
  {
    number: 25,
    title: "AI Bookkeeper — Bank Statements, Bills and Receipts Matched, Categorized and Reconciled with Human Review",
    status: ROADMAP_STATUS.LIVE,
    description:
      "The AI reads bills, receipts and bank statements, works out what each is and which payments and invoices it matches, and sends anything doubtful or risky to a person. Statements are imported (CSV and OFX/QFX), documents arrive by upload, a signed email relay or WhatsApp, every extracted figure carries where it came from, and confidence is explained and configurable (default 99 percent).",
    securityStatement: "The AI never changes an invoice, expense or payment by itself: a person confirms a match, which records a payment and creates a DRAFT expense, and marking an invoice paid is only ever proposed through the existing Controlled Actions. Risk overrides confidence: a large or unusual payment always needs a manager, however sure the AI is. Text hidden inside a document is untrusted, lowers confidence below any automatic threshold and raises an anomaly.",
    features: [
      "Duplicate-safe bank statement import (CSV and OFX/QFX), document ingestion with malware scan, magic-byte checks, hashing and encrypted storage, and field extraction with provenance and arithmetic validation",
      "Categorization by rule, then approved mapping, then history, then AI; payment-to-bill and receipt-to-invoice matching including part payments, over/under payments, fees, one payment covering several invoices, currency differences, and purchase-order / goods-received / bill three-way match",
      "A review queue with ten actions (approve, reject, edit, re-match, split, merge, mark duplicate, request document, defer, escalate) that learns corrections without rewriting history",
      "Anomaly signals with mandatory wording (\"Potential anomaly detected: human review required\"), configurable and audited thresholds, reports (CSV), a month-end checklist that is explicitly not a statutory close, and read-only what-if scenarios labelled SIMULATED",
      "Business Insights, AI assistant tool, a Finance Operations Manager automation template, notifications, Evidence Graph and audit chain — all reusing existing systems, with no second ledger",
    ],
    notes:
      "Verified against the real database (flow, unit and security suites, including organization and department isolation, webhook signatures and replay, and hostile files). NOT verified against real outside accounts: live bank feeds (no provider is registered; import statements instead), a live email provider, a real WhatsApp Business account (tested against a stand-in for Meta), and OCR of images and scanned PDFs (no local OCR engine; depends on the AI model and is never auto-processed). Inaya has no general ledger and none was invented; no savings figures are estimated. Excel and PDF report exports are not offered.",
  },
  {
    number: 26,
    title: "Whole-Codebase Quality Review & Hardening — Independent SQA Across the Ecosystem",
    status: ROADMAP_STATUS.IN_PROGRESS,
    description:
      "An independent quality audit that deliberately tries to break Inaya rather than re-running existing tests: every API route is probed for access-control gaps, real client tools (the official AWS command line, rclone) are driven against Inaya's storage, and the money, bridge and payment flows are attacked. Each confirmed defect is reproduced, fixed and locked in with an automated regression test, and everything is recorded in a defect registry with severity, root cause and status. Phase one is delivered; the review is continuing across the remaining repositories.",
    securityStatement: "Findings are fixed without weakening permissions, changing public behavior unnecessarily or disabling tests. No 'bug-free' claim is made: the final report states what is ready, what carries evidence-backed risk and what could not be verified.",
    features: [
      "Critical bridge fix: the relayer now signs only messages the source blockchain really emitted (verified against the real contract), and public registration routes can no longer overwrite or forge transfers",
      "Card payments settle on-chain exactly once (a retried payment notification used to settle twice) and an unpaid checkout session can no longer identify a customer",
      "Storage fixes found with the real AWS command line: object names with spaces, brackets or non-ASCII characters authenticate; large uploads complete once; presigned URLs work; ranged reads pass client validation; the S3 ETag is the content MD5; writes fall back when one storage provider is blocked",
      "Access-control fixes: points, node assignment, the test faucet, the public node listing and anonymous endpoints; signatures with far-future timestamps no longer stay valid forever",
      "Two whole-product sweeps guard the result: no company can reach another company's data through any of 453 organization routes, and no other route changes anything for an anonymous visitor (225 routes); all cron routes refuse a wrong secret",
      "Test-suite health: the standard contract test run works again (175 passing), a test-runner hang that would freeze automated checks was fixed, and non-breaking dependency fixes were applied",
    ],
    notes:
      "In progress. Done: main dApp routes, bridge, payments, S3 layer against the AWS CLI and rclone, contract suite, dependency audit. Still to do: Azure, Google Cloud Storage and Terraform against Inaya storage with their real tools; mobile, desktop and Inaya Drive on real devices (needs hardware); concurrency and failure injection; smart-contract static analysis; performance; CI review; and a complete re-run of the 179 test files. Open risks recorded: wallet-address metadata reads are unauthenticated by design, card-customer identity is the payer's email, the main dApp is on a Next.js version whose fix needs a major upgrade, and deleting an object does not yet unpin its provider copy. Provider plan limits (Pinata blocked, Filebase at its 500-pin free limit) need the owner's action.",
  },
  {
    number: 27,
    title: "Managed Database, Document Intelligence & AI/ML Studio",
    status: ROADMAP_STATUS.LIVE,
    description:
      "A real, provisioned PostgreSQL database managed from inside the Business Workspace; a general document-understanding studio that reads any document, not just invoices; and an AI workbench for cataloguing data, checking its quality, registering models, and running one governed piece of code at a time in an isolated, disposable sandbox.",
    securityStatement: "Provisioning a database and running code are owner/admin-only, rate-limited and fully audited. The sandbox never receives Inaya's own server secrets and has no internet access unless a person explicitly turns it on for one run. Inaya does not train AI models on its own infrastructure — registering a model tracks a real file a team already produced elsewhere.",
    features: [
      "Databases: provision, start, stop, list backups, restore to a point in time, and query a real PostgreSQL database through a real external provider (Supabase) — Inaya's own serverless hosting cannot run a database engine itself",
      "Document Intelligence: built-in readers for invoices, purchase orders, receipts and contracts, plus custom analyzers with a real draft-to-live lifecycle; every extracted field shows its confidence and whether it was actually found in the document's own text",
      "Human corrections are added to the record, never overwriting the original extraction",
      "AI/ML Studio: a data and model catalogue verified against real sources, automatic data-quality checks, a model registry with real artifact hashing, and named evaluation metrics reported separately, never as one score",
      "A single governed way to run one Python or Node.js snippet in a fresh, network-off-by-default sandbox that is destroyed the instant it finishes — deliberately not a persistent notebook",
    ],
    notes:
      "Live. 26 real tests passing across all three workstreams, including live runs against a real, disposable cloud sandbox created and destroyed for each test — not simulated. A real bug (an Evidence Graph collection-name mismatch) was found and fixed by the tests before shipping. Not built: read replicas / failover for the managed database (not yet verified through a real incident), and REGEX-type data-quality rules (the reference SQL connector has no portable REGEXP).",
  },
  {
    number: 28,
    title: "Secure Collaboration & Enterprise Governance — Competitive Expansion",
    status: ROADMAP_STATUS.IN_PROGRESS,
    description:
      "A competitive-expansion layer inspired by the strongest patterns of two well-known products — private end-to-end encrypted collaboration (chat, notes, sharing), and the controls a large organization needs (governance, classification, device management, compliance readiness) — built inside Inaya's existing encrypted storage and permission model rather than as a separate product. Every capability here is off by default; an organization turns it on for itself.",
    securityStatement:
      "Chat and notes are end-to-end encrypted on the device; an administrator cannot read them. Nothing here is claimed as a government certification or an independently audited cryptographic protocol unless it actually is one.",
    groups: [
      {
        title: "Secure Chat & Notes",
        items: [
          "End-to-end encrypted chat on the MLS group-messaging standard (RFC 9420)",
          "Contacts, groups, organization-wide chats, mute, archive, unread counts",
          "Encrypted attachments, device-local drafts and search",
          "Encrypted notes with history, tags and sharing",
        ],
      },
      {
        title: "Sharing & Governance",
        items: [
          "Expiring, password-protected, watermarked and revocable share links",
          "Secure external file requests and file locks",
          "Classification, data-loss rules, retention and legal hold",
          "Data Room 2.0 and a secure document viewer",
        ],
      },
      {
        title: "Devices & Infrastructure",
        items: [
          "Device inventory, trust/block/revoke, ransomware behavior signals",
          "Endpoint backup with restore jobs",
          "Sovereign Gateway — an on-premises connector agent for a company's own file servers",
          "Site replication, Microsoft 365/Outlook integration, customer portal file requests",
        ],
      },
      {
        title: "Compliance & Developer Tools",
        items: [
          "Readiness against the NIST 800-53 control catalogue (no certification claimed)",
          "Customer-managed encryption keys",
          "Webhooks, admin dashboard, branding, unified search",
          "Public API, SDK, and CLI coverage for all of the above",
        ],
      },
    ],
    notes:
      "Built across 26 workstreams and deployed to the live website behind off-by-default feature flags, 3–5 October 2026. Honest ledger of 114 tracked deliverables: 49 finished and independently checked against the real database and, where there's a screen, a real browser; 35 built and tested in code but not yet proven against a real outside system; 27 partly built; 3 not built (mobile chat and push notifications — left for later by deliberate choice, not an oversight). The Sovereign Gateway, NTFS/Active-Directory folder-permission bridge, high-availability site replication, and Microsoft 365/Outlook integration are built and tested but not yet proven against a real company file server or a real Microsoft 365 tenant. The chat protocol's open-source library implementation has not had an independent security audit. The project's own final verification report states plainly that the SOW is not yet complete — this stage stays IN_PROGRESS until it is.",
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
