// src/lib/whyInaya/content.js -- Why Inaya Business OS (SOW 24 Nov 2026): the ONE source for every public claim on
// /business/why-inaya and in the AI explainer. Each capability carries its availability state and evidence; prices are
// never copied here -- they come from orgPlans.js / pkPricing.js / commercePricing.js via pricing.server.js (pricingFacts()).
// States (SOW 3.2): LIVE, CONDITIONS (live with conditions), BETA, PENDING (verified, release pending), PLANNED, NOT_SUPPORTED.

export const STATE_LABEL = { LIVE: "Live", CONDITIONS: "Live with conditions", BETA: "Beta (pilot)", PENDING: "Verified, release pending", PLANNED: "Planned", NOT_SUPPORTED: "Not supported" };

export const DEMOS = {
  commerce: { title: "Commerce demo: point of sale, inventory, Shopify & WooCommerce", minutes: 8, url: "https://youtu.be/RAvo3aBexHA", id: "RAvo3aBexHA" },
  ransomware: { title: "Ransomware recovery demo: restore instead of paying", minutes: 4, url: "https://youtu.be/MEpudvUaxyo", id: "MEpudvUaxyo" },
};
export const GUIDE_URL = "/docs/inaya-business-os-user-guide.pdf";

// Capability register (SOW 3.2 / 7). evidence = where the claim was verified (code path, test, demo, guide).
export const CAPABILITIES = {
  finance: { name: "Finance and bookkeeping", text: "Invoices, expenses, approvals, bookkeeping and revenue reporting.", state: "LIVE", condition: "All packages", evidence: "Finance module; user guide part 2" },
  bookkeeper: { name: "AI Bookkeeper", text: "Reads bills and receipts you send in and prepares the bookkeeping entries for you to check.", state: "CONDITIONS", condition: "Suggestions need your approval; it prepares bookkeeping, it is not a full general ledger", evidence: "src/lib/bookkeeper; AI Bookkeeper SOW" },
  hr: { name: "HR and team", text: "Employee records, leave, staff documents, rosters and team chat.", state: "LIVE", condition: "All packages", evidence: "HR module; user guide part 2" },
  crm: { name: "CRM, loyalty and campaigns", text: "Customers and pipeline, appointments, loyalty, gift cards and email campaigns.", state: "CONDITIONS", condition: "Email campaigns on Business and Enterprise", evidence: "src/lib/growth; appointments SOW" },
  inventory: { name: "Inventory and purchasing", text: "Stock across branches, transfers, counts, suppliers and purchase orders.", state: "LIVE", condition: "All packages", evidence: "Inventory module; user guide part 2" },
  pos: { name: "Point of sale", text: "Tills with returns, shifts, cash control and receipts, on the same stock and books.", state: "CONDITIONS", condition: "Needs Inaya Commerce (Starter on Professional, add-on on Business, included in Enterprise)", evidence: "src/lib/commerce; Commerce demo" },
  offline: { name: "Offline selling", text: "Cash sales keep going when the internet drops: each sale is signed and encrypted on the till, then checked again by the server when the connection returns.", state: "BETA", condition: "Off by default; a manager switches it on and sets time, sale and value limits; cash sales only; pilot customers", evidence: "src/lib/commerce/offline.js; test/commerce-offline.test.mjs" },
  hardware: { name: "Till hardware", text: "Receipt printers, cash drawers, barcode labels and camera or phone scanning.", state: "BETA", condition: "Desktop app for printers and drawers; pilot customers", evidence: "desktop app 0.3.x; test-ui/hardwareBeta.test.js" },
  store: { name: "Your own web store", text: "An Inaya web store on the same products, stock and books.", state: "CONDITIONS", condition: "Needs Inaya Commerce; card payments through your own Stripe or Safepay account", evidence: "src/lib/online; online-commerce.test.mjs" },
  sync: { name: "Shopify and WooCommerce sync", text: "Products, prices, stock and orders kept in step with the Shopify or WooCommerce store you already run.", state: "CONDITIONS", condition: "Connected stores and monthly synced orders depend on the plan; extra 1,000-order blocks available", evidence: "src/lib/online/channels.js; Commerce demo" },
  aiOps: { name: "AI assistant for operations", text: "Ask about your business in plain language; it only sees what your role allows, and actions that change records wait for a person to approve them.", state: "CONDITIONS", condition: "Permission-aware; consequential actions need approval", evidence: "src/lib/ai-business-tools.js; ai-action-requests tests" },
  docsAi: { name: "Docs Assistant and document intelligence", text: "Answers questions from the product guide and helps with documents.", state: "LIVE", condition: "", evidence: "RAG over the user guide" },
  docs: { name: "Documents and approvals", text: "Company documents encrypted on your own device before upload, with review and sign-off.", state: "LIVE", condition: "Client-side encryption applies to documents, not to every kind of record", evidence: "Document module; security page" },
  resilience: { name: "Ransomware resilience", text: "Immutable snapshots, detection of mass-encryption behaviour, containment and tested rollback, so you restore your data instead of paying.", state: "LIVE", condition: "Recovery is tested; no system can promise that an attack never causes disruption", evidence: "Ransomware demo; resilience SOW (f347525)" },
  storage: { name: "Storage, backup and Sovereign NAS", text: "S3-compatible storage, Cloud Backup and the Sovereign NAS on the same encrypted infrastructure.", state: "CONDITIONS", condition: "Storage amount and products depend on the package", evidence: "NAS test suites; storage plans" },
  audit: { name: "Audit trail, roles and approvals", text: "Who did what and when, staff roles, approval steps, and till, shift and cashier accountability for every sale.", state: "LIVE", condition: "Per-branch reports are live; per-branch user permission scoping is not claimed", evidence: "org-activity-log; commerce shifts" },
  editions: { name: "Industry editions", text: "Editions for general business, healthcare, legal, regulated enterprise, financial services, private capital, government, education and hospitality.", state: "LIVE", condition: "Edition features vary; see the product guides", evidence: "Industry editions shipped (Education, Hospitality and others)" },
  apps: { name: "Web, Windows and Android", text: "Use it in the browser, the Windows desktop app or the Android app.", state: "LIVE", condition: "Till hardware features are Beta", evidence: "desktop 0.3.2; Android app" },
};

