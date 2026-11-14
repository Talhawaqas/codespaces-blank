# Inaya Network — For Individuals, Corporate Teams, and Enterprise

Internal doc, grounded only in what's actually built and live on testnet today (BSC Testnet chain
ID 97, plus the multichain spokes listed below) — not a roadmap or a pitch deck. Where something is
still testnet-only or a demonstration layer rather than production infrastructure, it's flagged
explicitly, matching how every other doc in this codebase handles the line between real and
aspirational.

---

## For Individuals

**Your files, encrypted before they ever leave your device, and now backed up for real.**

- **Encrypted personal storage**: every file is encrypted client-side (AES-GCM-256) and split into
  two ciphertext halves before anything is uploaded — Inaya's own servers never see your plaintext,
  and never receive your encryption key. You hold the one passkey that reconstructs a file; nobody
  else can.
- **Real redundancy, not a single point of failure**: as of today, your shards are replicated
  across two independent storage providers, automatically health-checked, and automatically
  recovered if one provider has a problem — a temporary outage no longer means a lost file.
- **Own $INAYA, stake it**: flexible or locked (30/90-day) staking tiers with a real, deployed
  rewards contract — lock longer for a higher multiplier.
- **Use it from the chain you already have wallets on**: $INAYA moves natively across BSC, Ethereum
  (Sepolia), Avalanche (Fuji), Arbitrum (Sepolia), Solana, Hedera, Aptos, and Sui — real bridge
  contracts on every one, not just a promise.
- **Mobile app**: upload, stake, bridge, check your wallet balance, and run a referral program,
  all from your phone.
- **Run a node, earn commission**: anyone can register as a storage node operator — real commission
  tiers (30/40/50% by tier) with automated, timelocked settlement.
- **Security you can check yourself**: a public destination/threat checker anyone can query before
  interacting with an address, backed by a real, decentralized threat-reporting network — not a
  black box.

*Everything above is live on testnet today. This is Inaya proving the full system out for real
before mainnet — no real funds are at risk yet.*

---

## For Corporate Teams

**A Business Workspace built on the same encrypted storage — for teams, not just individuals.**

- **Encrypted document management for your whole company**: Departments, Projects, and Documents,
  with the same client-side encryption every individual upload gets, now with approval workflows
  and role-based access built around how a real team actually works.
- **CRM**: a real contacts-and-deals pipeline for tracking customers and sales.
- **Procurement & Inventory, actually connected**: a received purchase order really moves stock in
  Inventory — not two disconnected modules pretending to talk to each other.
- **Finance & HR**: *(currently a testnet demonstration/validation layer, not a production banking
  or payroll system)* — lets your team see and test the workflow shape before we build out real
  financial-institution integrations.
- **AI Action Requests**: AI-proposed actions route through a real human-approval queue before
  anything executes — nothing happens automatically that a person hasn't signed off on.
- **Billing that's actually wired up**: real plan/usage tracking with Stripe-backed checkout for
  upgrades, not a placeholder pricing page.
- **Desktop app**: the whole Business Workspace runs in your system tray on Windows or Linux,
  notifies you the moment something needs your approval, and updates itself.

*Finance and HR are explicitly labeled testnet/demonstration inside the product itself — we won't
let you mistake them for production financial infrastructure.*

---

## For Enterprise

**Everything above, plus the infrastructure and assurances a larger organization actually needs.**

- **Corporate Reserve capacity**: dedicated, pre-committed storage allocations (e.g. 250TB/year)
  billed annually, instead of pay-as-you-go — sized for predictable, large-scale usage.
- **A real security layer, not just a policy document**: four dedicated on-chain contracts running
  a decentralized threat-intelligence firewall — threat registry, threat reporting, node
  reputation, and security policy — with a reputation-weighted confidence threshold before anything
  gets confirmed on-chain. Public-facing so your own security team can independently verify it,
  not take our word for it.
- **NDA-gated data room**: a dedicated, access-controlled space for sharing sensitive documents
  with investors or partners under real access control, separate from day-to-day team storage.
- **Multi-department structure at scale**: the same Business Workspace org model, built to hold
  more departments, more projects, and more approval chains than a single small team needs.
- **Run your own node for full data sovereignty**: enterprise-tier node operators sit at the top
  commission tier — a real option for an organization that wants its own infrastructure inside the
  network, not just as a customer of it.
- **Everything is independently verifiable**: every contract address, every real transaction, every
  proven cross-chain route is a real, checkable on-chain fact — the same standard of evidence we
  hold ourselves to internally is available to your own technical due diligence.

*As with every tier above, this is all real, deployed testnet infrastructure — talk to us directly
about what a production/mainnet engagement looks like for your organization.*
