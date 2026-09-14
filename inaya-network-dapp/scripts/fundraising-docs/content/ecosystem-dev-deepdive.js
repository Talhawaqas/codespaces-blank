// Developer Technical Deep-Dive — editable content. Source of truth for
// public/documents/inaya-ecosystem-dev-deepdive.pdf. Edit this file, then run
// `node scripts/fundraising-docs/generate.mjs`. See README.md.
//
// Code-level reference: real function signatures, route paths, and
// collection shapes, grounded directly in the source. Companion to
// ecosystem-architecture.js (the narrative version) — this one is a
// lookup document, not a read-cover-to-cover one.

export const ecosystemDevDeepdive = {
  cover: {
    company: "INAYA NETWORK",
    classification: "INTERNAL — DEVELOPER REFERENCE",
    kicker: "TECHNICAL DEEP-DIVE",
    title: "Inaya Ecosystem — Developer Reference",
    subtitle:
      "Contract functions, API routes, data models, and SDK signatures — a lookup reference grounded directly in the real code.",
    docLine: "Document INAYA-DEV-2026-V1 · Classification Internal · September 2026",
  },
  docId: "INAYA-DEV-2026-V1",
  sections: [
    {
      number: "01",
      title: "Repo & Entry-Point Map",
      blocks: [
        {
          type: "table",
          headers: ["Path", "Entry point"],
          rows: [
            ["contracts/ (repo root)", "*.sol — Hardhat project, hardhat.config.js at repo root"],
            ["scripts/ (repo root)", "deploy*.cjs / deploy*.js, verify-*.cjs, simulate-security-nodes.js"],
            ["inaya-network-dapp/", "Next.js 14 App Router — src/app/, src/lib/, src/app/api/"],
            ["inaya-network-dapp/custody-sdk/", "src/index.js (InayaKernel), src/crypto.js, src/contracts.js"],
            ["inaya-network-dapp/custody-sdk/packages/node-daemon/", "bin/inaya-node-daemon.js (commander CLI)"],
            ["src/lib/chain-adapters/ (bridge + interop)", "registry.js (capability model), interop/ (Wormhole)"],
            ["src/lib/ai-action-requests.js, auditChain.js", "AI guarded-execution state machine + cryptographic audit trail"],
            ["inaya-mobile/", "Expo — App.js, src/screens/, src/utils/, src/providers/"],
            ["inaya-desktop/", "src-tauri/src/lib.rs, tauri.conf.json"],
            ["inaya-dapp-desktop/", "src-tauri/src/lib.rs, tauri.conf.json"],
          ],
        },
      ],
    },
    {
      number: "02",
      title: "Contract Function Reference",
      blocks: [
        {
          type: "subsection",
          heading: "InayaStaking.sol",
          body: "Constructor(stakingToken, rewardToken) — both = $INAYA address.",
          bullets: [
            "stake(uint256 amount, uint256 lockPeriodDays) — lockPeriodDays ∈ {0,30,90}, multiplier 1.00x/1.25x/1.50x, locked in on first stake",
            "withdraw(uint256 amount) — reverts if block.timestamp < lockExpiry",
            "claimReward() / exit() (withdraw all + claim)",
            "earned(address) / rewardPerToken() / getUserTier() → \"None\"/\"Standard\"/\"Enterprise Priority\"",
            "owner-only: setRewardRate, fundRewardPool, setEnterpriseTierThreshold, recoverForeignToken (blocked on staking/reward token)",
            "events: Staked, Withdrawn, RewardPaid, RewardRateUpdated, RewardPoolFunded",
          ],
        },
        {
          type: "subsection",
          heading: "InayaEgressTimelockVault.sol",
          body: "Constructor(inayaToken, usdtToken, stakingContract, operationalTreasury).",
          bullets: [
            "executeSemiAnnualHarvest() — public, callable by anyone once currentEpochStart + 180 days has passed; sweeps full INAYA balance to stakingContract via raw transfer (not fundRewardPool)",
            "forwardUSDT() — public, sweeps full USDT balance to operationalTreasury",
            "getNextHarvestCountdown() view",
            "owner-only: setStakingContract, setOperationalTreasury",
          ],
        },
        {
          type: "subsection",
          heading: "InayaCorporateEscrow.sol",
          body: "Constructor(usdtToken) only.",
          bullets: [
            "createEscrow(address corporate, address node, uint256 totalAmount) — safeTransferFrom(caller) into escrow, MONTHS=12 fixed schedule",
            "releaseMonthlyPayout(uint256 scheduleId) — public, callable by anyone once due",
            "owner-only: setMonthSeconds (testnet-only timing override), reassignNode",
            "events: EscrowCreated, MonthlyReleased, EscrowClosed",
          ],
        },
        {
          type: "subsection",
          heading: "InayaNodeRegistry.sol",
          body: "Constructor(usdtToken, verifierWallet). SCOPE NOTE in header: metrics are coordinator-verified, NOT cryptographic proof-of-storage.",
          bullets: [
            "registerNode(uint256 capacityGB) — self-serve",
            "updateNodeMetrics(...) — verifier-only",
            "queueSettlement / queueSettlementsBatch — verifier-only, computes commission (30/40/50% by Entry/Mid/Enterprise tier), does not move funds",
            "releaseSettlement / releaseSettlementsBatch — public, callable by anyone, only after SETTLEMENT_DELAY = 36 hours",
            "owner-only: setVerifierWallet, setTierThresholds, withdrawExcessReserve",
          ],
        },
        {
          type: "subsection",
          heading: "InayaProofRegistry.sol",
          body: "Constructor(custodyAddress) — immutable IInayaCustody reference.",
          bullets: [
            "registerMerkleRoot(bytes32 fileHash, bytes32 merkleRoot, uint256 chunkCount, address node) — requires msg.sender == custody.assets(fileHash).owner; node must be pre-approved via setNodeRegistered",
            "verifyChunkProof(...) — onlyOwner today (backend-checked); header comment documents a planned permissionless + slashing path",
            "events: MerkleRootRegistered, ProofVerified, NodeRegistrationChanged",
          ],
        },
        {
          type: "subsection",
          heading: "InayaCustody (interface only — IInayaCustody)",
          body: "Deployed, source not tracked in this repo. Interface as referenced from InayaProofRegistry:",
          bullets: [
            "assets(bytes32 fileHash) view → {owner, cidAlpha, cidBeta, size, timestamp}",
            "batchRegisterAssets(bytes32[] fileHashes, uint256[] fileSizes, string[] shardACIDs, string[] shardBCIDs)",
            "event AssetRegistered",
          ],
        },
        {
          type: "subsection",
          heading: "RevenueRouter (interface only)",
          body: "Deployed, source not tracked in this repo. Called via inline ABI from page.js and the Stripe webhook route:",
          bullets: ["processCorporateInvoice(uint256 usdtAmount) external"],
        },
        {
          type: "subsection",
          heading: "Security Layer contracts",
          body: "InayaThreatRegistry (status ledger, updated only by Reporter), InayaThreatReporter (confirmThreat(bytes32 threatId, uint8 category, uint16 confidenceBps, bytes32 contributingNodesHash) — relayer-only), InayaNodeReputation (checkpointReputation(...) — relayer-only, periodic), InayaSecurityPolicy (publishPolicy(uint256 version, bytes32 policyHash, string policyURI) — owner/relayer-only).",
        },
        {
          type: "subsection",
          heading: "Oracle & Automation Layer contracts (deployed to BSC Testnet)",
          body: "InayaOracleRegistry (registerSource(bytes32 id, string dataType, address submitter, uint256 updateFrequency) — owner-only; isAuthorizedSubmitter(id, address) view), InayaOracleAdapter (submitData(bytes32 id, uint256 value, uint256 reportedTimestamp) — reverts on future/stale timestamp, sub-minimum-interval, or excess deviation; getLatestData(id) / isStale(id) views), InayaAutomationRegistry (registerTask(bytes32 id, address target, bytes4 selector, string condition) — owner-only; recordExecution(id, bool success, uint256 nextEligible, bytes32 txHash) — worker/owner-only, pure audit-trail write, never forwards a call to target).",
        },
      ],
    },
    {
      number: "03",
      title: "custody-sdk (InayaKernel) API Reference",
      blocks: [
        {
          type: "table",
          headers: ["Function", "Purpose"],
          rows: [
            ["generateSecureSalt()", "16-byte random salt via crypto.getRandomValues"],
            ["deriveVaultKey({passkey, salt, iterations=100000, algo})", "PBKDF2 → 32-byte AES key"],
            ["disperseAndSlice({file, encryptionKey})", "Encrypt (AES-GCM-256) + base64-midpoint-split into shardAlpha/shardBeta"],
            ["anchorToLedger(...)", "Calls InayaCustody.batchRegisterAssets() with CIDs (not raw shard bytes)"],
            ["retrieveAndReconstruct({connection, fileHash, passkey, fetchShard})", "Reads assets(fileHash), fetches both shards, reassembles"],
            ["reconstructAndDecrypt({shardAlpha, shardBeta, passkey})", "Concat → split salt/IV/ciphertext → re-derive key → AES-GCM decrypt"],
            ["encryptForPublicKey / decryptWithSecretKey / deriveEncryptionKeypairFromSignature", "X25519 + HKDF-SHA256 + XChaCha20-Poly1305 sealed-box — re-wraps the passkey for sharing, not the file"],
            ["connectWallet, approveFeeTokens", "ethers v6 wallet/allowance helpers"],
            ["Staking.{stake,unstake,claimReward,calculateReward,getStakedBalance}", "Thin wrapper over InayaStaking"],
            ["Payments, Metadata, Analytics, events (EventEmitter)", "Supporting modules"],
            ["errors.{InayaError,InayaValidationError,InayaWalletError,InayaContractError,InayaNetworkError}", "Typed error classes"],
          ],
        },
        {
          type: "note",
          text: "Crypto primitives are @noble/hashes, @noble/ciphers, @noble/curves (pure JS) rather than crypto.subtle — chosen specifically for React Native compatibility, per an inline comment in crypto.js.",
        },
        {
          type: "subsection",
          heading: "Release verification (v1.0.10-beta+)",
          body: "Every git tag matching v* on custody-sdk (.github/workflows/release.yml) runs npm test → computes checksums → pins to IPFS (Pinata, non-blocking) → npm publish --provenance → commits CHECKSUMS.md → attaches the tarball to a GitHub Release. Reproduce independently per docs/VERIFYING_RELEASES.md:",
          bullets: [
            "git rev-parse <tag>^{tree} — compare to CHECKSUMS.md's git-tree-hash. NOT git archive | sha256sum (tried first, found non-reproducible across git versions — see Section 05 of ecosystem-architecture.js).",
            "Download the .tgz attached to the GitHub Release, sha256sum it, compare to CHECKSUMS.md's npm-tarball-sha256 — always matches, since you're hashing the literal file CI attached rather than re-deriving it (npm pack tarball bytes aren't guaranteed identical across npm versions, even when file contents are).",
            "npm view @inaya-network/custody-sdk@<version> dist.integrity / dist.shasum — the registry's own recorded hash for the published tarball.",
            "test/webCryptoCompat.test.mjs — the committed proof that this package's crypto and the dApp's former inline crypto.subtle implementation are byte-identical and cross-decryptable.",
          ],
        },
      ],
    },
    {
      number: "04",
      title: "node-daemon CLI Reference",
      blocks: [
        {
          type: "table",
          headers: ["Command", "Effect"],
          rows: [
            ["login", "Reads INAYA_PRIVATE_KEY (env or prompt), encrypts at rest (PBKDF2-SHA256 200k iter + AES-GCM-256), writes ~/.inaya/node-daemon/config.json"],
            ["register <capacityGB>", "InayaNodeRegistry.registerNode(capacityGB) on-chain + POST /api/nodes/register off-chain"],
            ["start", "Foreground 5-min heartbeat loop → POST /api/nodes/heartbeat with {nodeId, operatorWallet, totalCapacityGB, usedCapacityGB:0, shardsStored:0} (last two hardcoded 0 — no shard-storage capability exists)"],
            ["report <indicator> --category <cat>", "Security Layer signed observation → POST /api/security/report"],
            ["service install / uninstall", "Windows background service via node-windows"],
          ],
        },
        {
          type: "note",
          text: "package.json description states it plainly: registers your node on-chain and reports heartbeat/telemetry. Does not store or serve shards. NODE_REGISTRY_ABI in this package has exactly two functions (registerNode, nodes) — no stake/settlement/withdraw calls exist in the daemon's on-chain surface.",
        },
      ],
    },
    {
      number: "05",
      title: "Backend lib/ Reference",
      blocks: [
        {
          type: "lead",
          text: "Every file below follows the same shape: getXCollections(), ensureXIndexes() (module-level indexesEnsured guard), validateXInput() (throws, fail-closed).",
        },
        {
          type: "table",
          headers: ["File", "Domain"],
          rows: [
            ["security.js", "Threat reports/threats/policy/events/reputation-cache, computeThreatConfidence, getPublicSecurityStats"],
            ["ai-security-tools.js", "Security Assistant tool declarations + dispatcher"],
            ["learn.js / learnConfig.js / youtube.js", "Learn saved/progress/search-cache/video-cache, category+collection config, cached YouTube Data API client"],
            ["ai-learn-tools.js", "Learn Tutor tool declarations + dispatcher"],
            ["orgs.js / orgPlans.js", "Business Workspace auth (sessions, magic-links), org/plan definitions; canManageOrg/canAccessDepartment plus the additive canManageFinance/canAccessFinance/canManageHR/canAccessHR/isDepartmentManager/isSelfEmployeeRecord gates"],
            ["document-workflow.js / document-permissions.js", "Document state machine + activity log; access resolution + share tokens + getAccessibleScope() (the one org-wide 'what can this member see' resolver, extended per module as each shipped)"],
            ["ai-business-tools.js", "Business Assistant tool declarations + dispatcher (permission-aware) — list_documents/tasks/contacts/deals/suppliers/purchase_orders/products/invoices/expenses/employees, find_employee_document"],
            ["task-workflow.js / deal-workflow.js / purchase-request-workflow.js / purchase-order-workflow.js", "Business Operations transition-table workflows — {from,to,requiresManage,activityAction} pattern, one findOneAndUpdate per transition"],
            ["inventory.js", "recordStockMovement(), getStockLevel(), totalStockForProduct(), isLowStock() — stock_levels is $inc-only, stock_movements is the append-only ledger"],
            ["invoice-workflow.js / expense-workflow.js", "transitionInvoice() (send/markPaid/cancel + cron-only markOverdueInvoices()), transitionExpense() (submit/approve/reject/cancel)"],
            ["employee-workflow.js / leave-workflow.js", "transitionEmployee() (onboarding→active→on_leave→terminated), transitionLeaveRequest(), getLeaveBalance() (computed fresh, never a stored counter)"],
            ["attachments.js", "createAttachment()/listAttachmentsForRecord()/serializeAttachment() — shared metadata layer for Finance receipts (EXPENSE) and HR documents (EMPLOYEE), same encrypt/shard/pin client pipeline as org_documents"],
            ["org-activity-log.js", "logOrgActivity()/listOrgActivityForRecord() — one domain-generic audit log every Business Operations/Finance/HR workflow writes into"],
            ["rag/collections.js, chunking.js, embeddings.js, sanitize.js, vectorStore.js, retrieve.js, ingest.js, youtubeTranscript.js, queryCache.js, metrics.js", "RAG pipeline — see Section 11 for function-level detail"],
            ["rag/sources/{docsSources,securitySources,learnSources}.js", "Per-domain source adapters feeding ingest.js — DOCS_SOURCES, SECURITY_SOURCES, LEARN_STATIC_SOURCES + ensureVideoTranscriptIngested()"],
            ["dataroom.js", "Investor Data Room visitors/sessions/documents/views"],
            ["activity.js", "DAU/WAU ping recording + stats"],
            ["watcherPioneer.js", "Watcher Pioneer enrollment/qualification"],
            ["feedback.js", "Bug reports / idea submissions"],
            ["metadata-auth.js", "Shared signed-message verification helper (verifyMetadataAuth)"],
            ["email.js", "Resend-backed transactional email (magic links, Data Room verify)"],
          ],
        },
      ],
    },
    {
      number: "06",
      title: "API Route Reference (by domain)",
      blocks: [
        {
          type: "table",
          headers: ["Domain", "Routes"],
          rows: [
            ["Security (public)", "GET /api/security/{threat,feed,stats,policy}, POST /api/security/report, GET /api/security/reputation/[address], POST /api/security/events, GET /api/security/events"],
            ["Security (admin)", "GET /api/admin/security/{threats,nodes}, POST /api/admin/security/threats/[id]/override, GET|POST /api/admin/security/policy"],
            ["Security (AI)", "POST /api/ai/security-chat"],
            ["Security (cron)", "GET /api/security/cron/checkpoint-reputation (CRON_SECRET-gated)"],
            ["Learn", "GET /api/learn/config, GET /api/learn/search, GET /api/learn/video/[videoId], GET|POST /api/learn/saved, DELETE /api/learn/saved/[videoId], GET|POST /api/learn/progress, POST /api/learn/report, POST /api/learn/analytics"],
            ["Learn (AI)", "POST /api/ai/learn-chat"],
            ["Business Workspace (auth)", "POST /api/orgs/create, /api/orgs/login/google, magic-link login/verify"],
            ["Business Workspace (org)", "department/project CRUD, document upload/list/retrieve/transition, permissions grant/update/revoke, share create/list/revoke, GET /api/orgs/share/[token] (public resolve)"],
            ["Business Workspace (billing)", "GET /api/orgs/billing, POST /api/orgs/billing/checkout, POST /api/orgs/billing/portal, GET /api/orgs/billing/plans"],
            ["Business Workspace (AI)", "POST /api/ai/business-chat"],
            ["Business Workspace (tasks/CRM/procurement/inventory)", "/api/orgs/tasks/**, /api/orgs/crm/{contacts,deals}/**, /api/orgs/procurement/{suppliers,requests,orders}/**, /api/orgs/inventory/{products,warehouses,movements}/**, GET /api/orgs/dashboard (aggregate summaries per module)"],
            ["Business Workspace (finance)", "/api/orgs/finance/invoices/** (incl. [id]/transition, [id]/activity), /api/orgs/finance/expenses/** (incl. [id]/attachments, [id]/transition), /api/orgs/finance/payments/** (incl. [id]/approve), GET /api/orgs/finance/reports (?type=revenue|expenses|outstanding|paid-unpaid&format=json|csv)"],
            ["Business Workspace (HR)", "/api/orgs/hr/employees/** (incl. [id]/attachments, [id]/leave-balance, [id]/transition, [id]/activity), /api/orgs/hr/leave-requests/** (incl. [id]/transition), POST|DELETE /api/orgs/hr/departments/[id]/manager"],
            ["Business Workspace (finance/HR cron)", "GET /api/cron/invoices-mark-overdue (CRON_SECRET-gated, nightly SENT→OVERDUE flip)"],
            ["RAG (public, via existing assistants)", "Consumed inside POST /api/ai/chat (Docs), /api/ai/security-chat, /api/ai/learn-chat — no separate public RAG endpoint"],
            ["RAG (admin)", "GET /api/admin/rag/stats, POST /api/admin/rag/reingest"],
            ["RAG (cron)", "GET /api/cron/rag-reingest (CRON_SECRET-gated)"],
            ["Data Room (public)", "POST /api/dataroom/request-access, GET /api/dataroom/verify, GET /api/dataroom/session, POST /api/dataroom/accept-nda, GET /api/dataroom/documents, GET /api/dataroom/documents/[id]/stream, POST /api/dataroom/documents/[id]/view-event"],
            ["Data Room (admin)", "GET|POST /api/admin/dataroom/documents, DELETE /api/admin/dataroom/documents/[id], GET /api/admin/dataroom/visitors, POST /api/admin/dataroom/visitors/[id]/revoke"],
            ["Nodes", "POST /api/nodes/register, POST /api/nodes/heartbeat, GET /api/nodes/settlements/release (cron)"],
            ["Referrals", "POST /api/referrals/{activate,initiate,webhook}, GET /api/referrals/{status,history,leaderboard}"],
            ["Watcher Pioneer", "POST /api/watcher/{enroll,qualify}, GET /api/watcher/status"],
            ["Activity", "POST /api/activity/ping, GET /api/admin/activity"],
            ["Other", "POST /api/faucet, POST /api/stripe-webhook, POST /api/create-payg-checkout-session, POST /api/feedback/submit, POST /api/feedback/upload, GET /api/admin/feedback"],
          ],
        },
      ],
    },
    {
      number: "07",
      title: "MongoDB Collections Reference",
      blocks: [
        {
          type: "table",
          headers: ["Collection group", "Key collections"],
          rows: [
            ["Security", "security_reports, security_threats, security_policy, security_events, security_reputation_cache"],
            ["Learn", "learn_saved, learn_progress, learn_search_cache (TTL 24h), learn_video_cache (TTL 24h), learn_reports, learn_analytics_events"],
            ["Business Workspace (core)", "orgs, org_members, sessions, magic_links, departments, projects, documents, document_permissions, document_shares, document_activity, project_members"],
            ["Business Operations", "tasks, crm_contacts, crm_deals, suppliers, purchase_requests, purchase_orders, warehouses, products, stock_levels, stock_movements, org_activity (one shared domain-generic audit log for every module below, not just Business Operations)"],
            ["Finance & HR", "invoices, expenses, payments, employees, leave_requests, attachments (shared metadata store — EXPENSE and EMPLOYEE relatedRecordType)"],
            ["RAG", "rag_chunks (with Atlas Vector Search + Atlas Search indexes), rag_sources, rag_ingestion_runs, rag_query_log, rag_embedding_cache"],
            ["Data Room", "dataroom_documents, dataroom_visitors, dataroom_magic_links, dataroom_sessions, dataroom_views"],
            ["Activity", "activity_pings — one doc per {surface, identityId, date}, unique compound index"],
            ["Referrals / Watcher Pioneer / Feedback", "referrals, watcher_enrollments, feedback_submissions (each with their own lib.js as listed in Section 05)"],
          ],
        },
      ],
    },
    {
      number: "08",
      title: "AI Assistant Tool-Calling Pattern",
      blocks: [
        {
          type: "lead",
          text: "Identical shape across all four assistants (src/app/api/ai/{chat,business-chat,security-chat,learn-chat}/route.js) — chat/route.js is the Docs Assistant, the other three are named for their domain:",
        },
        {
          type: "bullets",
          items: [
            "Model: gemini-flash-latest, thinkingConfig: { thinkingLevel: \"low\" }, maxOutputTokens: 800",
            "MAX_TOOL_ROUNDS = 5 — a bounded loop of generateContent → check functionCalls → run tools → feed functionResponse back in",
            "generateContentWithRetry() — retries on HTTP 429/503 with a [700ms, 1800ms] backoff schedule",
            "Route-level: maxDuration = 90, not streaming (deliberate — unpredictable number of tool round-trips before a final answer)",
            "Per-assistant: buildXContext() computed once per request, X_TOOL_DECLARATIONS (Gemini Type.OBJECT schemas), runXTool(name, args, ctx) dispatcher, xSystemInstruction() builder",
          ],
        },
      ],
    },
    {
      number: "09",
      title: "Auth Patterns — Technical Detail",
      blocks: [
        {
          type: "table",
          headers: ["Pattern", "Implementation detail"],
          rows: [
            ["Wallet signed-message", "ethers.verifyMessage(reconstructedMessage, signature) === expectedAddress, 5-minute timestamp freshness window, reimplemented per-feature (metadata-auth.js has the canonical version, security.js/watcherPioneer.js reimplement locally by convention)"],
            ["Magic-link", "generateToken() (random), hashToken() (stored hashed, never plaintext), TTL-indexed Mongo collection, consumeLoginToken() atomic findOneAndUpdate to prevent replay"],
            ["Session (web)", "HttpOnly cookie, createSession(email) helper in orgs.js"],
            ["Session (mobile)", "Bearer token, same session concept, stored via expo-secure-store"],
            ["Share tokens", "generateShareToken()/hashShareToken(), atomic findOneAndUpdate-based single-consume pattern (document-permissions.js), reused as a template for Data Room's magic-link tokens"],
          ],
        },
      ],
    },
    {
      number: "10",
      title: "Testing & Verification Conventions",
      blocks: [
        {
          type: "bullets",
          items: [
            "Hardhat tests: test/security-layer.test.js (17 tests — access control, confirm/re-confirm, false-positive override, 4-signer simulation)",
            "Node backend tests: test/*.test.mjs run via node --test against a real MongoDB instance (not mocked) — security.test.mjs (11), learn.test.mjs, dataroom.test.mjs, activity.test.mjs, feedback.test.mjs, watcher-pioneer.test.mjs — 140/140 passing as of the Security Layer build, no regressions",
            "Business Operations: business-operations-tasks.test.mjs, crm-workflow.test.mjs, procurement-workflow.test.mjs (incl. real inventory-ledger integration — a receipt genuinely moves stock), document-permissions.test.mjs",
            "Finance & HR: finance-workflow.test.mjs (8 tests — invoice lifecycle, cron overdue-flip + idempotency, org isolation, expense approval gate, payment record→approve replay-safety), hr-workflow.test.mjs (9 tests — employee lifecycle, leave approval + computed-balance correctness, self-access vs. HR-role vs. Department Manager scope) — both caught real bugs before shipping: a race condition in PO receiving (stock movements were applying before the PO's own optimistic-concurrency-guarded update), and a Department Manager visibility bug in getAccessibleScope() (Section 12)",
            "RAG: rag-ingestion.test.mjs, rag-security.test.mjs, rag-attribution.test.mjs, rag-learn-transcript.test.mjs, rag-retrieval.test.mjs (28 tests total) — run against the real Atlas cluster and real Gemini embeddings, not mocked; the relevance threshold (Section 11) was empirically calibrated from live measurements taken during this test work, not guessed",
            "On-chain simulation: scripts/simulate-security-nodes.js — 4 throwaway signers report a clearly-fake test indicator end-to-end through to a real on-chain confirmThreat() transaction on BSC Testnet",
            "Manual browser verification is the norm for UI work in this codebase — curl/fetch checks for API correctness, then a real browser pass (or explicit statement that one hasn't happened yet) before anything is called \"verified\"",
          ],
        },
      ],
    },
    {
      number: "11",
      title: "RAG Pipeline — Function Reference",
      blocks: [
        {
          type: "table",
          headers: ["Function", "File", "Purpose"],
          rows: [
            ["chunkMarkdownByHeading() / chunkParagraphs() / chunkStructuredSections() / chunkQaPairs()", "rag/chunking.js", "Source-shape-specific chunkers — structured-sections for fundraising-docs' {sections:[{blocks}]} shape, qa-pairs for FAQ arrays, heading-split for markdown, paragraph-split as the fallback"],
            ["embedText() / embedChunkText() / embedQueryText()", "rag/embeddings.js", "Wraps Gemini's models.embedContent (gemini-embedding-001, 768 dims) — RETRIEVAL_DOCUMENT taskType for ingestion, RETRIEVAL_QUERY for search; content-hash-cached in rag_embedding_cache"],
            ["sanitizeChunkText() / wrapContextBlock()", "rag/sanitize.js", "Injection-pattern neutralization before a chunk is ever fed into a model prompt, and delimited wrapping so retrieved context can't be confused with the system prompt"],
            ["ensureIndexes() / upsertChunks() / deleteBySource() / deleteObsoleteChunks() / hybridSearch()", "rag/vectorStore.js", "Idempotent index creation ($vectorSearch + $search via collection.createSearchIndex()); hybridSearch() runs both queries and merges via Reciprocal Rank Fusion in application code"],
            ["retrieveContext() / formatAttribution()", "rag/retrieve.js", "The one function every assistant calls. DEFAULT_MIN_RELEVANCE = 0.8 — hasResults gates purely on top vector score, no keyword-match override (removed after it let one irrelevant query pass)"],
            ["ingestSource() / ingestAllStaticSources() / deleteSource()", "rag/ingest.js", "Content-hash diffing per source: insert new chunks, update changed ones, skip unchanged ones, remove chunks whose source content no longer produces them"],
            ["fetchYouTubeTranscript(videoId)", "rag/youtubeTranscript.js", "Scrapes the public timedtext caption-track URL out of a video's watch-page HTML — unofficial (the official Data API's captions.download needs OAuth as the channel owner), always fails gracefully to null, never throws"],
            ["recordRetrieval() / recordIngestionRun()", "rag/metrics.js", "Writes to rag_query_log / rag_ingestion_runs — fail-open, a metrics write never blocks the actual retrieval/ingestion it's recording"],
          ],
        },
        {
          type: "note",
          text: "DOCS_SOURCES (rag/sources/docsSources.js) covers inaya-knowledge.js, business-workspace-guide.md, the FAQ page's faqs export, and all 15 scripts/fundraising-docs/content/*.js files — explicitly excluding custody-sdk's own docs (a nested, separately-git-excluded repo — see Section 20's build-breakage history for why touching it at all is risky) and the legacy KNOWLEDGE_ARTICLES collection.",
        },
      ],
    },
    {
      number: "12",
      title: "Business Operations & Finance/HR — Workflow Reference",
      blocks: [
        {
          type: "lead",
          text: "Every transition below follows the same shape: one findOneAndUpdate({..., status: fromState}, {$set: {status: toState}}) — a mismatched current status is a clean 409, no extra locking needed.",
        },
        {
          type: "table",
          headers: ["Module", "Transitions"],
          rows: [
            ["task-workflow.js", "submit: DRAFT→IN_PROGRESS, complete: IN_PROGRESS→DONE, reopen: DONE→IN_PROGRESS, cancel: *→CANCELLED"],
            ["deal-workflow.js", "stage transitions across the pipeline, terminal: →WON / →LOST"],
            ["purchase-request-workflow.js", "submit: DRAFT→PENDING_APPROVAL, approve/reject: PENDING_APPROVAL→APPROVED|REJECTED (requiresManage), cancel: DRAFT|PENDING_APPROVAL→CANCELLED"],
            ["purchase-order-workflow.js", "submit→approve→order→receive (partial and full) — receivePurchaseOrder() applies inventory stock movements only AFTER the PO's own optimistic-concurrency-guarded status update succeeds (reordered after a real race condition was caught — see Section 10)"],
            ["invoice-workflow.js", "send: DRAFT→SENT, markPaid: SENT|OVERDUE→PAID, cancel: DRAFT|SENT|OVERDUE→CANCELLED, markOverdueInvoices() (cron-only): SENT→OVERDUE"],
            ["expense-workflow.js", "submit: DRAFT→PENDING_APPROVAL, approve/reject: PENDING_APPROVAL→APPROVED|REJECTED (requiresManage: canManageFinance), cancel: DRAFT|PENDING_APPROVAL→CANCELLED"],
            ["employee-workflow.js", "activate: ONBOARDING→ACTIVE, placeOnLeave: ACTIVE→ON_LEAVE, returnFromLeave: ON_LEAVE→ACTIVE, terminate: ACTIVE|ON_LEAVE→TERMINATED (requiresManage: canManageHR)"],
            ["leave-workflow.js", "approve/reject: PENDING→APPROVED|REJECTED (requiresManage: canManageHR), cancel: PENDING→CANCELLED (requester or canManageHR); getLeaveBalance() = annualLeaveAllocationDays − sum(this year's APPROVED day-spans), computed on every call"],
          ],
        },
        {
          type: "note",
          label: "getAccessibleScope() extension pattern.",
          text: "Each module adds its own visibleX array (visibleTasks, visibleContacts, visibleInvoices, visibleEmployees, ...) to the same resolver rather than each having a separate scope function. Finance's arrays are gated by canAccessFinance on top of department scope; HR's visibleEmployees unions HR-scoped employees, Department-Manager-scoped employees (managedDepartmentIds — NOT filtered against the caller's own already-visible departments, a real bug fixed during this layer's testing, see the founder architecture doc's Section 24), and the caller's own self-record, deduplicated by _id.",
        },
      ],
    },
    {
      number: "13",
      title: "Multi-Chain Bridge & Interop Reference (September 2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function / contract", "Purpose"],
          rows: [
            ["InayaTokenBridgeHome.bridgeOut(...)", "BSC-side lock/burn entry point, source of every cross-chain transfer"],
            ["InayaTokenBridgeSpoke.executeMessage(...) / receive_message(...)", "Remote-chain entry point (EVM name / Solana-Move name) — validates threshold validator signatures, mints/releases on the destination"],
            ["InayaChainRegistry.setSpokeBridgeAddress() / registerRemoteChain() / setTrustedRemoteContract()", "Owner-only wiring — a chain has no real route until all three are called for it, not just deployed"],
            ["listChainCapabilities() / getChainCapability(chainId)", "src/lib/chain-adapters/registry.js — the single source a UI reads before ever describing a chain as 'supported'; SUPPORT_LEVELS run DISCOVERED(0) → READ_ONLY → WALLET → MESSAGE → TOKEN_TRANSFER → STAKING → FULL_ECOSYSTEM(6), each backfilled only from what's actually been verified"],
            ["WormholeProvider.js", "Wraps Wormhole's WTT/lock-and-mint flow; chain-id mapping is the thing that broke first (Sepolia/testnet IDs differ from their mainnet counterparts unlike BSC/Avalanche)"],
            ["GET/POST /api/interop/wtt/{initiate,relay,status}", "Relay cron (*/5 min) fetches the Guardian-signed VAA via a plain REST call to Wormholescan's public API (not the @wormhole-foundation/sdk package — that broke the Next.js build, see Section 26 of the architecture doc) and completes the transfer via Inaya's relayer wallet"],
          ],
        },
        {
          type: "note",
          text: "Per-chain proof records (real tx hashes both sides): deployments/bridge/{avalancheFuji,solanaDevnet,hederaTestnet,aptosTestnet,suiTestnet}.json; deployments/interop/wormhole-wtt/bscTestnet-attestation.json.",
        },
      ],
    },
    {
      number: "14",
      title: "Storage Backup & Redundancy Reference (September 2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function / contract", "Purpose"],
          rows: [
            ["InayaBackupRegistry.sol", "0x062c341aE4f11CB1dEa1B0D3930d52902F97f48a (BSC Testnet) — records redundancy commitment + health-state transitions only, never replica data"],
            ["InayaKernel.Backup.getBackupStatus / getBackupHealth / getRedundancyStatus / getRecoveryStatus / requestRecovery", "custody-sdk client, published to npm"],
            ["Health states", "PROTECTED / REBUILDING / DEGRADED / RECOVERY_REQUIRED / RECOVERY_FAILED — pure state machine, 19/19 unit tests"],
            ["Pin-status check", "Every 15 min, 3-strike grace window before flagging a replica"],
            ["Integrity check", "Daily, content-hash comparison, zero grace — catches real corruption immediately"],
          ],
        },
        {
          type: "note",
          text: "Providers: Pinata + Filebase (S3-compatible, IPFS-backed, separate infrastructure/failure domain). Filebase gotcha: its S3 endpoint is s3.filebase.io, not .com; the AWS SDK's default auto-attached request checksum causes a generic AccessDenied against it unless disabled. Full writeup: docs/backup-redundancy-architecture.md.",
        },
      ],
    },
    {
      number: "15",
      title: "AI Guarded Execution & Audit Trail Reference (September 2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function", "Purpose"],
          rows: [
            ["proposeAiAction({orgId, assistantSurface, toolName, targetRecordType, targetRecordId, proposedAction, args, actorEmail, canPropose})", "Inserts a PENDING_APPROVAL request; idempotencyKey = sha256(orgId+toolName+targetRecordId+args+hourBucket) dedupes same-hour repeats"],
            ["reviewAiAction(..., canApprove)", "Approve sets unlockAt = now + 36h (SETTLEMENT_DELAY_MS); reject is terminal"],
            ["classifyRisk(targetRecordType, proposedAction)", "Never returns undefined — unmatched combinations default MEDIUM; EXPENSE/INVOICE/PURCHASE_ORDER default HIGH"],
            ["api/cron/execute-approved-ai-actions", "The only code path that calls a real transitionX() for an AI-originated change, and only once unlockAt has passed; runs as a synthetic org-manager membership, attributed in the log to the human approver"],
            ["appendAuditEntry({orgId, recordType, recordId, actorEmail, action, previousState, newState, metadata})", "src/lib/auditChain.js — entryHash = sha256(prevHash + canonicalJSON(eventFields)); optimistic CAS on audit_chain_heads, retries on conflict, never corrupts under contention"],
            ["verifyChainIntegrity(orgId)", "Walks the full chain, recomputes every hash; returns {valid:false, brokenAtSeq, reason} on the first mismatch (gap/reorder, prevHash mismatch, or content altered after write)"],
            ["GET /api/orgs/audit/export?orgId=&format=json|csv", "Org-scoped (owner/admin only) full-chain export — every field needed to independently recompute and verify, so a customer never has to trust a UI badge"],
          ],
        },
        {
          type: "note",
          text: "9 gated domains (EXECUTORS map in ai-action-requests.js): TASK, EXPENSE, DOCUMENT, EMPLOYEE, INVOICE, LEAVE_REQUEST, PURCHASE_ORDER, PURCHASE_REQUEST, DEAL — one corresponding propose_* tool each in ai-business-tools.js. State machine: PENDING_APPROVAL → APPROVED → QUEUED → EXECUTED|EXPIRED, or PENDING_APPROVAL → REJECTED, or APPROVED → CANCELLED (only before unlockAt). 19 automated tests, 11 adversarial.",
        },
      ],
    },
    {
      number: "16",
      title: "Web3 App Store, NFT Vault & MFA Reference (September 2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function / route", "Purpose"],
          rows: [
            ["submitAppListing / listApprovedListings / listPendingListings / listListingsBySubmitter / reviewAppListing", "src/lib/appStoreListings.js — full submission→threat-check→review→approve pipeline"],
            ["POST /api/apps/submit, GET /api/apps/listings, GET /api/apps/my-listings", "Developer-facing App Store API"],
            ["GET /api/admin/app-store/pending, POST /api/admin/app-store/[slug]/review", "Admin review queue, passphrase-gated same as /admin/audit"],
            ["src/app/apps/embed/[slug]/page.js", "Sandboxed iframe host for externally-hosted app submissions — no allow-same-origin + allow-scripts together"],
            ["checkNftContractSupport / discoverOwnedTokens", "src/lib/nftDiscovery.js — ERC-721 + Enumerable only, no indexer"],
            ["signNftBackup", "src/lib/nftBackupAuth.js — wallet-signature auth reused for NFT backup requests"],
            ["POST /api/nft/backup, GET /api/nft/backups", "NFT Vault backup API"],
            ["src/components/AddressRiskCheck.js", "Debounced live Security Layer threat-registry check, wired into the Bridge page's recipient field"],
            ["MfaSettings.js / MfaVerifyScreen.js", "TOTP + Firebase-Phone-Auth SMS MFA for Business Workspace login"],
          ],
        },
      ],
    },
    {
      number: "17",
      title: "Sovereign Enterprise OS Reference (September 2026)",
      blocks: [
        {
          type: "table",
          headers: ["Module", "Key exports / functions"],
          rows: [
            ["src/contexts/OrgContext.js", "OrgProvider, useOrg() → {email, membership, orgId, role, orgs, switchOrg, logout, can: {manageOrg, accessDepartment, manageFinance, accessFinance, manageHR, accessHR, isDepartmentManager}}"],
            ["src/contexts/WalletContext.js", "WalletProvider, useWallet() → {walletAddress, walletBalance, isConnected, selectedWalletName, signMessage}"],
            ["src/lib/orgGates.js", "Client-safe extraction of orgs.js's 7 pure permission gates — re-exported from orgs.js under the same names for the ~60 existing server-side importers"],
            ["src/lib/trustHealth.js", "computeTrustHealthSnapshot({scope:\"org\"|\"wallet\", ...}) → {overallStatus, auditTrail|security, aiActions|backup, businessHealth, scopeNotes}"],
            ["GET /api/orgs/trust-health, GET /api/wallet/trust-health", "Org: requireMembership-gated. Wallet: unauthenticated, aggregate counts only"],
            ["src/lib/notifications.js", "createNotification (idempotent on dedupeKey), listNotificationsFor, markRead, markAllRead — collections: notifications, notification_reads"],
            ["GET/POST /api/orgs/notifications/*, /api/wallet/notifications/*", "Org: session-cookie auth. Wallet: GET unauthenticated, mutations signed via verifyMetadataAuth's existing message format"],
            ["src/lib/orgSearch.js, src/lib/walletSearch.js", "searchOrg({orgId, membership, email, query}) over getAccessibleScope(); searchWallet({walletAddress, query}) over metadata_files"],
            ["src/components/CommandPalette.js", "Cmd/Ctrl+K overlay, surface-agnostic — onSelect(result) left to the caller's own real navigation function"],
            ["src/lib/activityCenter.js", "generateWhatChanged({scope, ..., period}) → {sections: [{module, bullets}]}; reuses business-brief.js's BRIEF_PERIODS"],
            ["src/lib/ai-os-router.js", "buildOsContext, getOsToolDeclarations(scope), runOsTool(name, args, ctx), osSystemInstruction — business_/security_ prefixed dispatch"],
            ["POST /api/ai/os-chat, POST /api/ai/os-chat-wallet", "Org: requireMembership-gated. Wallet: identityId passed directly, matching security-chat's existing precedent"],
            ["src/components/business/OsHomeView.js, src/components/OsHomeSection.js", "The composed OS Home screen per surface — TrustHealthCard, OS Assistant widget, What-Changed preview, module tiles, surfaced links"],
            ["open_module_window(label, path)", "Tauri command, both inaya-desktop and inaya-dapp-desktop's src-tauri/src/lib.rs — pops a module into its own native window"],
          ],
        },
        {
          type: "note",
          text: "Every org-scoped route follows the exact ensureOrgIndexes()+requireMembership()+getAccessibleScope()-or-narrower pattern dashboard/route.js already established; every wallet-scoped GET follows the same unauthenticated-aggregate-only trust tier as the pre-existing list-files/backup-status routes. No existing route, collection, or component was renamed, removed, or had its behavior changed — additive only.",
        },
      ],
    },
    {
      number: "18",
      title: "Healthcare & Legal OS Reference (September 2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function / route", "Purpose"],
          rows: [
            ["health-patients.js: createPatient, assignCareTeamMember, findDuplicatePatientCandidates, mergePatients", "Patient registry; care-team assignment is the join row getAccessibleScope() reads for visibility"],
            ["health-clinical-workflow.js: TRANSITIONS (draft→review→sign→lock), amendClinicalRecord", "Locked records are never overwritten — amend creates a new linked record, marks the original AMENDED"],
            ["health-consent-workflow.js, health-roi-workflow.js, health-breakglass.js", "Consent record/withdraw; ROI request→authorize→review (hands off to export-center.js); break-glass = a real time-limited care-team assignment, not a bypass path"],
            ["legal-matter-workflow.js: createMatter, assignMatterTeamMember; legal-conflict-workflow.js: searchConflicts, recordConflictCheck", "Matter lifecycle + team assignment; conflict status is always potential/cleared/escalated, never a raw boolean"],
            ["legal-evidence.js, legal-custody.js: recordCustodyEvent; legal-hold-workflow.js: createLegalHold, releaseLegalHold", "Evidence metadata over an org_documents FK; every custody event chained via appendAuditEntry; holds gate retention.js's checkDispositionAllowed()"],
            ["trust-accounting.js: recordDeposit, recordWithdrawal, getMatterTrustBalance", "Atomic balance recheck before every withdrawal — no jurisdictional (IOLTA) compliance claimed"],
            ["ai-health-tools.js, ai-legal-tools.js", "buildXContext/X_TOOL_DECLARATIONS/runXTool/xSystemInstruction — read/summarize/draft only, wired into ai-os-router.js with health_/legal_ prefixes"],
            ["industry-config.js: requireVertical(orgId, expectedVertical)", "The door-lock — every Health/Legal route calls this right after requireMembership(); 403 on any mismatch, fail-closed as 'general' with no vertical set"],
            ["25 routes under /api/orgs/health/*, /api/orgs/legal/*", "Patients, consents, ROI, break-glass, appointments, billing, care-team, research (health); clients, prospects, matters, matter-team, conflict-checks, evidence, holds, discovery, redaction, deadlines, contracts, entities, trust-accounting, time-entries, billing (legal)"],
            ["HealthView.js, LegalView.js (src/components/business/)", "The only two modules with an actual screen today — registry/list + create + detail modal, mirroring CRMView.js's structure"],
            ["src/lib/integrations/{health,legal}/*Adapter.js + adapterStub.js", "13 documented third-party interfaces (FHIR, HL7, DICOM, lab, pharmacy, claims, e-filing, legal research, e-signature, email, calendar, accounting, SSO) — configured:false until real env credentials are present, never fabricated"],
          ],
        },
        {
          type: "note",
          text: "Patient/matter visibility is assignment-based (health_care_team_assignments/legal_matter_team_assignments), a genuinely different model from every other Business Workspace module's department-scoping — wired directly into getAccessibleScope() rather than a parallel resolver. 20 domain modules have real backend + API; only 2 (Patients, Matters) have a screen. Two real bugs were caught and fixed during this build (break-glass had no expiry enforcement; 14 POST route handlers referenced an out-of-scope variable after the vertical-lock was added) — both now covered by permanent regression tests.",
        },
      ],
    },
    {
      number: "19",
      title: "Financial Services & Regulated Enterprise OS Reference (2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function / route", "Purpose"],
          rows: [
            ["compliance-controls.js, compliance-evidence.js, control-testing.js", "Control library + evidence vault; a failed control test auto-opens a Finding via the shared finding lifecycle"],
            ["compliance-policies.js: createPolicyDraft→submitForReview→approve→publishPolicy, amendPolicy", "Publish sets immutable:true; amendPolicy is the ONLY path forward from PUBLISHED, always inserting version+1, never mutating the published row"],
            ["regulatory-examination-access.js: createExaminerMagicLink, exchangeMagicLink", "Scoped {examinationId, requestIds} access, deliberately its own token pattern (not a retrofit of the unrelated investor dataroom.js)"],
            ["financial-entities.js, financial-funds.js: isFundTeamMember", "Entity-scoped fund visibility — same assignment-based shape as isCareTeamMember/isMatterTeamMember"],
            ["investment-committee.js, cap-table.js, board-management.js", "IC decision lifecycle (finalized decisions are versioned, never overwritten); cap-table is an ingest/evidence layer, never a transactional share registry"],
            ["privileged-access.js: requestElevation→approveElevation, grantBreakGlass, reviewSession", "Cross-vertical from day one — the approver must be a different person than the requester; break-glass is ACTIVE immediately but always forces a post-event review"],
            ["integrations.js: INTEGRATION_PROVIDERS, configureIntegration, recordSyncRun", "A connection can only ever reach ACTIVE through a real recorded sync run — never through configuration alone"],
            ["ai-audit-tools.js, ai-regulatory-tools.js + 7 more role-specific copilots", "All 100% read/summarize/flag — a compliance-certification request is refused at the tool layer before any summarization runs"],
            ["~20 API subtrees under /api/orgs/{regulated,financial,private-capital}/*", "Every route: ensureOrgIndexes → requireMembership → requireVertical → lib call, statically verified by vertical-lock-wiring.test.mjs"],
            ["RegulatedView.js, FinancialView.js (src/components/business/)", "Full tab-router UI — Controls, Evidence, Findings, Policies, Risk, Audits, Examinations, Dashboard (Regulated); equivalent depth for Financial"],
          ],
        },
        {
          type: "note",
          text: "All ten SOW phases are live-verified end-to-end on web: control creation/testing/finding lifecycle, the policy publish-immutability guard, an examiner magic-link's one-time-use cycle, entity-scoped fund/deal visibility, and the board-report/export-package immutability guards. Nothing on inaya-mobile for any of these three verticals yet. Every third-party integration (fund admin, custodian, KYC/AML, etc.) is a documented, honest not-configured stub.",
        },
      ],
    },
    {
      number: "20",
      title: "Government & Public Sector Sovereign OS Reference (2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function / route", "Purpose"],
          rows: [
            ["citizen-records.js: createCitizenRecord, assignCitizenRecord, requireCitizenRecordAccess", "requireCitizenRecordAccess() is the load-bearing gate — department membership or governmentRole:'staff' alone is never enough, only an explicit assignment (or org owner/admin) grants access to one specific record"],
            ["government-cases.js: CASE_STATES (OPEN→ASSIGNED→IN_PROGRESS→PENDING_REVIEW→RESOLVED→CLOSED)", "Same TRANSITIONS-map + atomic findOneAndUpdate template as incidents.js; a case linked to a citizen record inherits that record's need-to-know check"],
            ["policy-knowledge-base.js: createEntryDraft→publishEntry, amendEntry", "compliance-policies.js's exact publish-immutable lifecycle, recontextualized — no updateEntryDraft() path reachable once PUBLISHED"],
            ["government-audit.js: logCitizenRecordAccess, logGovernmentDocumentRead", "Government-vertical-only: every document READ is chain-logged, not just writes — an additive branch inside the existing retrieve route, gated so no other vertical's behavior changes"],
            ["government-dashboard.js: getGovernmentDashboard", "Operations + security readiness as two separate honest panels — a fresh org with zero audit-chain entries reports 'unknown,' never a fabricated 'valid'"],
            ["ai-government-tools.js: search_citizen_records, summarize_case, get_dashboard_summary", "100% read-only; need-to-know is re-checked INSIDE the tool per record, not just trusted from the API layer above it"],
            ["privileged-access.js (reused, zero new code)", "Break-glass access for Government orgs — already cross-vertical since §33, no government-specific fork needed"],
            ["integrations.js: 5 new government_systems providers", "Civil/national ID registry, legacy government ERP, GIS/land records, public records portal, interagency data exchange — all configured:false stubs"],
            ["11 routes under /api/orgs/government/*", "citizen-records (+assign), cases (+transition), policy-kb (+transition/publish/amend), dashboard — statically verified by the extended vertical-lock-wiring.test.mjs"],
            ["GovernmentView.js (src/components/business/)", "Tab-router UI — Citizen Records, Cases, Policy Knowledge Base, Dashboard — wired into the Business Workspace nav and org-creation flow, confirmed rendering live"],
          ],
        },
        {
          type: "note",
          text: "51 new automated tests, including the two load-bearing properties written before their implementation: citizen-record access requires an actual assignment, and a published policy knowledge base entry can never be mutated in place. Nothing on inaya-mobile yet. No government certification, accreditation, FedRAMP authorization, or jurisdiction-specific compliance claim exists or is claimed anywhere.",
        },
      ],
    },
    {
      number: "21",
      title: "Institutional Trust Infrastructure Reference (September 2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function / route", "Purpose"],
          rows: [
            ["evidence.js: getEvidenceTrail, verifyOrgEvidenceIntegrity, exportEvidencePackage", "Read-only merge of listOrgActivityForRecord() + linked aiActionRequests into one timeline; integrity check is a pass-through to auditChain.js's verifyChainIntegrity()"],
            ["org-trust.js: proposeTrustRelationship, respond, revokeTrustRelationship, isTrustedAccess", "New orgTrustRelationships collection; accept/reject filtered by findOneAndUpdate({toOrgId: caller}) so an org can never approve its own proposal; isTrustedAccess is a query primitive no other module calls yet"],
            ["POST/GET /api/orgs/trust-relationships, PATCH /api/orgs/trust-relationships/[relationshipId]", "Session-authenticated cross-org trust CRUD"],
            ["api-keys.js: generateToken/hashToken convention, requireApiKey", "Raw key shown once at creation, only hash persisted; resolves to a synthetic owner-level membership permanently bound to the key's own orgId — no request parameter can override it"],
            ["POST/GET /api/orgs/api-keys, DELETE .../[apiKeyId]", "Session-authenticated key management, owner/admin only"],
            ["GET /api/public/v1/audit/verify, /api/public/v1/evidence, /api/public/v1/permissions/check", "API-key-authenticated (Bearer). evidence requires both recordType+recordId (no org-wide dump); permissions/check reports an org-level capability flag, not per-user RBAC"],
            ["institutional-attention.js: getAttentionItems", "AI-tool-only (get_attention_items in ai-os-router.js), not a REST route; merges pending-approvals (re-checked against the real approval gate), overdue tasks, pending documents"],
            ["src/app/trust/page.js — /trust", "Public, unauthenticated. Client-side verifier reimplements auditChain.js's hash formula via Web Crypto; auto-detects genesis vs. scoped exports (fixed in 9345df5) and reports the correct guarantee strength for each"],
          ],
        },
        {
          type: "note",
          text: "Zero mainnet references across every file/route touched by this section, confirmed by direct grep. Every module ships a co-located test file (org-trust, evidence, institutional-attention, api-keys), none mocked against a fake database.",
        },
      ],
    },
    {
      number: "22",
      title: "Autonomous Resilience Layer Reference (September 2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function / route", "Purpose"],
          rows: [
            ["resilience-policy.js: createPolicy, updatePolicy, evaluateRtoRpo", "requiredRTOMinutes/RPOMinutes + critical-asset categories + test frequency; evaluateRtoRpo is a plain actual<=required comparison, no fuzzy scoring"],
            ["resilience-canary.js: ensureResilienceHome, createCanaryAsset", "Synthetic org-owned documents (isResilienceCanary:true, hidden from normal browsing) pushed through the real InayaKernel.disperseAndSlice() + real pinning-provider .pin() + real backupEngine.replicateShard() — never a mock of these functions"],
            ["resilience-orchestrator.js: runResilienceTest, runScheduledResilienceTests", "13-step test: real reconstruction via InayaKernel.reconstructAndDecrypt(), real getPinStatus() dependency check, real getDocumentAccessLevel() permission check, wall-clock RTO, replica-staleness-based RPO; atomic RUNNING-status duplicate-run guard"],
            ["GET /api/cron/resilience-tests", "CRON_SECRET Bearer-gated daily sweep, registered in vercel.json; per-policy try/catch so one broken policy never blocks the rest"],
            ["resilience-status.js: deriveState", "Pure function → Unknown / Test Due / Verified / Failed / Degraded, unit-tested directly; a PAUSED policy always reports Unknown regardless of test history"],
            ["GET /api/orgs/resilience/status, POST /api/orgs/resilience/policies/[policyId]/run", "Dashboard read + manual 'Run now' (canManageOrg-gated, triggeredBy:'manual' vs. cron's 'schedule')"],
            ["ai-resilience-tools.js: get_resilience_status, get_last_test_result, list_failed_assets, explain_test_failure, trigger_resilience_test_now", "First four are structurally read-only (no mutation code path exists); trigger_resilience_test_now can only start the same non-destructive test the cron runs, kept outside Guarded Execution because there is no destructive-workflow surface for it to gate"],
          ],
        },
        {
          type: "note",
          text: "Two small, additive fixes to the pre-existing backupEngine.js's replicateShard() (expose providerRef; accept an explicit primaryProviderRef) were required and made in this same pass, both non-breaking. Verified live against real Filebase network calls during development.",
        },
      ],
    },
    {
      number: "23",
      title: "Node Operator Dashboard Reference (September 2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function / route", "Purpose"],
          rows: [
            ["nodeOperatorAuth.js: loginWithWalletSignature, requireNodeSession, linkWalletToSession", "New node_sessions collection, 12h cookie (inaya_node_session), reuses the existing verifyNodeAuth() signature check unchanged; fleet-linking requires the linked wallet's own signature"],
            ["nodeUptimeHistory.js: getUptimeForWindow", "Hourly-cron-populated node_uptime_snapshots; sets insufficientData:true and reports the real coverage window rather than backfilling or estimating history it doesn't have"],
            ["nodeChainReads.js: getOnChainNodeInfo", "Real ethers.JsonRpcProvider reads against the deployed node-registry contract (same address the existing settlement-release cron uses); tier/commission explicitly sourced on_chain since the off-chain Mongo tier field is set once and never revisited; fails honest-empty, never fabricates a tier"],
            ["GET /api/nodes/operator/{me,uptime,qualification,rewards,events,network,fleet}, POST .../link, .../login, .../logout", "network is the only unauthenticated route (public aggregate stats); every other route scopes strictly to the session's own wallet — no client-supplied node ID is ever trusted"],
            ["GET /api/cron/nodes-snapshot", "Bearer CRON_SECRET-gated hourly snapshot job, registered in vercel.json"],
            ["src/app/operator/page.js + OperatorOverview/Uptime/Qualification/Rewards/Events/Network/Fleet.js", "Seven-tab dashboard, standalone MetaMask connect-and-sign login independent of the dApp's WalletContext and Business Workspace's session"],
          ],
        },
        {
          type: "note",
          text: "No claim/release control anywhere in the dashboard — settlement stays fully automated by the pre-existing timelock cron. Public /network reports off-chain tier distribution, not a live per-node chain read, an explicitly disclosed scalability trade-off. Tested with real ethers.Wallet signatures, treated internally as the highest-risk new surface in this pass.",
        },
      ],
    },
    {
      number: "24",
      title: "Four New Business Primitives Reference: Sign, DePIN Storage, Escrow, Attestation (September 2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function / route", "Purpose"],
          rows: [
            ["signing-workflow.js: recordSignature, verifyInayaSignSignature, anchorSigningRequestOnChain, verifySigningRequest", "Wallet path = real ethers.verifyMessage() ECDSA check, 5-min freshness window; session_consent path is explicitly labeled, never presented as equivalent; anchor is a real, optional transaction (batchRegisterAssets on the existing custody contract) over a completion-certificate hash, not a per-signature on-chain record"],
            ["storage-manager.js: registerOrgStorageNode, getOrgStorageOverview, reportOrgStorageNodeHealth", "New org-scoped control plane, confirmed unconnected to the public node-operator registry; eligibility is a static 'routing_not_yet_supported'; allocation/replica figures reused as-is from orgPlans.js + backupEngine.js, not recomputed"],
            ["escrow-workflow.js: transitionEscrow, confirmMilestone, releaseMilestonePayment", "State machine only flips a status field; the ONLY function moving money is releaseMilestonePayment, reachable only after a proposeAiAction() Guarded Execution approval plus the standard 36h SETTLEMENT_DELAY_MS; writes a real payments row, re-validates dispute status at execution time"],
            ["financial-attestation.js: buildCanonicalDataset, generateAttestation, verifyAttestation", "sha256 hash-commitment over real permission-scoped, currency-converted financial records; only revenue_threshold/expense_threshold implemented, solvency_threshold explicitly rejected (no assets/liabilities data model exists); verification independently re-runs the query and recomputes the commitment"],
            ["POST/GET routes under /api/orgs/sign, /api/orgs/escrow, /api/orgs/storage, /api/orgs/attestations (~19 routes)", "SignView, EscrowView, StorageManagerView, AttestationsView in src/components/business/ — real nav entries in page.js's Operations group, real org-scoped API-backed screens"],
          ],
        },
        {
          type: "note",
          text: "Each module's own header comment states plainly what's real vs. not: Escrow is never described as on-chain or non-custodial anywhere in its code, routes, or UI; Attestation names the specific ZK libraries confirmed absent from the full dependency tree to avoid that label being misapplied; DePIN Storage Manager's region preferences are always labeled Declared, never Active. A real nested-object canonicalization bug found while testing Attestation was also fixed in Sign's anchor certificate, which shared the same flaw. Test coverage: inaya-sign, milestone-escrow, depin-storage-manager, financial-attestation.",
        },
      ],
    },
    {
      number: "25",
      title: "Business Workspace Operational Enhancements & Guided AI Assistant Reference (September 2026)",
      blocks: [
        {
          type: "table",
          headers: ["Function / route", "Purpose"],
          rows: [
            ["finance/invoices/[invoiceId]/pdf/route.js", "Returns print-styled HTML, not a binary PDF — the route's own comment confirms no PDF library exists in the app; values pulled verbatim from the invoice record, never recalculated"],
            ["currency.js: convert, SUPPORTED_CURRENCIES, USD_RATES", "Static, explicitly dated reference-rate table (RATES_AS_OF), not a live FX feed by design; returns an error rather than guessing on unsupported pairs"],
            ["inventory.js: transferStock, recordStockMovement", "Two ledger movements + a materialized stock_levels update sharing one transferId; a real compensating ADJUSTMENT reversal if the second leg fails after the first commits"],
            ["purchase-order-workflow.js: updatePurchaseOrderItems", "Atomic findOneAndUpdate({status:'DRAFT'}) guard — editing outside DRAFT returns a real 409; reruns the same validator the create route uses"],
            ["procurement/orders/[orderId]/email, procurement/reports", "Real supplier email with real line items via the existing sendEmail() primitive (documented no-op if RESEND_API_KEY unset); 5 real report types incl. CSV export"],
            ["insights route.js + business-insights.js: computeBusinessInsights", "Real custom start/end date range on top of preset windows, validated (endDate<startDate → 400), computed via the same permission-scoped getAccessibleScope() every other route uses"],
            ["business-chat/route.js — Gemini (gemini-3.5-flash-lite) via @google/genai, Groq fallback", "Real, production-hardened LLM call: per-call timeout, request-level safety budget, retry-on-503 — added after an observed Gemini-queuing production issue"],
            ["guided-workflow-catalog.js (static data, no LLM calls) + guided-tasks.js (state machine)", "~10 hardcoded workflows; the model only ever relays pre-authored instruction text verbatim — structurally prevented from inventing step text; the task's own bookkeeping collection is the only thing it ever writes to"],
            ["GuidedTaskPanel.js + inaya:guided-nav / inaya:guided-po-created custom events", "Step advancement fires from real navigation events, real UI success events, or a manual 'I did this' confirmation — never the model's own assertion that a step is done"],
          ],
        },
        {
          type: "note",
          text: "Creating a new business record (contact, deal, PO, document) has no automated tool path at all — the assistant can only guide a human through the real UI. Any actual mutation it can propose still routes through the pre-existing Guarded Execution approval-plus-36-hour-delay pipeline described in §26/§31. No new mutation surface was added by the guided-task feature itself.",
        },
      ],
    },
  ],
};
