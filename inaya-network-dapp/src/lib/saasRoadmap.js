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
//   - Stage 4 (AI Business Assistant) is real and shipped, but ONLY in the
//     web Business Workspace (/business, POST /api/ai/business-chat). The
//     mobile app's existing "Ask AI" screen is a separate, general docs
//     assistant (/api/ai/chat) with no business-workspace awareness —
//     extending the permission-aware business assistant to mobile has NOT
//     shipped yet, so it's listed as a Stage 5 item, not a Stage 4 claim.
//   - Stages 5-8 (Business Operations, Finance/HR, BI, AI-powered
//     operations) are none of them implemented — no backend, no schema,
//     no routes exist for any of it. They're roadmap direction only.

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
    ],
    tools: ["list_documents", "list_departments", "list_projects", "get_activity", "get_document_access"],
    notes:
      "Live today in the web Business Workspace. The mobile app currently has a separate general-purpose assistant without business-workspace awareness — bringing this same permission-aware assistant to mobile is a near-term goal (Stage 5).",
  },
  {
    number: 5,
    title: "Business Operations",
    status: ROADMAP_STATUS.NEXT,
    description: "Expand Inaya from document management into the operational systems businesses use every day.",
    groups: [
      { title: "Projects & Tasks", items: ["Tasks", "Assignments", "Deadlines", "Status tracking", "Team collaboration"] },
      { title: "CRM", items: ["Customers", "Leads", "Deals", "Customer records", "Sales pipeline"] },
      { title: "Procurement", items: ["Suppliers", "Purchase requests", "Purchase orders", "Approval workflows"] },
      { title: "Inventory", items: ["Products / items", "Stock levels", "Warehouses", "Stock movements"] },
      { title: "Mobile AI", items: ["Extend the permission-aware AI Business Assistant to the mobile app"] },
    ],
  },
  {
    number: 6,
    title: "Finance & HR",
    status: ROADMAP_STATUS.FUTURE,
    description: "Build secure financial and people-management capabilities directly into the Business Workspace.",
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
  },
  {
    number: 7,
    title: "Business Intelligence",
    status: ROADMAP_STATUS.FUTURE,
    description: "Turn business activity into dashboards and AI-generated insight.",
    features: [
      "Business dashboards",
      "Department analytics",
      "Project analytics",
      "Financial analytics",
      "Operational reporting",
      "AI-generated summaries",
      "AI business insights",
      "Natural-language reporting",
    ],
    examples: [
      "“Show me all pending approvals this month.”",
      "“Which projects have the most activity?”",
      "“Summarize Finance department activity.”",
    ],
    examplesNote: "These are examples of the intended future direction, not currently available capabilities.",
  },
  {
    number: 8,
    title: "AI-Powered Business Operations",
    status: ROADMAP_STATUS.FUTURE,
    description:
      "The long-term direction for AI in the Business Workspace: proposing actions, not just answering questions.",
    features: [
      "AI workflow assistance",
      "AI-generated reports",
      "AI document summaries",
      "AI task creation",
      "AI workflow recommendations",
      "AI-assisted procurement",
      "AI-assisted CRM",
      "AI-assisted finance",
      "AI-assisted HR",
      "Controlled AI actions",
    ],
    securityStatement: "AI proposes → User confirms → Server validates permissions → Action executes → Activity log records it",
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
