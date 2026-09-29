// SDK & Integration Guide — editable content. Source of truth for
// public/documents/inaya-sdk-guide.pdf. Edit this file, then run
// `node scripts/fundraising-docs/generate.mjs`. See README.md.
//
// (Updated 2026-09-29) @inaya-network/custody-sdk is now actually published
// to the public npm registry (both `beta` and `latest` tags point at
// 1.0.10-beta as of this update) — the "private repo, git install only"
// installation section below was accurate when this guide was first written
// but is not anymore, so it's corrected here rather than left stale on a PDF
// the live dApp links to. Also carries forward the earlier addition of a
// section on node-daemon, the separate published-npm CLI for node operators.
//
// This pass (2026-09-29) also added the API Quick Reference rows for eight
// real, exported, tested modules that five prior releases (1.0.6 through
// 1.0.10-beta) shipped but this guide never listed: TrustPlatform,
// IdentityIntegration, Analytics, Backup, AppStore, ComplianceProofs,
// Intent, Attestation, plus the standalone passkey backup/restore
// functions. Every one has its own passing test file in custody-sdk/test/.

export const sdkGuide = {
  cover: {
    company: "INAYA NETWORK",
    classification: "DEVELOPER DOCUMENTATION",
    kicker: "SDK & INTEGRATION GUIDE",
    title: "Inaya Custody SDK",
    subtitle: "Client-side cryptographic sovereignty for distributed applications.",
    docLine: "@inaya-network/custody-sdk · v1.0.10-beta · BNB Chain Testnet · September 2026",
  },
  docId: "INAYA-SDK-2026-V3",
  sections: [
    {
      number: "01",
      title: "Overview & Installation",
      blocks: [
        {
          type: "lead",
          text: "Encrypt and fragment a file in under 5 lines of code. Files are encrypted and split into two independent shards entirely in the caller's own runtime, before anything ever leaves the device.",
        },
        {
          type: "note",
          text: "Built on @noble/hashes and @noble/ciphers rather than the browser's crypto.subtle — deliberate, since React Native has no native SubtleCrypto implementation, and noble's pure-JS primitives produce byte-identical PBKDF2 keys and AES-GCM ciphertext, keeping shards decryptable across web, Node.js, and mobile alike.",
        },
        {
          type: "code",
          label: "Installation",
          text: "$ npm install @inaya-network/custody-sdk ethers",
        },
        {
          type: "bullets",
          items: [
            "Requirements: Node.js 18+, ethers v6 as a peer dependency.",
            "Two modes: browser (via InayaKernel.connectWallet()) or Node.js/server-side (pass a raw ethers.Wallet directly).",
            "Published on the public npm registry — both the `beta` and `latest` dist-tags currently point at the same 1.0.10-beta release, so a plain install with no tag suffix works.",
          ],
        },
      ],
    },
    {
      number: "02",
      title: "Step-by-Step: Upload a File",
      blocks: [
        {
          type: "code",
          label: "Step 1 — derive a vault key",
          text: "import { InayaKernel } from '@inaya-network/custody-sdk';\n\nconst passkey = 'user_secure_administrative_passkey';\nconst salt = InayaKernel.generateSecureSalt(16);\n\nconst vaultKey = await InayaKernel.deriveVaultKey({\n  passkey, salt, iterations: 100000, algo: 'HMAC-SHA256',\n});",
        },
        {
          type: "code",
          label: "Step 2 — encrypt & slice",
          text: "const { filename, shardAlpha, shardBeta } = await InayaKernel.disperseAndSlice({\n  file, encryptionKey: vaultKey,\n});\n// Pin shardAlpha/shardBeta to IPFS yourself (e.g. Pinata) — the SDK does not pin for you.",
        },
        {
          type: "code",
          label: "Step 3 — approve fee tokens",
          text: "const connection = await InayaKernel.connectWallet();\nconst { usdtFee, inayaFee } = await InayaKernel.approveFeeTokens({\n  connection, fileSizeBytes: file.size,\n});",
        },
        {
          type: "code",
          label: "Step 4 — anchor to the ledger",
          text: "const result = await InayaKernel.anchorToLedger({\n  connection, fileName: file.name, fileSizeBytes: file.size,\n  dataShardAlpha: shardAlpha, dataShardBeta: shardBeta,\n  onProgress: (e) => console.log(e.stage),\n});",
        },
        {
          type: "note",
          text: "Write-once by design: batchRegisterAssets() is the only function that writes asset data on-chain. Renaming/moving/deleting is handled entirely off-chain by the Metadata client, not by a contract call.",
        },
        {
          type: "code",
          label: "Step 5 — retrieve & reconstruct",
          text: "const { name, owner, dataUrl } = await InayaKernel.retrieveAndReconstruct({\n  connection, assetId: result.assetId, passkey,\n  onProgress: (e) => console.log(e.stage),\n});",
        },
      ],
    },
    {
      number: "03",
      title: "Staking",
      blocks: [
        {
          type: "code",
          text: "await InayaKernel.Staking.stake({ connection, amount, lockPeriodDays: 30 }); // 0, 30, or 90\nawait InayaKernel.Staking.unstake({ connection, amount });\nawait InayaKernel.Staking.claimReward({ connection });",
        },
        {
          type: "note",
          text: "withdraw() and claimReward() are two separate on-chain actions — there is no combined \"unstake and pay out\" call.",
        },
      ],
    },
    {
      number: "04",
      title: "Payments — No-Wallet Card Flow",
      blocks: [
        {
          type: "lead",
          text: "For customers who'd rather pay by card, InayaKernel.Payments is a typed client for your own backend's card-checkout routes — it contains zero secrets (no Stripe key, no treasury key), only calling fetch() against your own /api/* routes.",
        },
        {
          type: "table",
          headers: ["Flow", "Behavior"],
          rows: [
            ["Corporate Reserve", "Enterprise annual subscription, billed in USDT, maintenance in INAYA."],
            ["PAYG Checkout", "Retail metered billing per upload."],
            ["Egress Checkout", "Pay-per-retrieval unlock for a single file."],
          ],
        },
      ],
    },
    {
      number: "05",
      title: "Off-Chain Metadata Layer",
      blocks: [
        {
          type: "lead",
          text: "Since Custody's on-chain write is permanent, InayaKernel.Metadata fills the gap for everything the contract can't do: renaming, moving, deleting, restoring, virtual folders, and sharing. Every mutating call is authenticated by a wallet signature, cross-checked against the real on-chain owner.",
        },
        {
          type: "code",
          text: "await InayaKernel.Metadata.renameFile({ connection, fileHash, newName });\nawait InayaKernel.Metadata.shareFile({ connection, fileHash, withAddress });",
        },
      ],
    },
    {
      number: "06",
      title: "Errors, Progress & Retries",
      blocks: [
        {
          type: "bullets",
          items: [
            "InayaValidationError — bad input caught before any network call.",
            "InayaWalletError — no provider, user rejected a signature.",
            "InayaContractError — an on-chain call reverted.",
            "InayaNetworkError — an RPC, IPFS gateway, or backend fetch failed.",
            "InayaError — shared base class for instanceof checks.",
          ],
        },
        {
          type: "note",
          text: "Long-running calls accept onProgress and also emit matching events on InayaKernel.events. Transient failures (IPFS timeouts, read-only RPC calls) retry automatically with backoff; contract reverts and wallet rejections never do.",
        },
      ],
    },
    {
      number: "07",
      title: "Node Operators — @inaya-network/node-daemon",
      blocks: [
        {
          type: "lead",
          text: "New since this guide was last written: a separate, published npm package for the operator side.",
        },
        {
          type: "code",
          label: "Installation — published to npm",
          text: "$ npm install -g @inaya-network/node-daemon",
        },
        {
          type: "bullets",
          items: [
            "login — encrypts a wallet key at rest locally (PBKDF2 + AES-GCM).",
            "register <capacityGB> — registers on InayaNodeRegistry on-chain, plus off-chain capacity bookkeeping.",
            "start — a 5-minute heartbeat loop reporting telemetry.",
            "status — shows what the coordinator has recorded about this node: heartbeat recency, uptime score, daemon version/restarts, and threat-reporting reputation.",
            "report <indicator> — submits a signed threat observation to the Security Layer.",
            "service install / service uninstall — installs or removes the daemon as a native background service (Windows Service / systemd / launchd).",
          ],
        },
        {
          type: "note",
          text: "It does not store or serve shards, and does not execute settlement/payout logic — an identity + registration + heartbeat agent today, not a full storage-node runtime.",
        },
      ],
    },
    {
      number: "08",
      title: "API Quick Reference",
      blocks: [
        {
          type: "table",
          headers: ["Function", "Purpose"],
          rows: [
            ["generateSecureSalt(bytes=16)", "Cryptographically random salt."],
            ["deriveVaultKey(params)", "PBKDF2-derives a 256-bit AES key for reuse."],
            ["disperseAndSlice(params)", "AES-GCM-256 encrypt + midpoint-bisect into two shards."],
            ["reconstructAndDecrypt(params)", "Rejoin shards, re-derive key, decrypt."],
            ["connectWallet()", "Browser-only EIP-1193 wallet connect."],
            ["approveFeeTokens(params)", "Reads live per-GB fees, approves spend."],
            ["anchorToLedger(params)", "Registers shard CIDs on-chain (write-once)."],
            ["retrieveAndReconstruct(params)", "Reads on-chain CIDs, fetches shards, decrypts."],
            ["Staking.{stake,unstake,claimReward}", "InayaStaking wrapper, 0/30/90-day lock tiers."],
            ["Payments.*", "No-wallet card checkout client."],
            ["Metadata.*", "Off-chain, signature-authenticated file mutations."],
            ["events / errors.*", "Shared event emitter / typed error classes."],
            ["createPasskeyBackup / restorePasskeyBackup", "Export/restore a passkey-derived vault as an encrypted, portable backup file."],
            ["TrustPlatform.{verifyAudit,getEvidence,checkPermission}", "Client for Inaya's public trust/evidence API — verify an org's own hash-linked evidence chain, pull a record's evidence trail, check a capability gate."],
            ["IdentityIntegration.{signWebhook,sendEvent}", "Client for Inaya's Identity Integration webhook API — sign and send a directory lifecycle event (joiner/mover/leaver) from your own AD/Entra/HR connector."],
            ["ComplianceProofs.{proveAuthorizedAccess,verifyAuthorizedAccessProof}", "Real Schnorr/Fiat-Shamir zero-knowledge proof that a caller controls a key authorized for a given {policy, action, timestamp} — without revealing the key."],
            ["Intent.{create,discoverRoutes,simulate,riskCheck,execute}", "Intent-based multi-chain transfer pipeline in front of the bridge SDK — validates, prices, risk-checks and executes a cross-chain transfer as one auditable unit."],
            ["Attestation.{verify,evaluatePolicy}", "Verifies device/environment attestation evidence against a policy — software-simulated TEE today, honestly labeled non-hardware-backed."],
            ["Analytics.getWalletStorageStats()", "Real per-wallet storage usage/cost statistics."],
            ["Backup.{getBackupStatus,getBackupHealth,getRedundancyStatus,requestRecovery}", "Shard redundancy and recovery status for a stored file, plus a client to request recovery."],
            ["AppStore.{submitListing,getListings,getMyListings}", "Client for the Web3 App Store — list and browse third-party applications built on Inaya."],
          ],
        },
        {
          type: "note",
          text: "Security note — passkeys and derived vault keys should never be transmitted off-device or logged. Store only the salt and resulting CIDs in application state.",
        },
        {
          type: "note",
          label: "Two more published packages, same monorepo.",
          text: "@inaya-network/bridge-sdk (cross-chain $INAYA transfer and staking) and @inaya-network/react (InayaUploader / InayaFileBrowser / InayaConnect components) are both real, separately versioned npm packages alongside custody-sdk — out of scope for this guide, which covers custody-sdk specifically; ask your Inaya contact for their own reference material.",
        },
      ],
    },
  ],
};
