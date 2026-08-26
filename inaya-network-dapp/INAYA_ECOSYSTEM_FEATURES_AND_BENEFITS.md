# Inaya Ecosystem — Features & Benefits

**As of:** August 2026. Everything listed under Features is real, shipped, and live on BNB Chain Testnet (or, for off-chain surfaces, in production) — nothing here is a roadmap promise. Where a capability is deliberately scoped down (e.g. Finance & HR's testnet-only status), that's called out inline. See `ecosystem-architecture.js` / `ecosystem-dev-deepdive.js` (source for the internal Architecture Overview / Founder Reference / Developer Deep-Dive PDFs) for full technical detail behind any item below.

---

## Part 1 — Features (what's actually built)

### Core DePIN Protocol

- Client-side AES-256 encryption (PBKDF2 key derivation) — files are encrypted before they ever leave the user's device.
- Binary sharding — the encrypted file is split into two independent halves, distributed to independent storage nodes.
- On-chain ownership anchoring — a tamper-evident ownership record (never the file itself) written to a BNB Chain smart contract.
- 10 contracts deployed and verified on BSC Testnet: Custody, Staking, Egress Timelock Vault, Corporate Escrow, Node Registry, Proof Registry, plus 4 Security Layer contracts.
- $INAYA utility/governance token — fixed supply, 30,000,000 tokens.
- Staking with 0/30/90-day lock tiers (1.00x/1.25x/1.50x multiplier), real on-chain lock enforcement.
- Node operator registry with tiered commission settlement (30/40/50% by Entry/Mid/Enterprise tier), a mandatory 36-hour timelock before payout release.
- Published node-operator CLI (`@inaya-network/node-daemon`) — registration + heartbeat telemetry.

### Web dApp (Sovereign Vault)

- Encrypted file upload/download with on-chain registration and Merkle-root proof anchoring.
- Testnet token faucet.
- Corporate Reserve — annual bulk storage plans (250/500/1000 TB tiers), paid in USDT, settled on-chain via RevenueRouter + CorporateEscrow.
- No-wallet card checkout (Stripe) for customers who don't want crypto at all.
- Staking dashboard — stake/unstake/claim, tier and APY display.
- Referrals system — email + KYC verified (Didit), no wallet required, built-in self-referral detection.
- Genesis Airdrop tracking (upload-reward progress + contributor-allocation application).

### Business Workspace — B2B SaaS Platform

- Company → Department → Project → Document hierarchy with server-enforced, role-based permissions.
- Real document workflow state machine (Draft → Pending → Under Review → Approved/Rejected → Archived) with a full, immutable activity log.
- Granular per-document access grants (VIEW/EDIT/MANAGE) plus expiring, revocable external share links.
- Email magic-link or Google Sign-In — no wallet or blockchain literacy required.
- Client-side encrypted document storage using the same encryption pipeline as the core storage protocol.
- Stripe-billed subscription plans with server-enforced seat and storage limits.
- Full web and mobile parity.

### Business Operations (Tasks, CRM, Procurement, Inventory)

- **Tasks** — assignment, due dates, real status-workflow tracking.
- **CRM** — a unified Lead/Customer contact model with a real sales pipeline (deals), so a contact's history stays attached across conversion.
- **Procurement** — purchase requests → purchase orders with a genuine multi-step approval chain.
- **Inventory** — products, warehouses, real stock levels, and an append-only stock-movement ledger; a received purchase order genuinely moves real inventory stock (not two disconnected modules).
- Every record is department-scoped, permission-enforced, and queryable by the AI Business Assistant.

### Finance & HR Layer *(testnet demonstration scope)*

- **Finance** — invoices (with a cron-driven overdue status), expenses (submit → approve/reject), payments (record → approve), and CSV financial reporting.
- **HR** — employee lifecycle records (onboarding → active → on leave → terminated), employee documents, computed leave balances, leave request approval, and Department Manager administration.
- Additive role model — Finance Manager/Staff and HR Manager/Staff roles layer onto the existing org membership system without restructuring it.
- Explicitly not regulated banking, tax filing, or payroll processing — every Finance/HR screen carries a visible "Testnet / Beta" badge.

### Security Layer ("Inaya Firewall")

- Decentralized, node-reported threat intelligence — independent nodes report suspicious domains/IPs.
- Reputation-weighted confidence scoring; a confirmed verdict is anchored on-chain, permanent and tamper-evident.
- Public web transparency page with a live threat feed and destination checker.
- Mobile protection screen (Monitor/Protect/Strict modes, local allow/blocklist, network overview).
- Real OS-level firewall enforcement on desktop (Windows/Linux).
- A dedicated Security AI Assistant, strictly grounded in verified network data.

### Oracle & Automation Layer

- On-chain registry of approved external data sources, with on-chain validation of every submitted data point (freshness, interval, deviation checks).
- A self-operating keeper that executes pre-approved contract actions automatically, under smart-contract rules — never arbitrary admin commands.
- Live today: a real INAYA/USDT price feed from PancakeSwap testnet, and automated node-settlement release.
- Publicly verifiable at `/automation`.

### AI Assistants (four, RAG-grounded where it matters)

- **Docs Assistant** — public site-wide chat, grounded via RAG retrieval over the project's real documentation instead of a static knowledge block; every answer cites its source.
- **Business Assistant** — permission-aware tool-calling over live Business Workspace data (documents, tasks, CRM, procurement, inventory, finance, HR); never surfaces data the asking user couldn't already see.
- **Security Assistant** — strict evidence-grounding over verified security data and RAG-indexed policy docs; never invents a threat verdict.
- **Learn AI Tutor** — teaches from general knowledge like a real tutor, with tools to ground it in the user's own saved videos/progress.
- Shared RAG infrastructure — hybrid vector + keyword search (Reciprocal Rank Fusion) on native MongoDB Atlas Search/Vector Search, Gemini embeddings, content-hash-cached, nightly re-ingestion cron.

### Inaya Learn — Educational Platform

- YouTube-based search/browse/watch/save/progress tracking, on web and mobile.
- Curated collections (Learn Web3 / Learn AI / Learn Programming).
- An AI Tutor grounded in the user's own saved videos and progress via RAG.

### Investor Data Room

- Dedicated, branded document room for investor materials — single shareable link, email + NDA click-through required.
- Per-visitor magic-link verification and real engagement analytics (open + duration + close tracking).

### Mobile App

- Full superset of the web dApp's consumer features, plus Business Workspace, Learn, and Security.
- Biometric app-lock, Google Sign-In, MetaMask Mobile deeplink wallet connect.

### Desktop Apps

- Two native Tauri (Rust) apps for Windows and Linux — one for Business Workspace, one for the main dApp.
- System tray, native menus, native desktop notifications for pending approvals, signed auto-updates.
- 8.3 MB installed footprint (vs. ~269 MB for an equivalent Electron build).

### Developer Platform

- `@inaya-network/custody-sdk` — the client-side encryption/sharding library ("InayaKernel"), published to npm.
- `@inaya-network/react` component package, `inaya-cli`, `create-inaya-dapp` scaffolding tool — all live on the public npm registry.
- Live Storybook, framework examples (React/Next.js/Node.js).

---

## Part 2 — Benefits (why it matters)

### For end users and businesses

- **True zero-knowledge storage.** Files are encrypted and split before they ever leave the device — Inaya itself cannot read customer data, structurally, not just by policy. A breach of Inaya's backend reveals nothing usable.
- **No vendor lock-in on trust.** Because the provider never holds a decryption-capable key, there's no equivalent of "the provider got hacked and now my data is exposed" — the worst case is unavailability, not disclosure.
- **One product, no blockchain literacy required for business users.** Business Workspace, Finance & HR, and Business Operations are all usable with just an email address — the DePIN infrastructure underneath is real, but invisible to the day-to-day user.
- **Real operational tooling, not just storage.** A company can run tasks, CRM, procurement, inventory, invoicing, and HR entirely inside the same secure workspace instead of stitching together five separate SaaS tools with five separate access models to audit.
- **An AI assistant that can't leak what it shouldn't.** Every AI assistant is permission- or evidence-scoped by construction — the Business Assistant never shows a user data they couldn't already see; the Security Assistant never fabricates a threat verdict.
- **Predictable, transparent pricing.** USDT-denominated pay-as-you-go and Corporate Reserve plans remove token-price volatility from the storage cost equation.
- **Cross-platform by default.** Web, mobile, and two native desktop apps all call the exact same backend — no feature gap between platforms, no separate account to manage.

### For node operators

- **Real, verifiable earnings.** Registration, tier, and settlement are on-chain and publicly auditable — not a black-box payout system.
- **Protection from a single point of failure.** The 36-hour settlement timelock means a single compromised verifier key can queue a bad settlement but can never instantly drain funds.
- **Two independent earning paths.** Storage capacity commission and Security Layer threat-reporting rewards, from the same node registration.

### For investors and the business itself

- **Two independent revenue engines from one infrastructure investment.** DePIN storage/staking economics and Business Workspace SaaS subscriptions serve different buyers with different economics, sharing the same underlying encrypted-storage backend.
- **Demonstrated execution velocity.** A full product surface — protocol, four applications, a developer SDK, and four AI assistants — shipped by a founder-led team with AI-assisted development, in a compressed timeframe.
- **Honesty as a structural feature, not a marketing line.** Every internal architecture document explicitly labels what's deferred, unbuilt, or a known gap (e.g., no real shard-hosting in the node daemon yet, no code-signing on desktop apps yet) — reducing diligence risk by making the real state of the system legible rather than something a technical reviewer has to reverse-engineer.
- **A testnet-first discipline that reduces mainnet risk.** New surfaces (Finance & HR, RAG, Oracle & Automation) are built, tested against real infrastructure (real Atlas cluster, real Gemini API, real BSC Testnet transactions), and explicitly scoped before anything touches mainnet or real money.

### For developers building on Inaya

- **A real, published SDK — not a private internal library.** `@inaya-network/custody-sdk`, the React component package, the CLI, and scaffolding tools are all on the public npm registry with documentation and examples.
- **One documented pattern to learn, reused everywhere.** The same state-machine workflow pattern, the same permission-resolution pattern, and the same audit-log pattern are reused across Tasks, CRM, Procurement, Inventory, Finance, and HR — learn it once, recognize it everywhere in the codebase.
