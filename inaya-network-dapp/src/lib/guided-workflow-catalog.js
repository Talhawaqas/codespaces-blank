// src/lib/guided-workflow-catalog.js
//
// AI-Powered Business Workspace SOW — the declarative catalog every
// guided task reads from. Pure data, no DB access, no LLM calls: this is
// the structural fix for "AI hallucination/incorrect-action prevention"
// (SOW §8) — the model never generates step instructions, it only ever
// relays what's authored here, verbatim, one step at a time. Every
// instruction below was written directly from the real, currently-shipping
// UI paths (button labels, tab names, field order), not from a general
// description of the feature.
//
// completion.type is one of:
//   "nav"           — satisfied when the client's activeView matches
//                      completion.view (fired as the global
//                      "inaya:guided-nav" CustomEvent from page.js). A
//                      null view with match:"any" means "any navigation
//                      away from the current screen counts" (used by
//                      find_business_record, where a search result can
//                      legitimately land on any of 16 different views).
//   "custom-event"  — satisfied when the named window CustomEvent fires
//                      (a handful of view files dispatch these at real
//                      success points — see the components listed next to
//                      each event name below).
//   "manual-confirm"— the user clicks "I did this" in the GuidedTaskPanel.
//                      This is the deliberate fallback for every step not
//                      worth deep instrumentation — SOW §2 explicitly
//                      allows a guided step to "detect/receive" completion,
//                      not only auto-detect it.
//
// Adding a new workflow is always: author a plain steps[] array using this
// same shape, from a real, currently-true UI path — never invent one.

