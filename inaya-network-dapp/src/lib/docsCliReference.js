// src/lib/docsCliReference.js
//
// Official Documentation Platform SOW -- hand-authored from the Phase 0
// audit of custody-sdk/packages/{cli,create-inaya-dapp,node-daemon}/bin/**,
// plus inaya-migration-agent/bin/inaya-migrate.mjs (added after the
// Phase 0 audit, once the migration agent was itself published to npm).
// All four CLI tools are confirmed published and live on npm. See
// docs/audit/documentation-inventory.md.

export const CLI_TOOLS = [
  {
    slug: "inaya-cli",
    packageName: "inaya-cli",
    binary: "inaya",
    install: "npm install -g inaya-cli",
    tagline: "Encrypt, shard, and anchor files to the Inaya DePIN network from a terminal or CI/CD pipeline.",
    commands: [
      { command: "inaya login", detail: "Authenticate with a wallet private key. For CI: INAYA_PRIVATE_KEY / INAYA_CLI_PASSWORD env vars." },
      { command: "inaya upload <path>", detail: "Encrypt/shard/pin/anchor a local file.", options: "--api-base-url <url>" },
      { command: "inaya list", detail: "Print the ledger of files for the logged-in wallet.", options: "--api-base-url <url>" },
      { command: "inaya deploy <path>", detail: "Pin a static site to IPFS (Pinata) and submit it to the Web3 App Store.", options: "--name, --description, --category, --api-base-url, -y/--yes" },
    ],
    status: "live",
  },
  {
    slug: "create-inaya-dapp",
    packageName: "create-inaya-dapp",
    binary: "create-inaya-dapp",
    install: "npx create-inaya-dapp <project-name>",
    tagline: "Scaffolding tool that pre-wires a Next.js app with custody-sdk, @inaya-network/react, Tailwind, and wagmi/viem.",
    commands: [
      { command: "npx create-inaya-dapp <project-name> [--template <name>]", detail: 'Zero-dependency (fs-only) scaffolder. Templates read from the package\'s own templates/ directory at runtime -- confirmed templates: "vault" (default) and "media".' },
    ],
    status: "live",
  },
  {
    slug: "node-daemon",
    packageName: "@inaya-network/node-daemon",
    binary: "inaya-node-daemon",
    install: "npm install -g @inaya-network/node-daemon",
    tagline: "Minimal node operator daemon -- registers your node on-chain and reports heartbeat/telemetry. Does not store or serve shards.",
    commands: [
      { command: "inaya-node-daemon login", detail: "Store the node operator wallet, encrypted at rest. For unattended use: INAYA_PRIVATE_KEY / INAYA_DAEMON_PASSWORD env vars." },
      { command: "inaya-node-daemon register <capacityGB>", detail: "Register on-chain (InayaNodeRegistry) and with the coordinator backend.", options: "--api-base-url" },
      { command: "inaya-node-daemon start", detail: "Run the foreground heartbeat loop.", options: "--api-base-url, --interval <seconds> (default 300)" },
      { command: "inaya-node-daemon report <indicator>", detail: "Submit a signed security-threat observation.", options: "--category, --confidence, --evidence, --api-base-url" },
      { command: "inaya-node-daemon status", detail: "Show coordinator-recorded heartbeat recency, uptime score, version, and threat-reporting reputation.", options: "--api-base-url" },
      { command: "inaya-node-daemon service install", detail: "Install as a native background service (Windows Service / systemd / launchd)." },
      { command: "inaya-node-daemon service uninstall", detail: "Remove the native background service." },
    ],
    status: "live",
  },
  {
    slug: "migration-agent",
    packageName: "@inaya-network/migration-agent",
    binary: "inaya-migrate",
    install: "npm install -g @inaya-network/migration-agent",
    tagline: "Migrate existing data from AWS S3, Azure Blob Storage, or Google Cloud Storage into Inaya. Every credential stays local to the process -- Business Workspace and Inaya's browser UI never see them.",
    commands: [
      { command: "inaya-migrate migrate --source <aws|azure|gcs> --dest-endpoint <url> --dest-bucket <name>", detail: "Run (or resume) a migration. Re-running the same command resumes automatically -- objects already recorded MIGRATED in the manifest are skipped, never re-copied.", options: "--source-bucket, --source-prefix, --source-region (AWS), --source-endpoint (GCS), --objects <keys>, --dry-run, --manifest <path> (default ./inaya-migration-manifest.jsonl)" },
    ],
    guideUrl: "/documents/inaya-pilot-guide-data-migration.pdf",
    status: "live",
  },
];
