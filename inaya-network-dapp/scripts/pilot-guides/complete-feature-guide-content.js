// scripts/pilot-guides/complete-feature-guide-content.js
//
// The Complete Inaya Network Step-by-Step Guide -- covers every real,
// shipped feature across the web dApp, Business Workspace, mobile,
// desktop, and developer surfaces, organized by product area. Content
// mirrors the authoritative navigation this codebase actually ships
// (root page.js's NAV_GROUPS and business/page.js's NAV_ITEMS), not an
// aspirational feature list.

export const completeFeatureGuide = {
  cover: {
    company: "INAYA NETWORK",
    classification: "USER GUIDE",
    kicker: "COMPLETE FEATURE GUIDE",
    title: "The Complete Inaya Network Guide",
    subtitle: "Step-by-step instructions for every feature — the web dApp, Business Workspace, mobile, desktop, and developer tools.",
    docLine: "Document INAYA-GUIDE-2026-V1 · September 2026",
  },
  docId: "INAYA-GUIDE-2026-V1",
  sections: [
    // =====================================================================
    // PART A — GETTING STARTED
    // =====================================================================
    {
      number: "01",
      title: "Getting Started — Connecting Your Wallet",
      blocks: [
        {
          type: "lead",
          text: "Inaya's main web app is a decentralized application (dApp) that runs on BNB Chain Testnet. You interact with it using a crypto wallet browser extension, the same way you'd use any Web3 site.",
        },
        {
          type: "numbered",
          items: [
            { heading: "Install a wallet.", body: "If you don't already have one, install MetaMask (or any wallet that supports BNB Chain / EVM networks) as a browser extension, and create or import a wallet." },
            { heading: "Open the Inaya dApp.", body: "Go to the Inaya Network website. You'll land on the Home tab." },
            { heading: "Connect your wallet.", body: "Click \"Connect Wallet\" in the top navigation. Approve the connection request in your wallet extension's popup." },
            { heading: "Switch to BNB Chain Testnet.", body: "If your wallet isn't already on BNB Chain Testnet, the site will prompt you to switch networks, or you can add/switch to it manually from your wallet's network selector." },
            { heading: "You're in.", body: "Once connected, the navigation menu (the hamburger icon, top-right) expands to show every feature available to a connected wallet." },
          ],
        },
        {
          type: "note",
          text: "You do not need a wallet at all to use Business Workspace (Section 11 onward) — that side of Inaya uses ordinary email/magic-link sign-in, independent of crypto wallets.",
        },
      ],
    },
    {
      number: "02",
      title: "Getting Testnet Tokens (Faucet)",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Open the Faucet tab.", body: "From the main navigation menu, select \"Faucet.\"" },
            { heading: "Request tokens.", body: "With your wallet connected, click the request/claim button. This sends a small amount of testnet BNB and/or $INAYA to your connected wallet address." },
            { heading: "Wait for confirmation.", body: "The transaction confirms on-chain within a few seconds to a couple of minutes on testnet. Your wallet balance updates once it's mined." },
          ],
        },
        {
          type: "note",
          text: "The faucet has a cooldown period between claims per wallet, to prevent draining the pool — if a claim is rejected, it will tell you when you can try again.",
        },
      ],
    },
    {
      number: "03",
      title: "My Dashboard and OS Home",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "My Dashboard.", body: "Your personal overview: wallet balance, staking position summary, referral status, and recent activity, all in one place. Open it from the navigation menu." },
            { heading: "OS Home.", body: "A unified home screen that surfaces what's relevant right now across every feature you use — notifications, trust/health signals, and quick links — rather than making you check each feature's own tab individually." },
            { heading: "What Changed?", body: "A running, chronological log of everything that happened recently on your account — deposits, staking events, referral activity, notifications — useful for catching up after time away." },
          ],
        },
      ],
    },
    // =====================================================================
    // PART B — SOVEREIGN VAULT (PERSONAL ENCRYPTED STORAGE)
    // =====================================================================
    {
      number: "04",
      title: "Sovereign Vault — Uploading a File",
      blocks: [
        {
          type: "lead",
          text: "The Sovereign Vault is your personal, end-to-end encrypted file storage. Every file is encrypted in your browser before it ever leaves your device — Inaya's own servers never see the unencrypted content.",
        },
        {
          type: "numbered",
          items: [
            { heading: "Open the Sovereign Vault tab.", body: "From the navigation menu, select \"Sovereign Vault.\"" },
            { heading: "Set your passkey (first time only).", body: "The first time you use the Vault, you'll set an encryption passkey. This passkey is what derives your actual encryption key — Inaya never stores it, so write it down somewhere safe. If you lose it, files encrypted with it cannot be recovered by anyone, including Inaya." },
            { heading: "Choose a file to upload.", body: "Click the upload area or drag a file in. The file is encrypted locally in your browser, split into two halves (sharding), and each half is sent to an independent storage provider." },
            { heading: "Confirm the upload.", body: "Once both halves are stored, the file appears in your Vault's file list along with its size and upload date. A tamper-evident ownership record is written on-chain." },
          ],
        },
      ],
    },
    {
      number: "05",
      title: "Sovereign Vault — Downloading, Sharing, and Managing Files",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Download a file.", body: "Click a file in your Vault list, then \"Download.\" Both halves are fetched, reassembled, and decrypted locally in your browser using your passkey — you'll be prompted to enter it if your session doesn't already have it cached." },
            { heading: "Delete a file.", body: "Click the delete/trash icon next to a file. This is a soft delete on Inaya's own metadata; the underlying encrypted shards are removed from active serving." },
            { heading: "Check backup health.", body: "The Vault shows a health/recovery status per file, reflecting whether both of its shards are currently verified as intact across the storage providers." },
          ],
        },
        {
          type: "note",
          text: "For business use — where a whole team needs access, versioning, permissions, and folders — use Business Workspace's Documents feature (Section 13) instead of the personal Sovereign Vault.",
        },
      ],
    },
    {
      number: "06",
      title: "NFT Vault",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Open the NFT Vault tab.", body: "From the navigation menu, select \"NFT Vault,\" or go directly to the /nfts page." },
            { heading: "View your NFTs.", body: "Your connected wallet's owned NFTs (ERC-721 tokens) are discovered automatically via a real on-chain ownership check." },
            { heading: "Back up an NFT's metadata.", body: "Select an NFT and choose to back it up — its metadata and image are copied into your own encrypted Sovereign Vault storage, so you have a durable copy independent of whatever server originally hosted the image." },
          ],
        },
      ],
    },
    // =====================================================================
    // PART C — STAKING, REFERRALS, AND TOKEN FEATURES
    // =====================================================================
    {
      number: "07",
      title: "Staking $INAYA",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Open the Staking tab.", body: "From the navigation menu, select \"Staking.\"" },
            { heading: "Stake tokens.", body: "Enter the amount of $INAYA you want to stake and confirm the transaction in your wallet. Your staked balance and the network's current staking terms are shown before you confirm." },
            { heading: "Claim rewards.", body: "As rewards accrue, a \"Claim\" button becomes available — click it and confirm the transaction to move rewards into your wallet." },
            { heading: "Unstake.", body: "Request to unstake your position; depending on the contract's rules, this may involve a settlement delay before the tokens are released back to your wallet — the page shows you exactly what to expect before you confirm." },
          ],
        },
      ],
    },
    {
      number: "08",
      title: "Referrals",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Open the Referrals tab.", body: "From the navigation menu, select \"Referrals.\"" },
            { heading: "Get your referral link.", body: "Your unique referral link/code is displayed — share it with someone you want to invite." },
            { heading: "Track referrals.", body: "The page shows a leaderboard and your own referral history — who signed up through your link and what stage they're at (email/KYC verification does not require the referred person to have a wallet)." },
            { heading: "Redeem rewards.", body: "Once a referral qualifies, redeem your earned reward directly from this tab." },
          ],
        },
      ],
    },
    {
      number: "09",
      title: "Genesis Airdrop and Hackathon",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Genesis Airdrop.", body: "Open the \"Genesis Airdrop\" tab and choose the Community or Developer application form, then fill it in and submit — this registers your interest/eligibility for the token distribution event." },
            { heading: "Hackathon.", body: "Open the \"Hackathon\" tab for current or upcoming developer competition details and submission information." },
          ],
        },
      ],
    },
    {
      number: "10",
      title: "Corporate Reserve and Pay-As-You-Go Purchases",
      blocks: [
        {
          type: "lead",
          text: "Beyond the free tier, Inaya offers paid storage plans purchasable two ways: with crypto (from a connected wallet) or with a card via Stripe checkout — no wallet required for the card path.",
        },
        {
          type: "numbered",
          items: [
            { heading: "Choose a plan.", body: "From the pricing/plans area (also linked from Business Workspace's own Pricing page), select a Corporate Reserve (annual) tier or a Pay-As-You-Go allocation." },
            { heading: "Pay with crypto or card.", body: "Crypto: confirm the transaction in your connected wallet. Card: you're redirected to a secure Stripe checkout page — enter your card details there, not on Inaya's own site." },
            { heading: "Confirmation.", body: "After payment, you're redirected back to Inaya and your new storage allocation appears on your Dashboard or in Business Workspace's Billing tab." },
          ],
        },
      ],
    },
    // =====================================================================
    // PART D — BUSINESS WORKSPACE: GETTING SET UP
    // =====================================================================
    {
      number: "11",
      title: "Business Workspace — Creating Your Organization",
      blocks: [
        {
          type: "lead",
          text: "Business Workspace is Inaya's B2B product — organizations, teams, documents, and real business operations, accessed by email sign-in, independent of crypto wallets.",
        },
        {
          type: "numbered",
          items: [
            { heading: "Go to Business Workspace.", body: "Visit inayanetwork.com/business (or click \"Business Workspace\" from the main navigation)." },
            { heading: "Sign in.", body: "Enter your email address; you'll receive a magic link — click it to sign in. No password to remember." },
            { heading: "Create your organization.", body: "The first time you sign in, you'll be prompted to create an organization: give it a name and choose its vertical/industry type (General, Healthcare, Legal, Financial, Regulated Enterprise, Government, or Private Capital) if applicable." },
            { heading: "You're the owner.", body: "As the creator, you're automatically the organization's Owner — the highest permission level, able to manage every setting, invite members, and access every department." },
          ],
        },
      ],
    },
    {
      number: "12",
      title: "Departments, Projects, and Team Members",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Create a department.", body: "Open the \"Departments\" tab, click \"New Department,\" and give it a name (e.g., \"Finance,\" \"Engineering\"). Departments are the top-level access boundary — a team member only sees what's in the departments they're granted access to." },
            { heading: "Create a project.", body: "Open the \"Projects\" tab, click \"New Project,\" choose which department it belongs to, and name it." },
            { heading: "Invite a team member.", body: "From your org's member management area, enter the person's email and choose their role (Owner, Admin, or Member) and which departments they can access. They'll receive an email invite with their own magic link to sign in." },
            { heading: "Add someone to a specific project.", body: "Open a project and add a team member directly to it — this can grant them visibility into that one project even if they don't have general department-wide access." },
          ],
        },
      ],
    },
    // =====================================================================
    // PART E — DOCUMENTS AND WORKFLOW
    // =====================================================================
    {
      number: "13",
      title: "Documents — Upload, Organize, and Share",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Open the Documents tab.", body: "Navigate a department and project to find its documents, or use the top-level Documents view." },
            { heading: "Upload a document.", body: "Click \"Upload,\" choose your file, and select which project it belongs to. It's encrypted and sharded the same way Sovereign Vault files are." },
            { heading: "Set an access level.", body: "Each document can be Private (only you and people explicitly granted access), Department-level (anyone in that department), or Project-level (anyone on that project)." },
            { heading: "Grant explicit access.", body: "For a Private document, use \"Share\" to grant a specific person View, Edit, or Manage-permissions access." },
            { heading: "Create a secure external share link.", body: "Generate a time-limited, revocable link to share a document with someone outside your organization — set an expiration and optionally a maximum number of uses." },
            { heading: "View version history.", body: "Every re-upload to the same document creates a new version; open the document's history to see or restore a prior version." },
          ],
        },
      ],
    },
    {
      number: "14",
      title: "Document Approval Workflow",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Submit for review.", body: "On a document in DRAFT status, click \"Submit for Review\" to move it into the approval pipeline." },
            { heading: "Approve or request revisions.", body: "An approver (someone with the right department access) opens the \"Approvals\" tab, reviews the document, and either approves it or sends it back for revision with a note." },
            { heading: "Archive or restore.", body: "A finalized document can be archived to get it out of active lists, and restored later if needed — nothing is ever silently deleted by an archive action." },
          ],
        },
      ],
    },
    {
      number: "15",
      title: "Tasks",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Open the Tasks tab.", body: "Within a project, open Tasks to see the project's task board." },
            { heading: "Create a task.", body: "Click \"New Task,\" give it a title, description, priority, an assignee, and optionally a due date." },
            { heading: "Move a task through its lifecycle.", body: "Update its status as work progresses: To Do → In Progress → (Blocked, if stuck) → Done, or Cancelled if it's no longer needed." },
          ],
        },
      ],
    },
    // =====================================================================
    // PART F — BUSINESS OPERATIONS: CRM, PROCUREMENT, INVENTORY, FINANCE, HR
    // =====================================================================
    {
      number: "16",
      title: "CRM — Contacts and Deals",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Add a contact.", body: "Open the CRM tab, click \"New Contact,\" and enter their details. Mark them as a Lead or a Customer." },
            { heading: "Create a deal.", body: "Click \"New Deal,\" link it to a contact, and optionally to a project. Set its value and initial stage." },
            { heading: "Move a deal through the pipeline.", body: "Advance a deal through its stages: New → Qualified → Proposal → Negotiation → Won or Lost. A won or lost deal can be reopened if circumstances change." },
          ],
        },
      ],
    },
    {
      number: "17",
      title: "Procurement — Suppliers, Purchase Requests, and Purchase Orders",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Add a supplier.", body: "Open the Procurement tab and add a supplier's name and details." },
            { heading: "Create a Purchase Request.", body: "Staff who need to buy something submit a Purchase Request: what's needed, from which supplier, and the estimated cost. It starts as a Draft, then is submitted for approval." },
            { heading: "Approve a Purchase Request.", body: "A manager reviews and approves or rejects the request." },
            { heading: "Create a Purchase Order.", body: "An approved request can be converted into a formal Purchase Order with real line items (description, quantity, unit price) — or a PO can be created directly without a prior request." },
            { heading: "Move the PO through its lifecycle.", body: "Submit → Approve → Order (send to the supplier) → Receive (partially or fully) — or Reject/Cancel at an earlier stage. Receiving a line item linked to a real product and warehouse automatically updates your Inventory stock." },
          ],
        },
      ],
    },
    {
      number: "18",
      title: "Inventory — Products, Warehouses, and Stock",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Add a warehouse.", body: "Open the Inventory tab and create a warehouse — a physical or logical storage location within a department." },
            { heading: "Add a product.", body: "Create a product with a SKU, name, price, and a reorder threshold (the stock level below which you'll want a low-stock alert)." },
            { heading: "Track stock movements.", body: "Stock levels update automatically as purchase orders are received; you can also record a manual stock movement (an adjustment, a transfer between warehouses, etc.)." },
            { heading: "Watch for low-stock alerts.", body: "When a product's quantity drops below its reorder threshold, it surfaces as an alert on the Business Insights dashboard." },
          ],
        },
      ],
    },
    {
      number: "19",
      title: "Finance — Invoices and Expenses",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Create an invoice.", body: "Open the Finance tab, click \"New Invoice,\" link it to a CRM contact, and add line items. It starts as a Draft." },
            { heading: "Send and track an invoice.", body: "Move it to Sent; the system automatically marks it Overdue if its due date passes unpaid, and you mark it Paid once payment is received." },
            { heading: "Submit an expense.", body: "Any team member can submit an expense with an amount, category, and receipt; it routes to a Finance Manager (or org owner/admin) for approval before being marked reimbursed." },
          ],
        },
      ],
    },
    {
      number: "20",
      title: "HR — Employees and Leave Requests",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Add an employee record.", body: "Open the HR tab and add an employee's details, linked to their department." },
            { heading: "Manage employee status.", body: "Update an employee's status as needed — active, on leave, or terminated — each a real, auditable transition." },
            { heading: "Submit and approve leave.", body: "An employee submits a leave request with dates and a reason; an HR manager or org admin approves or rejects it." },
          ],
        },
      ],
    },
    {
      number: "21",
      title: "Inaya Sign and Milestone Escrow",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Request a signature (Inaya Sign).", body: "Open the Inaya Sign tab, upload or select a document, add the signer(s) by email, and send the signature request. Track its status until every signer has signed." },
            { heading: "Set up a Milestone Escrow.", body: "Open the Milestone Escrow tab, link it to a Purchase Order, and define payment milestones. Funds release for a milestone only once it's marked reached and a human with escrow-approval authority has approved the release — with a mandatory delay before the real payment executes, matching the same guarded-execution safety net every AI-proposed action goes through (Section 27)." },
          ],
        },
      ],
    },
    // =====================================================================
    // PART G — TRUST, EVIDENCE, AND SECURITY
    // =====================================================================
    {
      number: "22",
      title: "Business Insights, Brief, and What Changed?",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Insights.", body: "Open the Insights tab for real-time KPIs — revenue, overdue invoices, low-stock counts — and alerts sorted by severity, all computed live from your organization's own records." },
            { heading: "Brief.", body: "Open the Brief tab for a periodic (weekly/monthly) recap of what happened and what needs attention, in plain language." },
            { heading: "What Changed?", body: "Open the What Changed? tab for a running digest across every module — business activity, AI action outcomes, notification volume, and current trust/health status." },
          ],
        },
      ],
    },
    {
      number: "23",
      title: "Approvals and AI Action Requests",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Approvals.", body: "Open the Approvals tab to see every document awaiting your review across the organization, in one place." },
            { heading: "AI Action Requests.", body: "When Inaya's AI Business Assistant proposes a change on someone's behalf (e.g., \"mark this expense reimbursed\"), it never executes automatically — it appears here as a pending request. Someone with the same authority the real action would require must Approve or Reject it." },
            { heading: "The mandatory delay.", body: "Once approved, a high-risk action waits a fixed delay period (36 hours) before it actually executes — visible as a live countdown — giving time to cancel if it turns out to be a mistake." },
          ],
        },
      ],
    },
    {
      number: "24",
      title: "Evidence — Business Events, Why?, Passports, and What If?",
      blocks: [
        {
          type: "lead",
          text: "The Evidence tab connects an invoice, purchase order, or AI-proposed action to everything Inaya checked about it, in one traceable story.",
        },
        {
          type: "numbered",
          items: [
            { heading: "Open the Evidence tab.", body: "See a list of Business Events — each one tied to a real invoice, purchase order, purchase request, or AI action." },
            { heading: "Ask \"Why?\"", body: "Click into an event to see exactly what evidence, checks, and rules produced its current status and risk level — in plain language, permission-aware (something in a department you can't access shows only as existing, not its contents)." },
            { heading: "Ask \"What If?\"", body: "Choose a hypothetical action (e.g., \"approve\") and run the simulation. You'll see whether it would be legal and whether you're authorized, all clearly labeled \"SIMULATION ONLY — NO CHANGES WILL BE MADE.\" Nothing is ever actually executed by asking." },
            { heading: "Generate a Passport.", body: "Click \"Download JSON\" or \"Download PDF\" to generate a portable, cryptographically-proven evidence package for this event — hand it to an auditor or business partner without them needing account access." },
          ],
        },
      ],
    },
    {
      number: "25",
      title: "Audit Trail and Compliance Evidence Export",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Audit Trail.", body: "Open the Audit Trail tab (owner/admin only) to browse the organization's full, tamper-evident activity log — every entry is cryptographically chained to the one before it, so any alteration is detectable." },
            { heading: "Export the audit trail.", body: "Export the log as JSON or CSV for your own records or an external auditor." },
            { heading: "Compliance Evidence Exporter.", body: "Open the Compliance Evidence tab to generate a broader evidence package covering your organization's storage protection settings and security event history, alongside the audit chain — as JSON or a formatted PDF, with a cryptographic hash proving it wasn't altered after export." },
          ],
        },
      ],
    },
    {
      number: "26",
      title: "Digital Twin — Organization-Wide What If Simulation",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Simulate a supplier becoming unavailable.", body: "See which open purchase orders and products would be directly affected." },
            { heading: "Simulate an employee losing project access.", body: "See which project memberships and assigned tasks would need reassignment." },
            { heading: "Simulate a project delay.", body: "Enter a number of days; see which tasks with a real due date would shift, and by how much." },
            { heading: "Simulate a warehouse becoming unavailable.", body: "See which stock is affected." },
          ],
        },
        {
          type: "note",
          text: "Every Digital Twin result is honest about what it can't calculate — it will say \"unknown\" rather than invent a plausible-sounding number for anything not backed by real stored data. Nothing here ever changes a real record.",
        },
      ],
    },
    {
      number: "27",
      title: "Account Security, Resilience, and Cross-Org Trust",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Account Security.", body: "Open the Account Security tab to manage your own sign-in settings and multi-factor authentication." },
            { heading: "Security & Resilience Controls.", body: "(Owner/admin) Manage vendor records, IT assets, privileged access, and resilience policy in one place." },
            { heading: "Resilience Testing.", body: "(Owner/admin) Review disaster-recovery test results and RTO/RPO compliance history." },
            { heading: "Cross-Org Trust.", body: "(Owner/admin) Establish an explicit, scoped, revocable trust relationship with another Inaya organization — nothing is shared with another org by default." },
            { heading: "Activity.", body: "Browse the org-wide raw activity feed, chronologically." },
          ],
        },
      ],
    },
    // =====================================================================
    // PART H — ENTERPRISE STORAGE, INTEGRATIONS, AND DATA
    // =====================================================================
    {
      number: "28",
      title: "S3-Compatible Storage — Credentials and Buckets",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Issue a storage credential.", body: "Open the S3-Compatible Storage tab and click \"Issue Credential.\" Give it a label and, optionally, a scope (a specific bucket, a key prefix, and/or specific operations like READ-only). Copy the Access Key ID and Secret Access Key shown — the secret is only ever displayed once." },
            { heading: "Connect a real tool.", body: "Configure the AWS CLI, rclone, Terraform, or any S3-compatible SDK with your new credential and Inaya's S3-compatible endpoint URL. Run `aws s3 ls`, `aws s3 cp`, or your tool's equivalent — it behaves like ordinary S3." },
            { heading: "Manage buckets and objects.", body: "Buckets map to your organization's projects. Use your S3 tool (or the management view in this tab) to list, upload, download, and delete objects." },
          ],
        },
      ],
    },
    {
      number: "29",
      title: "S3-Compatible Storage — Tags, Versioning, Object Lock, and Batch Operations",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Tag an object.", body: "Apply labels (tags) to an object — by key/value pair — either through your S3 tool's tagging command or the management view. Use tags to organize files by project, client, or department, and to filter the Storage Inventory report." },
            { heading: "Enable Versioning.", body: "Turn on Versioning for a bucket so every overwrite keeps the prior version retrievable rather than replacing it." },
            { heading: "Enable Object Lock and set retention.", body: "With Versioning enabled, turn on Object Lock, then set a retention period (Governance or Compliance mode) on an object to prevent it from being deleted or altered until that date passes. A retention period can only be extended, never shortened." },
            { heading: "Place a Legal Hold.", body: "Place a Legal Hold on an object to block deletion indefinitely, independent of any retention date — release it explicitly when the hold is no longer needed." },
            { heading: "Run a batch operation.", body: "Select up to 1,000 objects and apply a tag, retention setting, or legal hold to all of them at once. You'll get a per-object success/failure report — a locked object correctly fails its own entry without blocking the rest of the batch." },
            { heading: "Generate a storage inventory report.", body: "Download a JSON or CSV report listing every object in a bucket (or all buckets), with its size, tags, checksum, and protection status — useful for audits and cleanup." },
            { heading: "Run a storage policy checkup.", body: "Open the read-only policy analyzer to see which of your storage credentials are unrestricted, have no expiration, or have overly broad destructive permissions — nothing is changed automatically." },
            { heading: "View storage analytics.", body: "See per-bucket object counts, total size, largest files, and how many objects are version-locked or under legal hold." },
          ],
        },
      ],
    },
    {
      number: "30",
      title: "Inaya Drive — Mounting Storage as a Real Drive",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Download Inaya Drive.", body: "From Business Workspace's download page, get the Inaya Drive helper for your operating system (Windows or Linux; macOS support is written but not yet validated on real hardware)." },
            { heading: "Configure it with your storage credential.", body: "Run the helper with your S3-compatible Access Key ID/Secret Access Key from Section 28." },
            { heading: "Mount the drive.", body: "The helper mounts your organization's storage as a real drive letter (Windows) or mount point (Linux). Open it in your normal file explorer/finder." },
            { heading: "Use it like any drive.", body: "Create real folders, and read, write, rename, and delete files directly — changes sync through to Inaya's storage immediately, with the same encryption/sharding pipeline underneath." },
          ],
        },
      ],
    },
    {
      number: "31",
      title: "Migrating Existing Cloud Data Into Inaya",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Install the Data Migration Agent.", body: "Download the standalone command-line migration tool." },
            { heading: "Set your source credentials.", body: "Provide your existing AWS S3, Azure Blob, or Google Cloud Storage credentials as environment variables — they stay on your own machine and are never sent to or stored by Inaya." },
            { heading: "Set your Inaya destination credentials.", body: "Provide the Access Key ID/Secret Access Key you issued in Section 28." },
            { heading: "Run a dry run first.", body: "Use the tool's dry-run option to preview exactly what would be migrated, without moving any data yet." },
            { heading: "Run the real migration.", body: "Run it for real. It's resumable — if it's interrupted, re-running it picks up where it left off without duplicating anything already moved, and verifies every object's integrity after transfer." },
          ],
        },
      ],
    },
    {
      number: "32",
      title: "Integrations, API Keys, and Data Rooms",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Connect an integration.", body: "(Owner/admin) Open the Integrations tab and connect an external system — sign-in identity providers, productivity tools, or financial systems — via OAuth. You'll be redirected to that provider to authorize the connection." },
            { heading: "Issue an API key.", body: "Open the API Keys tab to issue a programmatic access key, scoped to what an external integration actually needs." },
            { heading: "Create a Data Room.", body: "Open the Data Rooms tab to set up secure, time-limited document sharing with outside parties — useful for due diligence or deal rooms — with per-visitor engagement tracking so you can see what an external viewer actually looked at." },
          ],
        },
      ],
    },
    {
      number: "33",
      title: "Executive Dashboard and Export & Migration",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Executive Dashboard.", body: "(Owner/admin) Open the Executive tab for a leadership-level summary spanning every department, without drilling into each one individually." },
            { heading: "Export & Migration.", body: "(Owner/admin) Export your organization's own data, or manage migration tooling for moving into or out of Inaya at the organizational level." },
          ],
        },
      ],
    },
    // =====================================================================
    // PART I — AI ASSISTANTS, BILLING, AND SETTINGS
    // =====================================================================
    {
      number: "34",
      title: "The AI Business Assistant",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Open the AI Assistant tab.", body: "Ask questions in plain language about your organization's real data — \"what invoices are overdue?\", \"who approved this purchase?\", \"what's blocking Project Alpha?\"." },
            { heading: "Ask it to propose an action.", body: "You can ask it to take an action on your behalf (e.g., \"mark this expense reimbursed\") — it never executes directly; it creates an AI Action Request (Section 23) for a human to approve." },
            { heading: "Use voice mode.", body: "Where enabled for your organization, switch to spoken-voice interaction with the same assistant instead of typing." },
          ],
        },
        {
          type: "note",
          text: "Every answer and every proposed action is scoped to exactly what your own account is permitted to see — the AI assistant can never show you, or act on, something you couldn't already access yourself.",
        },
      ],
    },
    {
      number: "35",
      title: "Billing and Organization Settings",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Billing.", body: "(Owner/admin) Open the Billing tab to see your current plan, usage, and payment details, and to change plans." },
            { heading: "Settings.", body: "(Owner/admin) Manage your organization's type/vertical, which AI features are enabled, team roster, and department structure from one place." },
          ],
        },
      ],
    },
    // =====================================================================
    // PART J — INDUSTRY-SPECIFIC WORKSPACES
    // =====================================================================
    {
      number: "36",
      title: "Industry-Specific Workspaces (Health, Legal, Financial, Regulated, Government OS)",
      blocks: [
        {
          type: "lead",
          text: "If your organization was created with a specific vertical, an extra tab appears with workflows built for that industry.",
        },
        {
          type: "numbered",
          items: [
            { heading: "Health OS.", body: "Manage patients, care teams, encounters, and clinical records, with access scoped to an explicit care-team assignment, not just department membership." },
            { heading: "Legal OS.", body: "Manage clients, matters, conflict checks, legal holds, discovery, deadlines, contracts, and time/billing entries." },
            { heading: "Financial OS.", body: "Manage funds, investors, commitments, portfolios, positions, valuations, and (for private capital) deals, diligence, and cap tables." },
            { heading: "Regulated Enterprise OS.", body: "Manage compliance controls, control testing, findings, internal audit plans, policies with acknowledgement tracking, and regulatory examinations." },
            { heading: "Government OS.", body: "Manage citizen records and government case work, with the same assignment-based access model as Health OS." },
          ],
        },
        {
          type: "note",
          text: "These verticals are currently web/desktop only — none has a dedicated mobile screen yet.",
        },
      ],
    },
    // =====================================================================
    // PART K — SECURITY LAYER, LEARN, INVESTOR DATA ROOM, TRUST CENTER
    // =====================================================================
    {
      number: "37",
      title: "The Security Layer (Public Threat Intelligence)",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Open the Security Layer.", body: "Go to inayanetwork.com/security, or select \"Security Layer\" from the main navigation." },
            { heading: "View live threat intelligence.", body: "See node-reported threats and their on-chain-confirmed verdicts — a public, decentralized security feed, not a single company's private blocklist." },
            { heading: "Check the Trust Center.", body: "Go to inayanetwork.com/trust for client-side cryptographic verification of the network's own claims, and cross-organization trust primitives." },
          ],
        },
      ],
    },
    {
      number: "38",
      title: "Inaya Learn",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Open Learn.", body: "Select \"Learn\" from the main navigation." },
            { heading: "Watch a course.", body: "Browse the educational video library and start any course." },
            { heading: "Ask the AI tutor.", body: "Use the built-in AI tutor to ask questions about the material you're watching, in context." },
          ],
        },
      ],
    },
    {
      number: "39",
      title: "Investor Data Room",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Open the Data Room.", body: "Go to inayanetwork.com/dataroom." },
            { heading: "Share with an investor.", body: "Upload documents and generate access-controlled links for specific investors or visitors." },
            { heading: "Review engagement.", body: "See per-visitor analytics — what each person actually opened and how long they spent on it." },
          ],
        },
      ],
    },
    // =====================================================================
    // PART L — MOBILE, DESKTOP, AND CROSS-CHAIN
    // =====================================================================
    {
      number: "40",
      title: "The Mobile App",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Install the app.", body: "Download the Inaya mobile app for your device." },
            { heading: "Sign in.", body: "Use the same wallet-connect flow (for the main dApp features) or email magic-link (for Business Workspace) as on the web." },
            { heading: "Use it as a full superset.", body: "Every core web dApp feature is available, plus Business Workspace, Learn, and Security Layer — the mobile app is not a stripped-down companion, it's a complete client against the same backend as the web app." },
          ],
        },
      ],
    },
    {
      number: "41",
      title: "The Desktop Apps",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Install the Business Workspace desktop app.", body: "Download the Windows or Linux desktop app for Business Workspace from its download page. It's the same backend and features as the web version, in a native window." },
            { heading: "Install the main dApp desktop app.", body: "Download the separate desktop app for the main wallet/vault/staking dApp, for the same reason — a native, always-available window instead of a browser tab." },
            { heading: "Mount Inaya Drive from the desktop app.", body: "The Business Workspace desktop app can start and stop your Inaya Drive mount (Section 30) directly from its own interface, without a separate command-line step." },
          ],
        },
      ],
    },
    {
      number: "42",
      title: "The Cross-Chain Bridge",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Open the Bridge.", body: "Go to inayanetwork.com/bridge." },
            { heading: "Choose source and destination chains.", body: "Select which chain your $INAYA is currently on and which testnet you want to move it to." },
            { heading: "Confirm the transfer.", body: "Approve the transaction in your wallet; the bridge moves your tokens across chains, with progress shown until it settles on the destination chain." },
          ],
        },
        {
          type: "note",
          text: "Nothing described anywhere in this guide is live on mainnet yet, on any chain — everything runs on testnets today.",
        },
      ],
    },
    {
      number: "43",
      title: "Web3 App Store",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Browse apps.", body: "Go to inayanetwork.com/apps to browse third-party applications built on Inaya's infrastructure." },
            { heading: "Submit your own app.", body: "If you're a developer, use the app submission page to list your own application in the store." },
          ],
        },
      ],
    },
    // =====================================================================
    // PART M — DEVELOPER TOOLS
    // =====================================================================
    {
      number: "44",
      title: "Building on Inaya — SDK, CLI, and Node Operators",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Read the developer docs.", body: "Go to inayanetwork.com/build for an overview of Inaya's developer surface." },
            { heading: "Install the custody-sdk.", body: "Add the custody-sdk client library to your own project to programmatically encrypt, shard, and store files against Inaya's infrastructure — the same library the web app itself is built on." },
            { heading: "Run a node operator daemon.", body: "Install and run the published node-operator daemon if you want to contribute storage/compute capacity to the network." },
            { heading: "Use the Node Operator Dashboard.", body: "Go to inayanetwork.com/operator to monitor your node's fleet status, uptime, qualification progress, and rewards in one dashboard." },
          ],
        },
      ],
    },
    {
      number: "45",
      title: "Network Stats, Status, and Getting Help",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "Network Stats.", body: "Go to inayanetwork.com/stats for live, network-wide statistics." },
            { heading: "What's New.", body: "Go to inayanetwork.com/changelog to see the latest shipped features and fixes." },
            { heading: "FAQ.", body: "Go to inayanetwork.com/faq for answers to common questions." },
            { heading: "Getting help.", body: "Use the Contact Us link from the main navigation's \"About Us\" section for direct support." },
          ],
        },
      ],
    },
  ],
};
