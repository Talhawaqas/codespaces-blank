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
    status: ROADMAP_STATUS.IN_PROGRESS,
    description:
      "A third and fourth vertical specialization of the Business Workspace — Financial Services OS (hedge funds/asset managers), Private Capital OS (PE/VC), and Regulated Enterprise OS (cross-industry compliance for banks, insurers, pharma, and other regulated organizations) — sharing one platform core with Health OS and Legal OS.",
    securityStatement: "A framework or control mapping is never presented as a compliance certification — and a control with no test on file shows as \"unknown,\" never as passing.",
    features: [
      "Regulatory Framework Engine — pluggable reference mappings (NIST CSF 2.0, ISO 27001, SOC 2, DORA, GDPR, GLBA/Reg S-P, SEC IA) with an explicit compliance-is-not-certification disclaimer",
      "Compliance Control Library with requirement linkage and effectiveness tracking",
      "Evidence vault with per-item review and expiry tracking",
      "Findings & Remediation workflow (a failed control test auto-opens a finding)",
      "Versioned Policy Management — a published policy is immutable; changes only ever create a new version",
      "Compliance exceptions / risk acceptance — every exception requires an expiry, no permanent silent exceptions",
      "Internal audit plans, sharing one finding lifecycle with control testing",
      "Regulatory Examination Workspace with its own scoped, time-limited, one-time-use external examiner access links",
      "Continuous Compliance dashboard — controls passing/failing/unknown are always reported separately, never merged",
      "Vertical-locked API — a general or mismatched-vertical org is rejected, not just hidden from",
      "Compliance AI assistant (read/summarize/flag only — cannot certify compliance or guarantee an audit outcome)",
    ],
    notes:
      "This is the first slice (Phase 0 + Phase 4 of a much larger SOW) — the shared Regulated Enterprise Control Plane that the SOW's own Financial Services and Private Capital verticals are meant to build on next, rather than each reinventing compliance logic. Live-verified end-to-end against the running app: control creation and activation, a failing test auto-opening a finding and walking its full state machine to closed, the dashboard's unknown/failing/passing distinction, the full policy lifecycle including the immutability guard and amend-creates-a-new-version behavior, and an examiner magic-link's issue/exchange/one-time-use cycle. Not yet built: the fund/portfolio/investment-research core (Financial Services OS), the deal/diligence/portfolio-company core (Private Capital OS), and everything in the SOW's remaining eight phases (security & resilience hardening, role-specific AI copilots, third-party integrations, executive/board reporting, external data rooms, and enterprise hardening) — those are planned, not built, and nothing here should be read as claiming otherwise. No compliance certification of any kind exists or is claimed.",
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
