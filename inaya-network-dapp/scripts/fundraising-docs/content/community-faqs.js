// General User & Community FAQs — editable content. Source of truth for
// public/documents/inaya-community-faqs.pdf. Edit this file, then run
// `node scripts/fundraising-docs/generate.mjs`. See README.md.

export const communityFaqs = {
  cover: {
    company: "INAYA NETWORK",
    classification: "PUBLIC",
    kicker: "COMMUNITY FAQS",
    title: "General User & Community FAQs",
    subtitle: "A friendly guide for everyday users and builders — Inaya Network's DePIN infrastructure and custody protocol.",
    docLine: "Document INAYA-FAQ-COMMUNITY-V3 · Classification Public · August 2026",
  },
  docId: "INAYA-FAQ-COMMUNITY-V3",
  sections: [
    {
      number: "Q1",
      title: "What is Inaya Network in simple terms?",
      blocks: [
        {
          type: "lead",
          text: "Think of it as a private, encrypted vault for your most sensitive files — identity documents, private keys, digital assets. Unlike Google Drive or Dropbox, which store your files whole on central servers, Inaya encrypts your data on your own device first, then splits it into pieces before anything ever leaves your browser. No single company — not even Inaya — ever holds a complete, readable copy of your file.",
        },
        {
          type: "note",
          text: "No cryptographic system can honestly promise to be unbreakable — but this architecture is specifically designed so there's no single point where a complete, readable copy of your data ever exists outside your own control.",
        },
      ],
    },
    {
      number: "Q2",
      title: "How does \"file slicing\" actually protect me?",
      blocks: [
        {
          type: "lead",
          text: "It all happens inside your own browser before anything uploads. Your file is encrypted with AES-256-GCM, then split into two independent pieces — Shard Alpha and Shard Beta — cut at the exact binary midpoint. Each piece is stored independently. Either shard alone is meaningless, encrypted noise. Your file can only be reconstructed with your own private master passkey, which never leaves your device.",
        },
      ],
    },
    {
      number: "Q3",
      title: "Do I need a monthly subscription?",
      blocks: [
        {
          type: "lead",
          text: "No. Monthly/annual plans (Corporate Reserve) exist for large enterprise customers with predictable, high-volume needs. Everyday users pay Pay-As-You-Go — only for the exact amount of data actually stored, with zero commitment.",
        },
      ],
    },
    {
      number: "Q4",
      title: "How much does it actually cost?",
      blocks: [
        {
          type: "lead",
          text: "Rates are read live from the deployed smart contract and may change — always confirm the current rate in the app before uploading at scale. [VERIFY] a specific per-GB figure before restating publicly; the important guarantee is that it's a live, on-chain rate, not a fixed number this document should lock in.",
        },
      ],
    },
    {
      number: "Q5",
      title: "What wallets are supported?",
      blocks: [
        {
          type: "lead",
          text: "Inaya is built natively on BNB Chain. On the web app, any standard Web3 browser extension wallet (e.g. MetaMask) works. On mobile, wallet connection works via MetaMask Connect Multichain, connecting directly through a deeplink to the MetaMask app. There are no usernames or passwords for wallet-based features — your wallet is your identity.",
        },
        {
          type: "note",
          text: "Business Workspace, Inaya Learn, and the public Security page don't require a wallet at all — email sign-in (or nothing, for public pages) is enough.",
        },
      ],
    },
    {
      number: "Q6",
      title: "I'm a student / young developer — how can I get support?",
      blocks: [
        {
          type: "lead",
          text: "The Inaya Foundation Scholarship & Grant Project is planned — equity-free micro-grants for young developers and cryptography students building with the Inaya Custody SDK, funded from the protocol's Ecosystem Fund allocation. It opens for applications after mainnet launch and is not yet accepting applications — follow official channels for the announcement.",
        },
      ],
    },
    {
      number: "Q7",
      title: "What can I actually do with Inaya today, beyond storage?",
      blocks: [
        {
          type: "bullets",
          items: [
            "Inaya Learn — browse and watch curated educational videos on Web3, AI, and programming, with a built-in AI tutor. No wallet needed.",
            "Security — check whether a domain or IP has been flagged by the network's decentralized threat-intelligence layer, right from the public website. No wallet needed.",
            "Business Workspace — if your company needs document management with real approval workflows and permissions, it's a separate sign-up with just an email address.",
          ],
        },
      ],
    },
  ],
};
