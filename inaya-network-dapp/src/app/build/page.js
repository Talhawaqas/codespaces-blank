// app/build/page.js
//
// Public developer/marketing page for the SDK ecosystem built on top of
// Inaya Network — @inaya-network/custody-sdk (client-side crypto +
// on-chain + payments + metadata + analytics + backup), @inaya-network/react
// (drop-in components), inaya-cli (deploy/CI tooling), and
// create-inaya-dapp (scaffolding). Every fact here is pulled from the SDK's
// own README.md/SDK_GUIDE.md (custody-sdk/) rather than invented — install
// commands, the six-layer breakdown, and the 30-second quickstart are all
// copied/adapted from those docs so this page can't drift out of sync with
// what the SDK actually does. Static server component, same convention as
// /faq and /business/roadmap (nothing to fetch, nothing to react to).

export const metadata = {
  title: "Build on Inaya — Developer Platform | Inaya Network",
  description:
    "A client-side cryptographic sovereignty SDK for developers — encrypt, shard, anchor, and reconstruct files against a live chain. TypeScript-first, live on npm, ships with React components, a CLI, and project scaffolding.",
};

const VALUE_PROPS = [
  {
    icon: "🔑",
    title: "Sovereignty by default",
    body: "Encryption and sharding happen entirely client-side — in the browser or in Node — before anything leaves the device. Your app never holds a plaintext file, and neither does Inaya.",
  },
  {
    icon: "🧩",
    title: "Six layers, use what you need",
    body: "Crypto, on-chain anchoring, payments, metadata, analytics, and backup are each independently usable. Pull in the whole kernel or just the one client your app actually needs.",
  },
  {
    icon: "⚡",
    title: "Ship in an afternoon",
    body: "TypeScript-first with full .d.ts coverage, drop-in React components, a CLI for deploys, and create-inaya-dapp for a zero-to-running scaffold. The 30-second example below is real, copy-pasteable code.",
  },
  {
    icon: "🏪",
    title: "Built-in distribution",
    body: "Ship a static site and inaya-cli's deploy command pins it to IPFS and submits it to the Web3 App Store for review in one call — no separate hosting, no separate submission flow.",
  },
];

const SDK_LAYERS = [
  { icon: "🔐", name: "Crypto", file: "crypto.js", body: "Client-side AES-GCM-256 encryption and binary sharding. Pure JS (@noble/hashes + @noble/ciphers) — works in browsers, Node.js, and React Native alike." },
  { icon: "⛓️", name: "On-chain", file: "index.js", body: "Wraps the deployed InayaCustody and InayaStaking contracts. Dual-mode: a connected browser wallet, or a server-held ethers.Wallet for signing on a user's behalf." },
  { icon: "💳", name: "Payments", file: "payments.js", body: "A typed client for the card-payment, no-wallet backend routes (Corporate Reserve, PAYG, egress checkouts). Carries zero secrets of its own." },
  { icon: "🗂️", name: "Metadata", file: "metadata.js", body: "Rename, move, delete, virtual folders, and sharing — an off-chain layer authenticated by wallet signatures, since the on-chain contract itself is write-once." },
  { icon: "📊", name: "Analytics", file: "analytics.js", body: "Per-wallet storage statistics, built entirely from data the SDK can already read — no new on-chain calls, no new backend surface." },
  { icon: "🛰️", name: "Backup", file: "backup.js", body: "Replica redundancy status, health, and recovery for your uploaded shards across independent pinning providers." },
];

const TOOLKIT = [
  { cmd: "npm install @inaya-network/custody-sdk ethers", label: "The core SDK", note: "ethers v6 is a peer dependency, install it alongside." },
  { cmd: "npm install @inaya-network/react", label: "Drop-in UI components", note: "Upload, staking, and file-management widgets, documented in a live Storybook." },
  { cmd: "npm install -g inaya-cli", label: "CLI & CI/CD tooling", note: "inaya deploy <path> pins a static site to IPFS and submits it to the App Store in one command." },
  { cmd: "npx create-inaya-dapp my-app", label: "Project scaffolding", note: "A working app wired to the SDK, ready to run." },
];

const USE_CASES = [
  { icon: "🗄️", title: "Sovereign storage apps", body: "Consumer or prosumer tools where users own their encryption keys outright — nothing to trust Inaya, or you, with." },
  { icon: "🏢", title: "Business document workflows", body: "The Metadata and Payments clients are the same primitives Inaya's own Business Workspace is built on — rename/move/share, invoicing, corporate reserve billing." },
  { icon: "🖼️", title: "NFT & media galleries", body: "Anchor large media to a real chain without paying full on-chain storage cost — the sharding + IPFS pinning layer is designed for exactly this." },
  { icon: "🏪", title: "App Store listings", body: "Ship a static site, deploy it with inaya-cli, and it's reviewed and listed in Inaya's Web3 App Store — a distribution channel that ships with the SDK." },
];