// Differentiators, ranked by verified distinctiveness and customer relevance (SOW 4.2 B).
export const DIFFERENTIATORS = [
  { id: "connected", icon: "🔗", title: "One system instead of five", text: "Finance, HR, customers, stock, purchasing, documents, the till and online selling share the same records, so a sale updates stock, the customer and the books once.", caps: ["finance", "inventory", "crm", "pos"], link: { href: "/business/demo", label: "Watch the demo" } },
  { id: "omni", icon: "🛒", title: "Counter and online on the same stock", text: "Your till, your own web store and your Shopify or WooCommerce store draw from one stock count and one set of books.", caps: ["pos", "store", "sync"], link: { href: DEMOS.commerce.url, label: "Commerce demo (8 min)" } },
  { id: "resilience", icon: "🛡️", title: "Restore instead of paying a ransom", text: "Immutable snapshots, detection and tested rollback are built in, not an extra product.", caps: ["resilience", "docs"], link: { href: DEMOS.ransomware.url, label: "Recovery demo (4 min)" } },
  { id: "offline", icon: "📶", title: "Keep selling when the internet drops", text: "Signed, encrypted offline cash sales that the server re-checks before they count.", caps: ["offline"], beta: true, link: { href: GUIDE_URL, label: "How it works (guide)" } },
  { id: "ai", icon: "🤖", title: "AI that knows its limits", text: "Business-aware assistants that see only what your role allows, and never change records without a person's approval.", caps: ["aiOps", "bookkeeper", "docsAi"], link: null },
  { id: "control", icon: "🧾", title: "Accountability at every till", text: "Audit trail, approvals and per-till, per-shift, per-cashier records, with reports per branch and for the whole company.", caps: ["audit"], link: null },
];

// Connected-platform model (SOW 4.2 C). Flows are labelled with how they actually move.
export const PLATFORM = {
  areas: [
    { id: "back", title: "Back office", items: ["Finance and books", "HR and team", "CRM and campaigns", "Inventory and purchasing", "Documents and approvals", "Reports"] },
    { id: "front", title: "Front office", items: ["Point of sale and tills", "Shifts, cash and returns", "Receipts and hardware (Beta)", "Offline selling (Beta)"] },
    { id: "online", title: "Online selling", items: ["Your Inaya web store", "Shopify sync", "WooCommerce sync"] },
    { id: "core", title: "Intelligence and protection", items: ["AI assistants (approval for changes)", "Roles and audit trail", "Document encryption on your device", "Snapshots and tested rollback"] },
  ],
  flows: [
    { from: "front", to: "back", label: "Each sale updates stock, customer and books at once" },
    { from: "online", to: "back", label: "Web-store orders: at once. Shopify / WooCommerce: synced in the background" },
    { from: "front", to: "online", label: "One stock count for till and online" },
    { from: "core", to: "back", label: "Protects and audits every area" },
  ],
};

// Team (SOW 3.4 / 4.2 D). Owner approved 24 Nov 2026: names, titles and the bios already published on /about; no photos.
export const TEAM = [
  { name: "Talha Waqas", title: "Founder & CTO", bio: "Core system architect, smart contract architect and lead full-stack engineer, specialising in browser-side cryptography, EVM smart contracts and client-side encrypted storage." },
  { name: "Yakub Adnan", title: "Co-Founder & Growth Lead", bio: "Growth operator and community strategist, specialising in DePIN, user acquisition and AI-driven ecosystem scaling." },
  { name: "Fibha Urooj", title: "Chief Financial Officer", bio: "B.Com in Accounting & Finance. Leads financial planning, budgeting, compliance and operational finance." },
];
