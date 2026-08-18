// Inaya Node Operator Manifesto — editable content. Source of truth for
// public/documents/inaya-operator-manifesto.pdf. Edit this file, then run
// `node scripts/fundraising-docs/generate.mjs`. See README.md.
//
// This is the first tracked source this PDF has ever had in this repo —
// previously it was a raw exported binary swapped in directly, same
// pre-history as the other docs this pipeline already covers.
//
// Content changes from the previous binary, all previously discussed and
// approved with the founder (Combined Node Registry SOW):
//   - Commission table: 30/40/50%, matching InayaNodeRegistry.sol's actual
//     on-chain rates (the contract was the one that was wrong before; it's
//     now fixed to match this document, not the other way around).
//   - Getting Started: "Download Docker Core" replaced with installing
//     @inaya-network/node-daemon (Docker was ruled out — most operators are
//     on Windows, and Docker Desktop is a heavier ask than a native daemon).
//   - "receives their USDT instantly" replaced with accurate language about
//     the 36-hour settlement timelock (InayaNodeRegistry.sol's
//     queueSettlement -> releaseSettlement window) — the "you never have to
//     claim it" promise still holds (a backend relayer calls release
//     automatically), it just isn't instant anymore, and shouldn't claim to
//     be.
//   - New: mainnet assignment priority threshold, now that one's actually
//     defined (90+ days at 95%+ testnet uptime) instead of an unspecified
//     future claim.

export const operatorManifesto = {
  cover: {
    company: "INAYA NETWORK",
    classification: "LIVE & VERIFIED",
    kicker: "DEPIN ARCHITECTURE OVERVIEW",
    title: "The Node Operator Manifesto",
    subtitle: "Monetize Your Idle Hardware. Secure Enterprise Assets. Earn Decentralized USDT Payouts.",
    metaItems: [
      { label: "Target Audience", value: "Data Centers, Miners & Web3 Enthusiasts" },
      { label: "Settlement Protocol", value: "BNB Chain Smart Contracts" },
      { label: "Payout Currency", value: "USDT (Stablecoin)" },
      { label: "Network Status", value: "Active Testing Phase" },
    ],
  },
  intro: {
    kicker: "DEPIN ARCHITECTURE",
    title: "Sovereign Data Storage",
    subtitle: "Powered by DePIN — encrypted, sharded, and settled across a distributed swarm of independent node operators.",
  },
  docId: "INAYA-NODE-MANIFESTO-2026-V2",
  sections: [
    {
      number: "01",
      title: "Why Join the Swarm?",
      blocks: [
        {
          type: "note",
          text: "Stop letting your surplus storage capacity depreciate. The Inaya Network transforms your idle drives into cash-generating enterprise infrastructure, protected by trustless mathematics.",
        },
        {
          type: "paragraphs",
          text: [
            "Traditional cloud providers like AWS and Google Cloud monopolize the $200B+ data storage industry. The Inaya Network (DePIN) disrupts this by decentralizing the physical hardware layer. We provide the cryptographic software, the zero-knowledge frontend, and the corporate clients. You provide the hard drive space.",
            "By becoming an Inaya Node Operator, you join a global distributed fleet that stores heavily encrypted, mathematically sliced data shards. In exchange for your hardware's storage and bandwidth, you earn consistent USDT revenue transferred to your Web3 wallet via our automated settlement smart contracts.",
          ],
        },
        {
          type: "columns",
          items: [
            {
              heading: "Stablecoin Payouts",
              body: "Unlike other networks that pay in volatile native tokens, your core storage capacity commissions are settled strictly in USDT, ensuring predictable ROI.",
            },
            {
              heading: "Zero-Knowledge Liability",
              body: "You only store encrypted binary shards. Because you never hold complete files, you have absolute zero legal liability regarding the data contents you host.",
            },
            {
              heading: "No Expensive Rigs Required",
              body: "Forget GPU mining. You don't need expensive compute hardware. A standard server or PC with a strong internet connection and reliable HDD/SSD space is enough.",
            },
          ],
        },
      ],
    },
    {
      number: "02",
      title: "Tiered Commission Architecture",
      blocks: [
        {
          type: "lead",
          text: "The Inaya Protocol enforces a strict, merit-based commission structure. Your payout percentages scale directly with the amount of storage you allocate and the reliability of your machine. The more you provide, the higher your cut of the corporate revenue.",
        },
        {
          type: "table",
          headers: ["Provider Tier", "Hardware Requirement", "Commission Payout", "Network Role"],
          rows: [
            ["Tier 1: Entry", "Under 500 GB", "30% of Revenue", "Redundancy Swarm Node"],
            ["Tier 2: Mid-Level", "500 GB to 4.99 TB", "40% of Revenue", "Core Retrieval Node"],
            ["Tier 3: Enterprise", "5 TB and Above", "50% of Revenue", "Institutional Guardian Node"],
          ],
        },
        {
          type: "subsection",
          heading: "The 90% Uptime Gate (Quality Control)",
          body: "Enterprise clients require reliable access to their data shards. To protect the network's reputation, our Smart Contract includes an unyielding Uptime Filter.",
        },
        {
          type: "note",
          label: "Downgrade Condition —",
          text: "If your node's connection drops and your weekly uptime score falls below 90.00%, the contract will automatically downgrade your payout to the baseline Entry Tier (30%), regardless of how many terabytes you are storing.",
        },
        {
          type: "note",
          label: "Restoration Condition —",
          text: "Once your hardware stabilizes and hits the 90%+ benchmark in the next cycle, the contract automatically restores your premium commission rate.",
        },
        {
          type: "code",
          label: "Solidity — Tier Calculation Logic",
          text: `function _calculateTier(uint256 _capacityGB, uint256 _uptimeScoreBps) internal view returns (Tier) {
    // Rigid Uptime Enforcement Gate
    if (_uptimeScoreBps < 9000) return Tier.Entry;

    if (_capacityGB >= 5000) return Tier.Enterprise;
    if (_capacityGB >= 500) return Tier.Mid;

    return Tier.Entry;
}`,
        },
      ],
    },
    {
      number: "03",
      title: "Initialize Your Node",
      blocks: [
        {
          type: "lead",
          text: "The Inaya ecosystem is designed for frictionless onboarding. Commissions are calculated automatically and released to your wallet without any action on your part — typically within 36 hours, giving the network a brief security window before funds move.",
        },
        {
          type: "numbered",
          items: [
            { heading: "Install the Inaya Node Daemon —", body: "Windows, macOS, or Linux. No Docker required." },
            { heading: "Register your node —", body: "Set your storage capacity and connect your wallet." },
            { heading: "Start earning —", body: "The daemon runs in the background and reports uptime automatically." },
          ],
        },
        {
          type: "subsection",
          heading: "Automated Batch Settlement",
          body: "Our backend coordinator aggregates node telemetry over a 7-day period. At the end of the settlement cycle, the coordinator queues a secure, gas-optimized batch transaction on the BNB Chain.",
        },
        {
          type: "lead",
          text: "Thanks to our robust smart contract engineering, even if an individual operator's queued settlement encounters an error, the system safely skips and logs the fault — every other node operator's payout still proceeds on schedule.",
        },
        {
          type: "subsection",
          heading: "Mainnet Assignment Priority",
          body: "Operators who maintain 95%+ uptime for at least 90 consecutive days on the testnet Watcher Program earn priority access when mainnet node assignments open.",
        },
        {
          type: "quote",
          text: "Ready to deploy? Install the Inaya Node Daemon and register your wallet to begin.",
        },
      ],
    },
  ],
};
