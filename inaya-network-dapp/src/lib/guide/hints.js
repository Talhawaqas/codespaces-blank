// src/lib/guide/hints.js
//
// Command Palette + Virtual Guide SOW. Per-view hint content for the
// silent visual guide (GuideHintBubble.js) -- shown when
// useStuckNavDetector decides a user keeps bouncing back to the same
// view. Hand-curated on purpose, not auto-extracted from the docs
// pipeline (explicitly out of scope per docs/command-palette-and-guide-sow.md
// -- keeps this bounded and avoids depending on docs content being
// structured for extraction). Every view not listed here still gets the
// DEFAULT_HINT fallback, so coverage is complete on day one.
//
// `workflowKey`, when present, must be a real key in GUIDED_WORKFLOWS
// (src/lib/guided-workflow-catalog.js) -- it powers the hint bubble's
// optional "Walk me through it" button, which hands off to the EXISTING
// guided-task system (POST /api/orgs/guided-tasks) rather than this
// feature re-implementing step tracking.

export const VIEW_HINTS = {
  procurement: { body: "Suppliers, Requests and Orders are separate tabs at the top of this page — a new purchase order is created from the Orders tab, not Requests.", workflowKey: "create_purchase_order" },
  crm: { body: "Add a contact first, then create a deal against them from their detail view.", workflowKey: "create_deal" },
  finance: { body: "Invoices, expenses and payments are separate sections — use the tabs at the top of this page to switch between them." },
  hr: { body: "Employee records, leave balances, and document attachments are all on one employee's detail page — click a name to see all three." },
  inventory: { body: "Receiving new stock against a purchase order updates inventory automatically — you don't need to add it manually here.", workflowKey: "receive_inventory" },
  documents: { body: "Documents are organized by Department → Project — pick those first if you don't see the file you're looking for.", workflowKey: "create_document" },
  approvals: { body: "Items waiting on your approval show here; items you've already approved or rejected move to the record's own activity history, not this list.", workflowKey: "submit_approval" },
  aiActions: { body: "AI-proposed actions sit here for review before they run — nothing the assistant suggests executes automatically.", workflowKey: "review_ai_action" },
  insights: { body: "Insights are generated from the same data every other module already shows — pick a date range at the top to change what's summarized.", workflowKey: "generate_business_report" },
};

export const DEFAULT_HINT = { body: "Press ⌘K (Ctrl+K on Windows) to jump straight to any page by name — faster than browsing the sidebar.", workflowKey: "navigate_to_function" };

export function hintFor(view) {
  return VIEW_HINTS[view] || DEFAULT_HINT;
}
