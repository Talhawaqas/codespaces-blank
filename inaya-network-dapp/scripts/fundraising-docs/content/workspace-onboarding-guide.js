// scripts/fundraising-docs/content/workspace-onboarding-guide.js
//
// Business Workspace onboarding guide (16 Nov 2026), written for new customers ahead of the
// 1 January 2027 launch. One source for two outputs:
//   - PDF:      node scripts/fundraising-docs/generate-one.mjs workspace-onboarding-guide
//   - Markdown: node scripts/fundraising-docs/onboarding-guide-to-md.mjs  (public/docs/business-workspace-guide.md,
//               the "Download the step-by-step setup guide" link and an AI assistant source)
// Menu names match the Workspace sidebar (src/lib/navigation/launcher.js FRIENDLY_LABELS).
// Prices, users and storage come from src/lib/orgPlans.js and src/lib/pkPricing.js: change them there first.

export const workspaceOnboardingGuide = {
  cover: {
    company: "INAYA NETWORK",
    classification: "CUSTOMER GUIDE",
    kicker: "GETTING STARTED",
    title: "Inaya Business Workspace Onboarding Guide",
    subtitle: "From creating your company to running daily work: documents, customers, finance, people, stock and purchasing in one encrypted workspace.",
    stats: [
      { value: "1 day", label: "for our team to contact you after your package request" },
      { value: "$7.99", label: "a month for Starter (PKR 8,000 in Pakistan)" },
      { value: "3 ways", label: "to work: web, desktop (Windows, Linux) and Android" },
      { value: "9", label: "industry editions, from healthcare to hospitality" },
    ],
    docLine: "Document INAYA-WORKSPACE-ONBOARDING-2026 · For customers · November 2026",
  },
  docId: "INAYA-WORKSPACE-ONBOARDING-2026",
  sections: [
    {
      number: "01",
      title: "Welcome",
      blocks: [
        { type: "lead", text: "Inaya Business Workspace is an ERP-style workspace for running your company day to day: documents and approvals, customers and sales, finance, people, stock, purchasing, tasks, insights and team chat, in one place. Every file is encrypted on your own device before it is uploaded." },
        {
          type: "bullets",
          items: [
            "No wallet, token or technical setup: everyone signs in with their work email or Google account.",
            "Works on the web, as a desktop app for Windows and Linux, and on Android.",
            "Packages are paid in USD (or PKR in Pakistan) by NayaPay or bank transfer. No card needed.",
            "Help is built in: press \"? Help\" at the top of the Workspace at any time.",
          ],
        },
      ],
    },
    {
      number: "02",
      title: "Create Your Company",
      blocks: [
        {
          type: "steps",
          items: [
            "Go to inayanetwork.com/business.",
            "Press \"Create a company\".",
            { heading: "Name and business type.", body: "Enter your company name and choose your business type: general business, healthcare, legal, regulated enterprise, financial services, private capital, government, education or hospitality. The type decides which industry modules you see, and you can change it later in Settings." },
            { heading: "Your email.", body: "Enter your work email and press \"Create company\", or use \"Continue with Google\"." },
            { heading: "Sign in.", body: "Open the sign-in link we email you. If it has not arrived within a few minutes, check your spam folder." },
          ],
        },
      ],
    },
    {
      number: "03",
      title: "Choose Your Package",
      blocks: [
        { type: "lead", text: "A new company starts on the package screen. Your workspace opens once your package is paid and activated." },
        {
          type: "table",
          headers: ["Package", "Users included", "Storage", "USD a month", "USD a year", "PKR a month (Pakistan)"],
          rows: [
            ["Starter", "2", "250 GB", "$7.99", "$79", "PKR 8,000"],
            ["Professional", "5", "1 TB", "$28", "$280", "PKR 20,000"],
            ["Business", "10", "5 TB", "$49.99", "$499", "PKR 30,000"],
            ["Enterprise", "25", "10 TB", "$799", "$7,990", "PKR 60,000"],
          ],
        },
        {
          type: "steps",
          items: [
            "Press \"Request activation\" on the package you want.",
            { heading: "Tell us how to reach you.", body: "Your name, phone or WhatsApp number, company size (optional), how you would like to be contacted, and whether you will pay by NayaPay or bank transfer." },
            "Press \"Send request\". A confirmation email arrives straight away.",
            "Our team contacts you within one working day and emails an invoice with the payment details.",
            { heading: "Pay and start.", body: "Pay using the invoice number as the reference. We activate your package as soon as the payment arrives and email you when it is active." },
          ],
        },
        { type: "note", label: "Pakistan:", text: "packages are invoiced in PKR, with a one-time setup fee of PKR 10,000 for Starter and PKR 25,000 for the other packages. Pilot companies pay 30% less for the first 6 months and a lower setup fee (PKR 7,500 or 12,500)." },
        { type: "note", label: "Later:", text: "add extra users (up to 3 on Starter, 10 on Professional, 15 on Business, 20 on Enterprise) or change package from Settings, then Billing. Owners and admins can also download all of the company's data as a ZIP file there." },
      ],
    },
    {
      number: "04",
      title: "Find Your Way Around",
      blocks: [
        { type: "lead", text: "The first time you open the Workspace, it asks what you will mainly use Inaya for (running the business, finance and invoicing, secure files, or IT and security) and pins the matching apps to your sidebar. You can skip it and change your pins at any time." },
        {
          type: "table",
          headers: ["Where", "What it is for"],
          rows: [
            ["Home", "What needs your attention today and a snapshot of the business"],
            ["Sidebar", "Your everyday areas: Tasks, Documents, Customers, Finance, Inventory, Purchasing, People, Insights and Chat"],
            ["All apps", "Every module your company has, with search; pin the ones you use most to the sidebar"],
            ["Search (Ctrl+K)", "Jump to any screen or record by typing"],
            ["Light / Dark / Neon", "Choose the look you prefer"],
            ["ERP mode", "A classic desktop-ERP layout with module tiles and a task panel, for larger screens"],
            ["? Help", "The support assistant: it checks your account and fixes common problems, or passes them to our team"],
          ],
        },
      ],
    },
    {
      number: "05",
      title: "Set Up Your Company",
      blocks: [
        {
          type: "steps",
          items: [
            { heading: "Settings:", body: "check your company name and business type." },
            { heading: "Departments:", body: "create departments that match how your company works, for example Finance, Sales, Operations and HR." },
            { heading: "Projects:", body: "create projects inside departments. Projects are where related documents live." },
            { heading: "Settings, Team:", body: "invite colleagues by email and choose their role (Member or Admin) and departments. They show as Pending until they accept." },
          ],
        },
        { type: "note", text: "Owners and admins manage the whole company; members work within the departments they are given. Each package includes a number of users, and you can add extra users from Billing." },
      ],
    },
    {
      number: "06",
      title: "Documents and Approvals",
      blocks: [
        {
          type: "steps",
          items: [
            "Open Documents, choose the department and project, and upload a file.",
            "Choose who can see it: only you and the people you add, the whole department, or the project team.",
            { heading: "Set a passkey.", body: "The file is encrypted on your device with it before upload. Keep it safe: it cannot be recovered, and nobody at Inaya can read your files." },
            "Submit the document for review. Owners and admins approve or reject it from Approvals; every step is recorded in Activity.",
            "To share a document outside the company, create a secure share link with an expiry and an optional use limit. You can revoke it at any time.",
          ],
        },
      ],
    },
    {
      number: "07",
      title: "Run the Business",
      blocks: [
        {
          type: "table",
          headers: ["Area", "Start with"],
          rows: [
            ["Customers", "Add your contacts and deals; book appointments and send email campaigns"],
            ["Finance", "Create your first invoice, record expenses and see revenue and what is outstanding"],
            ["People", "Add employees, manage leave requests and keep staff documents in one place"],
            ["Inventory", "Add products, warehouses and stock levels, and record stock movements"],
            ["Purchasing", "Add suppliers, raise purchase requests and turn approved ones into purchase orders"],
            ["Tasks", "Assign work with due dates and follow progress"],
            ["Insights", "Dashboards and reports across the company"],
            ["Chat", "Encrypted team messaging next to the work"],
          ],
        },
        { type: "note", text: "Industry editions add their own modules, for example patients and appointments for healthcare, classes and fees for education, or reservations and tables for hospitality." },
      ],
    },
    {
      number: "08",
      title: "Your First Week",
      blocks: [
        {
          type: "steps",
          items: [
            { heading: "Day 1:", body: "create your company, request your package, and set your company name and business type." },
            { heading: "Day 2:", body: "create departments and projects, and invite two or three colleagues." },
            { heading: "Day 3:", body: "add your customers and products." },
            { heading: "Day 4:", body: "send your first invoice and assign your first tasks." },
            { heading: "Day 5:", body: "upload key documents and run one through approval." },
            { heading: "Day 6:", body: "install the desktop or Android app for your team." },
            { heading: "Day 7:", body: "open Insights and Home to see the week at a glance." },
          ],
        },
      ],
    },
    {
      number: "09",
      title: "Help and Security",
      blocks: [
        {
          type: "bullets",
          items: [
            "Press \"? Help\" in the Workspace: the support assistant can set a missing company name, change your business type, re-send a lost invitation and answer how-to questions. Anything else goes to our team.",
            "Email contact@inayanetwork.com. We reply within one working day. In Pakistan we also answer on WhatsApp, Monday to Saturday, 10:00 to 19:00 PKT.",
            "Your files are encrypted on your own device, and your company's records are backed up every day.",
            "Owners and admins can download all company data as a ZIP file at any time from Settings, then Billing.",
          ],
        },
      ],
    },
  ],
};
