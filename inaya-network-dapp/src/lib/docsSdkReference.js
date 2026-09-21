// src/lib/docsSdkReference.js
//
// Official Documentation Platform SOW -- hand-authored from the Phase 0
// audit of custody-sdk/packages/**. All 5 packages are confirmed
// published and live on the public npm registry (verified this session
// via `npm view`, not assumed). See docs/audit/documentation-inventory.md.

export const SDK_PACKAGES = [
  {
    slug: "custody-sdk",
    name: "@inaya-network/custody-sdk",
    tagline: "The core client SDK -- crypto, on-chain, payments, metadata, analytics, and backup, in six independently-usable layers.",
    install: "npm install @inaya-network/custody-sdk ethers",
    layers: [
      { name: "Crypto", file: "crypto.js", detail: "Client-side AES-256-GCM encryption, PBKDF2 key derivation, and binary sharding -- disperseAndSlice()/reconstructAndDecrypt()." },
      { name: "On-chain", file: "index.js", detail: "InayaKernel -- wallet connect, vault key derivation, ledger anchoring." },
      { name: "Payments", file: "payments.js", detail: "Fee-token approval and payment flows." },
      { name: "Metadata", file: "metadata.js", detail: "File/folder metadata operations -- the client for the ~17 routes under src/app/api/metadata/." },
      { name: "Analytics", file: "analytics.js", detail: "Usage/storage analytics." },
      { name: "Backup", file: "backup.js", detail: "Dual-provider shard replication and recovery." },
    ],
    status: "live",
    docsUrl: "/build",
  },
  {
    slug: "bridge-sdk",
    name: "@inaya-network/bridge-sdk",
    tagline: "Cross-chain $INAYA transfer and cross-chain staking -- separate from custody-sdk so upload-only consumers don't pay for this surface.",
    install: "npm install @inaya-network/bridge-sdk ethers",
    exports: [
      { name: "InayaBridgeClient", kind: "class", detail: "new InayaBridgeClient({apiBaseUrl?, signer?, pinnedContracts?}). Methods: getSupportedChains(), getTransferStatus(messageHash), getStakingPosition(address), bridgeTransfer({sourceChain, destChainId, amountWei, recipient, userAddress}), stake({chain, amountWei, lockPeriodDays}), unstake({homeChain, amountWei, destChainId, destRecipient, userAddress}), claimRewards({homeChain, destChainId, destRecipient, userAddress})." },
      { name: "CHAIN_IDS", kind: "const", detail: "BSC_TESTNET, SEPOLIA, AMOY, FUJI, ARBITRUM_SEPOLIA, HEDERA_TESTNET." },
      { name: "SOLANA_DEVNET_CHAIN_ID", kind: "const", detail: "Solana is non-EVM, so it's a separate constant rather than a CHAIN_IDS entry." },
    ],
    status: "live",
  },
  {
    slug: "react",
    name: "@inaya-network/react",
    tagline: "Drop-in React + Tailwind components for custody-sdk.",
    install: "npm install @inaya-network/react",
    peerDeps: "@inaya-network/custody-sdk, ethers ^6, react/react-dom ^18 || ^19. Tailwind must already be configured in the consuming app, with this package's path added to tailwind.config.js's content globs.",
    exports: [
      { name: "InayaConnect", kind: "component", detail: "Props: {onReady?, onError?, salt?, label?, className?}. onReady payload: {connection, vaultKey, salt, address}." },
      { name: "InayaUploader", kind: "component", detail: "Props: {connection, vaultKey, pinShard, onComplete?, onError?, className?}." },
      { name: "InayaFileBrowser", kind: "component", detail: "Props: {connection, owner, apiBaseUrl?, className?}." },
    ],
    status: "live",
  },
];