const QUICKSTART = `import { InayaKernel } from "@inaya-network/custody-sdk";

const connection = await InayaKernel.connectWallet();
const salt = InayaKernel.generateSecureSalt(16);
const vaultKey = await InayaKernel.deriveVaultKey({ passkey: "user-supplied-passkey", salt });
const sharded = await InayaKernel.disperseAndSlice({ file, encryptionKey: vaultKey });

// Pin sharded.shardAlpha / sharded.shardBeta to IPFS yourself, then:
await InayaKernel.approveFeeTokens({ connection, fileSizeBytes: file.size });
const receipt = await InayaKernel.anchorToLedger({
  connection,
  fileName: sharded.filename,
  fileSizeBytes: file.size,
  dataShardAlpha: cidAlpha,
  dataShardBeta: cidBeta,
});`;

function ValueCard({ icon, title, body }) {
  return (
    <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-5 hover:border-[#00f2fe]/25 transition-colors">
      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/25 flex items-center justify-center text-lg mb-3">
        {icon}
      </div>
      <h3 className="text-white font-bold text-sm">{title}</h3>
      <p className="text-[#94a3b8] text-[13px] mt-1.5 leading-relaxed">{body}</p>
    </div>
  );
}

function InstallLine({ cmd, label, note }) {
  return (
    <div className="bg-black/25 border border-white/5 rounded-xl p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[13px] font-bold text-white">{label}</span>
      </div>
      <p className="text-[#8a96ab] text-[12px] mt-1 mb-2.5 leading-relaxed">{note}</p>
      <code className="block font-mono text-[12px] text-[#00f2fe] bg-black/40 border border-white/5 rounded-lg px-3 py-2 overflow-x-auto whitespace-pre">
        {cmd}
      </code>
    </div>
  );
}

export default function BuildOnInayaPage() {
  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-16 md:px-10 overflow-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px]" />
        <div className="absolute top-1/3 -right-24 w-96 h-96 rounded-full bg-[#4facfe]/10 blur-[120px]" />
        <div className="absolute bottom-0 left-1/4 w-96 h-96 rounded-full bg-violet-500/5 blur-[130px]" />
      </div>

      <div className="relative max-w-5xl mx-auto">
        <a href="/" className="inline-flex items-center gap-2 text-[#8a96ab] hover:text-[#00f2fe] text-xs font-mono mb-8 transition-colors">
          ← Back to Inaya Network
        </a>

        {/* Hero */}
        <div className="inaya-fade-in-up max-w-3xl">
          <span className="inline-block text-[12px] font-mono font-bold tracking-widest text-[#00f2fe] bg-cyan-500/10 border border-[#00f2fe]/30 rounded-full px-3 py-1 mb-4">
            ⚙️ DEVELOPER PLATFORM
          </span>
          <h1 className="text-4xl md:text-5xl font-extrabold text-white tracking-tight leading-tight">
            Build on Inaya
          </h1>
          <p className="text-[#94a3b8] text-base md:text-lg mt-4 leading-relaxed">
            <code className="font-mono text-[#00f2fe]">@inaya-network/custody-sdk</code> is a client-side cryptographic sovereignty SDK —
            encrypt, shard, anchor, and reconstruct files against a live chain, from your own app. TypeScript-first,
            live on the public npm registry, and used to build Inaya's own products.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-7">
          <a
            href="https://www.npmjs.com/package/@inaya-network/custody-sdk"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-5 py-2.5 rounded-full hover:brightness-110 transition"
          >
            View on npm ↗
          </a>
          <a
            href="https://github.com/Talhawaqas/custody-sdk"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-white bg-white/5 border border-white/10 hover:border-[#00f2fe]/40 px-5 py-2.5 rounded-full transition-colors"
          >
            Source on GitHub ↗
          </a>
          <code className="font-mono text-[12px] text-[#94a3b8] bg-black/30 border border-white/10 rounded-full px-4 py-2">
            npm install @inaya-network/custody-sdk ethers
          </code>
        </div>

        {/* Why build here */}
        <section className="mt-16">
          <h2 className="text-white font-extrabold text-xl">Why build on Inaya</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5">
            {VALUE_PROPS.map((v) => <ValueCard key={v.title} {...v} />)}
          </div>
        </section>

        {/* Quickstart */}
        <section className="mt-16">
          <h2 className="text-white font-extrabold text-xl">30-second quickstart</h2>
          <p className="text-[#8a96ab] text-[13px] mt-1.5">A full wallet-connected upload, start to finish.</p>
          <pre className="mt-4 bg-black/30 border border-white/5 rounded-2xl p-5 font-mono text-[12.5px] text-[#c3ccdb] overflow-x-auto leading-relaxed">
            <code>{QUICKSTART}</code>
          </pre>
        </section>

        {/* Six layers */}
        <section className="mt-16">
          <h2 className="text-white font-extrabold text-xl">Six layers, one SDK</h2>
          <p className="text-[#8a96ab] text-[13px] mt-1.5">Each is independently usable — pull in the whole kernel, or just what your app needs.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-5">
            {SDK_LAYERS.map((l) => (
              <div key={l.name} className="bg-[#0b1426]/70 border border-[#00f2fe]/15 rounded-2xl p-5">
                <div className="flex items-center gap-2.5">
                  <span className="text-base">{l.icon}</span>
                  <span className="text-white font-bold text-sm">{l.name}</span>
                  <code className="font-mono text-[11px] text-[#8a96ab]">{l.file}</code>
                </div>
                <p className="text-[#94a3b8] text-[12.5px] mt-2 leading-relaxed">{l.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Toolkit / install */}
        <section className="mt-16">
          <h2 className="text-white font-extrabold text-xl">The toolkit</h2>
          <p className="text-[#8a96ab] text-[13px] mt-1.5">Four packages, all published and installable today.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5">
            {TOOLKIT.map((t) => <InstallLine key={t.cmd} {...t} />)}
          </div>
        </section>

        {/* Use cases */}
        <section className="mt-16">
          <h2 className="text-white font-extrabold text-xl">What people build</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5">
            {USE_CASES.map((u) => (
              <div key={u.title} className="flex gap-3 bg-white/[0.03] border border-white/5 rounded-2xl p-5">
                <span className="text-lg shrink-0">{u.icon}</span>
                <div>
                  <h3 className="text-white font-bold text-sm">{u.title}</h3>
                  <p className="text-[#94a3b8] text-[13px] mt-1 leading-relaxed">{u.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Verify this build */}
        <section className="mt-16">
          <h2 className="text-white font-extrabold text-xl">Verify this build</h2>
          <p className="text-[#8a96ab] text-[13px] mt-1.5 max-w-2xl">
            This page (and every page on this site) is identified by a build ID tied to the exact git commit and
            custody-sdk version it was built from — not a random ID that tells you nothing. Same encryption code
            path as mobile, since the client-side crypto consolidation described below.
          </p>
          <div className="mt-5 bg-[#0b1426]/70 border border-[#00f2fe]/15 rounded-2xl p-5 font-mono text-[12.5px] space-y-2">
            <div className="flex flex-wrap gap-x-3">
              <span className="text-[#8a96ab]">Build ID:</span>
              <span className="text-[#00f2fe] break-all">{process.env.NEXT_PUBLIC_BUILD_ID || "unavailable in this environment"}</span>
            </div>
            <div className="flex flex-wrap gap-x-3">
              <span className="text-[#8a96ab]">custody-sdk version:</span>
              <span className="text-white">{process.env.NEXT_PUBLIC_SDK_VERSION || "unknown"}</span>
            </div>
          </div>
          <p className="text-[#8a96ab] text-[12.5px] mt-3 max-w-2xl leading-relaxed">
            What this does and doesn't guarantee, how to reproduce a release yourself, and what content-addressed
            delivery means here — see <code className="text-[#00f2fe]">docs/reproducible-builds-and-verification.md</code> in
            this app's repository, and{" "}
            <a
              href="https://github.com/Talhawaqas/custody-sdk/blob/main/docs/VERIFYING_RELEASES.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#00f2fe] hover:underline"
            >
              custody-sdk's own release-verification guide
            </a>{" "}
            for the SDK package specifically.
          </p>
        </section>

        {/* CTA footer */}
        <section className="mt-16 mb-8 bg-gradient-to-br from-[#00f2fe]/10 to-[#4facfe]/5 border border-[#00f2fe]/25 rounded-2xl p-7 md:p-9 text-center">
          <h2 className="text-white font-extrabold text-xl">Start building</h2>
          <p className="text-[#94a3b8] text-sm mt-2 max-w-lg mx-auto leading-relaxed">
            Install the SDK, scaffold a project, or browse the source — everything above is live and public today.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mt-5">
            <a
              href="https://www.npmjs.com/package/@inaya-network/custody-sdk"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-5 py-2.5 rounded-full hover:brightness-110 transition"
            >
              npm install @inaya-network/custody-sdk ↗
            </a>
            <a
              href="https://github.com/Talhawaqas/custody-sdk/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-white bg-white/5 border border-white/10 hover:border-[#00f2fe]/40 px-5 py-2.5 rounded-full transition-colors"
            >
              Good first issues ↗
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
