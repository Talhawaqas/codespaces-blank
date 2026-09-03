// Architecture Overview — editable content. Source of truth for
// public/documents/inaya-ecosystem-overview.pdf. Edit this file, then run
// `node scripts/fundraising-docs/generate.mjs`. See README.md.
//
// The higher-level companion to ecosystem-architecture.js (full detail) and
// ecosystem-dev-deepdive.js (code reference) — how the pieces fit together
// and why, without function signatures or addresses. Readable by someone
// technical who doesn't need to touch the code.

export const ecosystemOverview = {
  cover: {
    company: "INAYA NETWORK",
    classification: "INTERNAL — OVERVIEW",
    kicker: "ARCHITECTURE OVERVIEW",
    title: "The Inaya Ecosystem, End to End",
    subtitle:
      "How the storage protocol, the applications built on it, and the AI layer all fit together — the shape of the system, without the code.",
    docLine: "Document INAYA-OV-2026-V1 · Classification Internal · September 2026",
  },
  docId: "INAYA-OV-2026-V1",
  sections: [
    {
      number: "01",
      title: "The Shape Of The System",
      blocks: [
        {
          type: "lead",
          text: "Inaya is one ecosystem built on two connected layers. The bottom layer is a real DePIN protocol — people encrypt their own files, independent operators store and verify them, and a blockchain anchors who owns what. The top layer is a set of applications — web, mobile, two desktop apps, and a business SaaS product — that most users interact with without ever knowing a blockchain is involved.",
        },
        {
          type: "columns",
          items: [
            {
              heading: "The protocol layer",
              body: "Smart contracts that handle ownership, staking, node payouts, and threat verification. This is where the token economics live, and where independent node operators actually earn.",
            },
            {
              heading: "The application layer",
              body: "Everything a person actually opens: the storage dApp, the Business Workspace for companies (including its own operations, finance, and HR tooling), the mobile app, two desktop apps, a public security page, an investor data room, and four AI assistants — all talking to the same backend.",
            },
          ],
        },
      ],
    },
    {
      number: "02",
      title: "Storage — How A File Actually Gets Protected",
      blocks: [
        {
          type: "lead",
          text: "This is the core promise: nobody but the file's owner can ever read it — not Inaya, not the node storing it, nobody.",
        },
        {
          type: "numbered",
          items: [
            { heading: "Encrypt on your device.", body: "Before a file ever leaves the user's browser or phone, it's encrypted using a key derived from their own passkey. That passkey is never sent anywhere." },
            { heading: "Split it in two.", body: "The encrypted file is split into two halves. Neither half means anything on its own — you need both to reconstruct anything." },
            { heading: "Store both halves.", body: "The two halves get pinned to decentralized storage (IPFS/Pinata), independent of each other." },
            { heading: "Anchor ownership on-chain.", body: "A record — who owns this file, where its two halves live, a fingerprint proving it hasn't been tampered with — gets written to the blockchain. This is the permanent, tamper-evident receipt." },
            { heading: "Reverse it to read.", body: "Downloading does the same thing backwards: look up the on-chain record, fetch both halves, put them back together, decrypt with the owner's passkey. Nothing about this process gives Inaya, a node operator, or anyone else a way to see the plaintext." },
          ],
        },
        {
          type: "note",
          label: "You don't have to take Inaya's word for any of this.",
          text: "The encryption code above is published as open source (@inaya-network/custody-sdk on npm) and used identically by the web app and the mobile app — not a separate, unverifiable implementation behind the scenes. Every release publishes a cryptographic hash anyone can independently reproduce and check, plus a second copy pinned to IPFS so the code itself, not just Inaya's word, identifies what you're running. Full verification steps are public.",
        },
        {
          type: "note",
          label: "The two halves don't depend on one company staying up.",
          text: "Each file's two encrypted shards are replicated across two independent pinning providers on genuinely different infrastructure (Pinata and Filebase), not just one. The system checks pin health continuously and, if a replica goes missing or its content stops matching what was originally captured, automatically fetches from the surviving healthy copy, re-verifies it, and re-pins — self-healing back to fully protected without anyone having to notice or act.",
        },
      ],
    },
    {
      number: "03",
      title: "Node Operators — Who Actually Stores The Data",
      blocks: [
        {
          type: "lead",
          text: "Independent people and organizations run node software that registers them on-chain and reports their capacity. In exchange, they earn USDT and $INAYA — for storage service, and separately, for contributing to a decentralized threat-intelligence network (see Section 05).",
        },
        {
          type: "bullets",
          items: [
            "Registration and identity live on-chain — a node's stake, tier, and track record are public and verifiable.",
            "Payouts are deliberately delayed and verifier-attested rather than instant and self-reported — this protects the system from a single bad actor (or a single compromised key) draining funds in one move.",
            "Today, the software an operator runs handles registration and reporting — it doesn't yet handle the actual physical hosting of file shards. That's a known, stated gap in the current build, not a hidden one.",
          ],
        },
      ],
    },
    {
      number: "04",
      title: "The Web dApp — Where Consumers And The Protocol Meet",
      blocks: [
        {
          type: "lead",
          text: "The main website is where an individual user does everything token-and-storage related: gets testnet tokens from a faucet, uploads/downloads files in the Sovereign Vault, stakes $INAYA for yield, tracks their activity on a dashboard, refers friends (email + identity verification, no wallet needed for that part), and — for larger customers — buys an annual Corporate Reserve storage plan, paid in USDT and settled on-chain.",
        },
        {
          type: "note",
          text: "Staking has real lock-period tiers (flexible, 30-day, 90-day) with better rewards for longer commitments — this is enforced on-chain, not just a UI label.",
        },
      ],
    },
    {
      number: "05",
      title: "Business Workspace — A Second Product On The Same Foundation",
      blocks: [
        {
          type: "lead",
          text: "Not every customer wants a blockchain product. Business Workspace is a genuine B2B SaaS tool — organizations, departments, projects, documents — with real approval workflows, granular permissions, secure sharing links, and a permission-aware AI assistant. Sign-in is just an email or a Google account. No wallet, no tokens, no blockchain vocabulary anywhere in the experience.",
        },
        {
          type: "lead",
          text: "It has grown well beyond documents: real business operations (Tasks, CRM, Procurement, Inventory) and a Finance & HR layer (invoicing, expense approval, employee records, leave management) now run on the exact same organization/department/permission foundation described above — every new module additive, nothing about the base system had to be restructured to add them. Finance & HR is explicitly a testnet demonstration layer today, not regulated banking or payroll.",
        },
        {
          type: "note",
          label: "Why this matters strategically.",
          text: "It's a second, independent revenue engine — priced and sold like any other business software, evaluated by a buyer who will never ask what chain it runs on — while still running on top of the same infrastructure and the same encryption guarantees as the consumer storage product.",
        },
      ],
    },
    {
      number: "06",
      title: "Security Layer — A Decentralized Threat Network",
      blocks: [
        {
          type: "lead",
          text: "Marketed publicly as \"Inaya Firewall.\" The same trust model as the storage layer, applied to threat intelligence instead of files: independent nodes report suspicious websites, the network only trusts a threat once enough independent, reputable reporters agree, and confirmed verdicts get permanently recorded on-chain so they can't quietly be changed later.",
        },
        {
          type: "bullets",
          items: [
            "A public website page lets anyone — no account needed — check a domain, see network stats, and ask an AI assistant about how it all works.",
            "The mobile app can check destinations before you trust them and keep your own personal block/allow list.",
            "The desktop apps can, on Windows, actually block a confirmed-malicious address at the operating-system firewall level, not just inside the app window.",
          ],
        },
      ],
    },
    {
      number: "07",
      title: "The AI Layer — Four Assistants, One Pattern, Different Rules",
      blocks: [
        {
          type: "lead",
          text: "All four assistants (Docs, Business, Security, Learn Tutor) are built the same technical way — they can call small, purpose-built tools to look up real data before answering. What's different is the philosophy each one follows.",
        },
        {
          type: "table",
          headers: ["Assistant", "Its one rule"],
          rows: [
            ["Docs Assistant", "Answer grounded in the project's own real documentation — retrieves the relevant passage first, then answers from it, and cites where the answer came from."],
            ["Business Assistant", "Never show a user data they aren't actually permitted to see — every answer respects real document/project/finance/HR permissions."],
            ["Security Assistant", "Never invent a threat verdict — every specific claim must be backed by real, verified network data."],
            ["Learn AI Tutor", "The opposite of the other two — teach freely using its own knowledge, like a real tutor would; only use tools to check the user's own saved videos and progress."],
          ],
        },
        {
          type: "note",
          label: "How the Docs, Security, and Learn assistants find the right passage.",
          text: "A shared retrieval layer (RAG) indexes the project's real documentation and FAQs, embeds it for semantic search, and combines that with plain keyword search — so \"how does the pricing work\" and \"pricing structure\" both find the same real answer, not a static block of hardcoded text that goes stale the moment the product changes.",
        },
        {
          type: "subsection",
          heading: "AI-Powered Business Operations — the AI can propose, it can never execute.",
          body: "As of September 2026, the Business Assistant can go further than answering questions: it can propose real changes across 9 business domains (Tasks, Expenses, Documents, Employees, Invoices, Leave Requests, Purchase Orders, Purchase Requests, Deals). It never performs any of them itself.",
        },
        {
          type: "numbered",
          items: [
            { heading: "The AI proposes, not executes.", body: "Every proposal is checked against the exact same permission the real action would require before it's even created — the AI can't propose something the requesting user isn't already allowed to do." },
            { heading: "A human approves with real authority.", body: "A person with the exact same real authority the underlying action requires — re-checked independently by the server, not trusted from the request — must approve it. Higher-risk actions (terminating an employee, approving a large purchase) are automatically classified as higher risk than routine ones (advancing a task)." },
            { heading: "A mandatory 36-hour delay passes.", body: "Even after approval, nothing executes immediately — mirroring the same timelocked-settlement pattern the storage protocol itself uses for node-operator payouts, reused here for a completely different kind of action." },
            { heading: "Only then does it execute — and everything is recorded.", body: "A separate process executes the change only once the delay has genuinely passed, and only if the real action still makes sense. Every step — proposed, approved, delayed, executed, rejected, or expired — is written into a cryptographically verifiable audit trail." },
          ],
        },
        {
          type: "note",
          label: "The audit trail isn't just a log — it's tamper-evident by construction.",
          text: "Every entry cryptographically commits to the one before it, so altering or deleting any past entry breaks every entry after it — a direct database edit is mathematically detectable, not just against policy. Any business customer can independently walk their own organization's chain and recompute it themselves via a self-service export; they don't have to trust a \"Verified\" badge Inaya shows them. Security-tested with 19 automated tests, 11 of them adversarial scenarios specifically trying to defeat the guardrails.",
        },
      ],
    },
    {
      number: "08",
      title: "Mobile & Desktop — Same Backend, Different Doors",
      blocks: [
        {
          type: "lead",
          text: "None of the client apps are separate products with their own logic — they're different doors into the exact same backend and the exact same data.",
        },
        {
          type: "bullets",
          items: [
            "The mobile app is a full superset — everything the web dApp does, plus the Business Workspace, Learn, and Security, in one app.",
            "The two desktop apps are deliberately thin — each one is just the real website, running inside a lightweight native window with a system tray icon, native notifications, and auto-updates layered on top. There is no separate desktop-only feature set to keep in sync.",
          ],
        },
      ],
    },
    {
      number: "09",
      title: "App Store, NFT Vault & Account Security (September 2026)",
      blocks: [
        {
          type: "lead",
          text: "Three smaller but real additions rounding out the consumer side: a place to discover Web3 apps, a place to back up NFTs the same way files are backed up, and a stronger login.",
        },
        {
          type: "bullets",
          items: [
            "Web3 App Store (/apps) — a curated set of Inaya's own apps, plus community-submitted ones. A submission needs a wallet signature and is checked against the live threat network before an admin ever sees it, and nothing goes live until approved.",
            "NFT Vault (/nfts) — discovers NFTs a wallet owns and backs up their metadata and image using the exact same encrypt-and-shard pipeline that protects every other file on Inaya.",
            "Optional two-factor login for Business Workspace — an authenticator app or a text message code, on top of the existing passwordless sign-in.",
          ],
        },
      ],
    },
    {
      number: "10",
      title: "Multi-Chain — Moving Value Beyond BNB Chain",
      blocks: [
        {
          type: "lead",
          text: "Inaya started on BNB Chain Testnet, but $INAYA doesn't have to stay there. Two independent systems, running in parallel, let value move to other chains — deliberately kept separate, since a problem in one says nothing about the other.",
        },
        {
          type: "columns",
          items: [
            {
              heading: "Inaya's own native bridge",
              body: "Full control, no third-party dependency. A real, proven lock-and-mint cycle now works to Ethereum, Avalanche, Arbitrum, Solana, Hedera, Aptos, and Sui — each one verified with a real transaction that moved real (testnet) value and confirmed it arrived on the other side, not just deployed-and-assumed-working.",
            },
            {
              heading: "A second route via Wormhole",
              body: "An independent, third-party interoperability network, integrated as an alternative path that doesn't replace the native bridge. Proven working end-to-end to Ethereum, Arbitrum, and Avalanche; a few other chains are currently blocked by issues in Wormhole's own tooling, not anything on Inaya's side, and are shown as reference-only until that's resolved upstream.",
            },
          ],
        },
        {
          type: "note",
          label: "Nothing here is claimed beyond what's actually been proven on-chain.",
          text: "A chain only ever gets credit for the capability level it's genuinely demonstrated — discovered, wallet-connected, messaging-only, or a real proven transfer — never assumed from \"it's deployed\" alone. Several real bugs were found and fixed getting the newer chains (Solana, Sui) working; each is documented rather than smoothed over, the same honesty convention this whole ecosystem holds itself to.",
        },
      ],
    },
    {
      number: "11",
      title: "Oracle & Automation — Infrastructure That Runs Itself",
      blocks: [
        {
          type: "lead",
          text: "A third independent subsystem: an on-chain registry of approved data sources, and a keeper that executes pre-approved contract actions automatically — under smart-contract rules, never arbitrary admin commands. Live on BSC Testnet today, publicly verifiable at inayanetwork.com/automation.",
        },
        {
          type: "bullets",
          items: [
            "The live demo isn't simulated: the price feed reads the real PancakeSwap testnet pool for INAYA/USDT, and the automated action is a real, already-existing node-settlement release function on InayaNodeRegistry — the first run found and released an actual previously-unclaimed payout.",
            "If the data feeding an automated action goes stale, the system skips that action rather than acting on unverified information — proven live, not just claimed.",
            "The keeper never holds broad authority — it can only submit data it's explicitly registered for, and only call functions that are already safe for anyone to call.",
          ],
        },
      ],
    },
    {
      number: "12",
      title: "Sovereign Enterprise OS — One Operating Environment, Not a Pile of Features",
      blocks: [
        {
          type: "lead",
          text: "Almost everything described in this document already existed as a separate feature. What was missing was the connecting layer — one place that shows you what needs your attention, lets you search everything at once, asks one assistant instead of four, and tells you plainly whether your data and your organization's activity are in a trustworthy state right now.",
        },
        {
          type: "bullets",
          items: [
            "One OS Home screen — trust & health status, recent notifications, what changed this week, and an assistant that can answer both business and security questions — on both the web app and Business Workspace, each tailored to how you actually use it.",
            "Real notifications with a memory — mark something read once, and it stays read, instead of the app forgetting the moment you refresh.",
            "One search bar (Cmd/Ctrl+K) instead of hunting through a dozen separate screens for a task, a deal, a document, or a file.",
            "A trust & health signal that's actually true, not decorative — built from the same real audit trail, backup health, and security data described earlier in this document, never invented for the sake of a clean-looking dashboard.",
            "On desktop, a module you're watching closely (like the audit trail) can now pop out into its own window and stay visible alongside everything else, instead of switching away from what you were doing.",
          ],
        },
        {
          type: "note",
          label: "Two operating environments, not one blended one.",
          text: "Your business identity (email, organization membership) and your wallet identity are kept genuinely separate — there was no clean way to merge them without inventing a new identity system neither product actually needed, so the OS shell was built twice from the same underlying pieces instead: one for Business Workspace, one for the wallet-connected app. This mirrors how the two desktop apps already work today.",
        },
      ],
    },
    {
      number: "13",
      title: "How It All Actually Connects",
      blocks: [
        {
          type: "paragraphs",
          text: [
            "One backend serves every surface — the website, the mobile app, and both desktop apps all call the exact same API. There's no duplicated logic to keep in sync between platforms; a fix or feature on the backend is instantly live everywhere.",
            "The protocol (contracts, node operators, encryption) and the applications (dApp, Business Workspace, mobile, desktop, AI) are cleanly separated — most of what a user touches day-to-day never has to think about the blockchain underneath it, even though it's doing real work a layer down.",
            "BNB Chain Testnet is still home base — the core protocol, staking, and node settlement all live there — but it's no longer the only chain involved: $INAYA now moves to several other testnets through the bridge described in Section 10. Nothing described in this document is live on mainnet yet, on any chain — that's the next major milestone, not a past one.",
          ],
        },
      ],
    },
  ],
};
