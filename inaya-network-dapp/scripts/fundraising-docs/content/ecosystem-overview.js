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
    docLine: "Document INAYA-OV-2026-V1 · Classification Internal · August 2026",
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
              body: "Everything a person actually opens: the storage dApp, the Business Workspace for companies, the mobile app, two desktop apps, a public security page, an investor data room, and three AI assistants — all talking to the same backend.",
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
      title: "The AI Layer — Three Assistants, One Pattern, Different Rules",
      blocks: [
        {
          type: "lead",
          text: "All three assistants (Business, Security, Learn Tutor) are built the same technical way — they can call small, purpose-built tools to look up real data before answering. What's different is the philosophy each one follows.",
        },
        {
          type: "table",
          headers: ["Assistant", "Its one rule"],
          rows: [
            ["Business Assistant", "Never show a user data they aren't actually permitted to see — every answer respects real document/project permissions."],
            ["Security Assistant", "Never invent a threat verdict — every specific claim must be backed by real, verified network data."],
            ["Learn AI Tutor", "The opposite of the other two — teach freely using its own knowledge, like a real tutor would; only use tools to check the user's own saved videos and progress."],
          ],
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
      title: "How It All Actually Connects",
      blocks: [
        {
          type: "paragraphs",
          text: [
            "One backend serves every surface — the website, the mobile app, and both desktop apps all call the exact same API. There's no duplicated logic to keep in sync between platforms; a fix or feature on the backend is instantly live everywhere.",
            "The protocol (contracts, node operators, encryption) and the applications (dApp, Business Workspace, mobile, desktop, AI) are cleanly separated — most of what a user touches day-to-day never has to think about the blockchain underneath it, even though it's doing real work a layer down.",
            "Everything currently runs on BNB Chain Testnet. Nothing described in this document is live on mainnet yet — that's the next major milestone, not a past one.",
          ],
        },
      ],
    },
  ],
};