export const GUIDED_WORKFLOWS = {
  create_purchase_order: {
    key: "create_purchase_order",
    label: "Create a purchase order",
    description: "Create a new PO for a supplier with line items.",
    steps: [
      {
        id: "nav-procurement",
        instruction: "Click **Procurement** in the left sidebar.",
        completion: { type: "nav", view: "procurement" },
      },
      {
        id: "orders-tab",
        instruction: "Click the **Orders** tab at the top (Procurement opens on Suppliers by default).",
        completion: { type: "manual-confirm", hint: "Look for three tabs: Suppliers, Requests, Orders." },
      },
      {
        id: "click-new-po",
        instruction: "Click **+ New PO** in the top-right of the Orders tab.",
        completion: { type: "manual-confirm" },
      },
      {
        id: "fill-department-supplier",
        instruction: "Choose the **Department** first, then choose a **Supplier** from that department's list. (If no supplier exists yet, ask me to walk you through creating one instead.)",
        completion: { type: "manual-confirm" },
      },
      {
        id: "add-line-items",
        instruction: "Fill in at least one line item: **Description**, **Qty**, and **Unit price**. Click **+ Add item** if you need more than one line.",
        completion: { type: "manual-confirm" },
      },
      {
        id: "submit-po",
        instruction: "Click the submit button at the bottom of the form to create the purchase order — it starts in DRAFT status.",
        completion: { type: "custom-event", eventName: "inaya:guided-po-created" },
      },
    ],
  },

  create_contact: {
    key: "create_contact",
    label: "Create a customer or contact",
    description: "Create a new CRM contact (lead or customer).",
    steps: [
      { id: "nav-crm", instruction: "Click **CRM** in the left sidebar.", completion: { type: "nav", view: "crm" } },
      { id: "contacts-tab", instruction: "Make sure the **Contacts** tab is selected (it's the default).", completion: { type: "manual-confirm" } },
      { id: "click-new-contact", instruction: "Click **+ New contact** in the top-right.", completion: { type: "manual-confirm" } },
      { id: "fill-contact-form", instruction: "Choose a **Department**, choose **Type** (Lead or Customer), and fill in **Name**. Company/Email/Phone are optional.", completion: { type: "manual-confirm" } },
      { id: "submit-contact", instruction: "Click **Create contact** to save it.", completion: { type: "custom-event", eventName: "inaya:guided-contact-created" } },
    ],
  },

  create_deal: {
    key: "create_deal",
    label: "Create a deal",
    description: "Create a new sales pipeline deal tied to an existing contact.",
    steps: [
      { id: "nav-crm", instruction: "Click **CRM** in the left sidebar.", completion: { type: "nav", view: "crm" } },
      { id: "deals-tab", instruction: "Click the **Deals** tab at the top.", completion: { type: "manual-confirm" } },
      { id: "click-new-deal", instruction: "Click **+ New deal**.", completion: { type: "manual-confirm" } },
      {
        id: "fill-deal-form",
        instruction: "Choose a **Department** (this loads that department's contacts), then choose the **Contact** the deal is for. A deal must be tied to an existing contact — if you haven't created one yet, ask me to walk you through that first. Then fill in a **Title** and, optionally, a **Value**.",
        completion: { type: "manual-confirm" },
      },
      { id: "submit-deal", instruction: "Click **Create deal** — it starts at the NEW stage.", completion: { type: "custom-event", eventName: "inaya:guided-deal-created" } },
    ],
  },

  receive_inventory: {
    key: "receive_inventory",
    label: "Receive inventory",
    description: "Record a stock movement (receive, issue, or adjust) for a product.",
    steps: [
      { id: "nav-inventory", instruction: "Click **Inventory** in the left sidebar.", completion: { type: "nav", view: "inventory" } },
      { id: "products-tab", instruction: "Make sure you're on the **Products** tab (it's the default).", completion: { type: "manual-confirm" } },
      { id: "click-product", instruction: "Click the product you want to receive stock for.", completion: { type: "manual-confirm" } },
      {
        id: "fill-movement-form",
        instruction: "In the **Record a movement** form, choose the **Warehouse**, set the type to **Stock in**, and enter the **Quantity**. A note is optional.",
        completion: { type: "manual-confirm" },
      },
      { id: "submit-movement", instruction: "Click **Record movement**.", completion: { type: "custom-event", eventName: "inaya:guided-movement-recorded" } },
    ],
  },

  create_document: {
    key: "create_document",
    label: "Create a document",
    description: "Upload and register a new encrypted document.",
    steps: [
      { id: "nav-documents", instruction: "Click **Documents** in the left sidebar.", completion: { type: "nav", view: "browse" } },
      { id: "pick-department", instruction: "Pick a **Department** in the first column (or click **+ New** to create one).", completion: { type: "manual-confirm" } },
      { id: "pick-project", instruction: "Pick a **Project** in the second column (or click **+ New** to create one).", completion: { type: "manual-confirm" } },
      {
        id: "fill-upload-form",
        instruction: "In the third column, choose your file, set an **Encryption passkey** (remember it — it's needed to decrypt the file later), and choose an **Access level** (Private, Department, or Project).",
        completion: { type: "manual-confirm" },
      },
      { id: "submit-upload", instruction: "Click **Upload document**. It'll be encrypted and sharded in your browser before it's registered — this can take a moment for larger files.", completion: { type: "manual-confirm" } },
    ],
  },

  submit_approval: {
    key: "submit_approval",
    label: "Submit an approval",
    description: "Route to the right module to approve or reject a pending item — there's no single unified approvals inbox, so which module depends on what you're approving.",
    steps: [
      {
        id: "identify-kind",
        instruction: "What are you approving — a document, a purchase order or request, an expense or invoice, or a leave request? Each lives in its own module.",
        completion: { type: "manual-confirm" },
      },
      {
        id: "nav-to-module",
        instruction: "Go to the matching sidebar item: **Approvals** for documents, **Procurement** for purchase orders/requests, **Finance** for expenses/invoices, or **HR** for leave requests.",
        completion: { type: "manual-confirm", hint: "This step auto-advances once you navigate to any of those screens." },
      },
      {
        id: "decide",
        instruction: "Find the pending item and click **Approve** or **Reject** (documents also offer **Start review** first).",
        completion: { type: "manual-confirm" },
      },
    ],
  },

  review_ai_action: {
    key: "review_ai_action",
    label: "Review an AI-proposed action",
    description: "Approve, reject, or cancel an action the AI assistant proposed on someone's behalf.",
    steps: [
      { id: "nav-ai-actions", instruction: "Click **AI Action Requests** in the left sidebar.", completion: { type: "nav", view: "aiActions" } },
      { id: "find-request", instruction: "Find the pending request you want to review — it shows who requested it, what it does, and its risk level (Low/Medium/High).", completion: { type: "manual-confirm" } },
      {
        id: "decide",
        instruction: "Click **Approve** to allow it (it won't actually execute for 36 hours, giving time to reconsider) or **Reject** to deny it. If you already approved something and change your mind before it unlocks, use **Cancel** instead.",
        completion: { type: "manual-confirm" },
      },
    ],
  },

  generate_business_report: {
    key: "generate_business_report",
    label: "Generate a business report",
    description: "Generate and download a real financial report (revenue, expenses, outstanding invoices).",
    steps: [
      { id: "nav-finance", instruction: "Click **Finance** in the left sidebar.", completion: { type: "nav", view: "finance" } },
      { id: "reports-tab", instruction: "Click the **Reports** tab.", completion: { type: "manual-confirm" } },
      {
        id: "pick-report-type",
        instruction: "Pick a report type from the dropdown: Revenue (paid invoices), Approved expenses, Outstanding invoices, or All invoices. A preview appears below it.",
        completion: { type: "manual-confirm" },
      },
      { id: "download", instruction: "Click **↓ Download CSV** to export it.", completion: { type: "custom-event", eventName: "inaya:guided-report-downloaded" } },
    ],
  },

  find_business_record: {
    key: "find_business_record",
    label: "Find a business record",
    description: "Use global search to find any record you have access to.",
    steps: [
      { id: "open-search", instruction: "Press **Cmd+K** (Mac) or **Ctrl+K** (Windows), or click the **Search** button in the top header.", completion: { type: "manual-confirm" } },
      { id: "type-query", instruction: "Type part of what you're looking for — a contact name, document filename, PO supplier, invoice number, and so on. Results appear as you type.", completion: { type: "manual-confirm" } },
      { id: "select-result", instruction: "Click the result you're looking for — it'll take you to that record's module.", completion: { type: "nav", view: null, match: "any" } },
    ],
  },

  navigate_to_function: {
    key: "navigate_to_function",
    label: "Navigate to a workspace function",
    description: "Get pointed to the right sidebar item for something you want to do.",
    steps: [
      {
        id: "click-nav-item",
        instruction: "Click the sidebar item for what you need — tell me what you're trying to do if you're not sure which one.",
        completion: { type: "nav", view: null, match: "any" },
      },
    ],
  },
};

export function getGuidedWorkflow(key) {
  return GUIDED_WORKFLOWS[key] || null;
}

export function getGuidedStep(key, index) {
  const workflow = getGuidedWorkflow(key);
  if (!workflow) return null;
  return workflow.steps[index] || null;
}

export function listGuidedWorkflowKeys() {
  return Object.keys(GUIDED_WORKFLOWS);
}

export function listGuidedWorkflowSummaries() {
  return Object.values(GUIDED_WORKFLOWS).map((w) => ({ key: w.key, label: w.label, description: w.description, totalSteps: w.steps.length }));
}
