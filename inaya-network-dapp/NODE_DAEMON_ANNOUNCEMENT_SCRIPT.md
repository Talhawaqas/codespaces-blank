# ChatGPT Script — Node Operator Daemon Announcement (Telegram + X + Image)

Paste everything below into ChatGPT as one message.

---

You are writing social copy for **Inaya Network**, a DePIN (decentralized physical
infrastructure) project for encrypted, sharded data storage on BNB Chain. Audience: an
existing Telegram community and X/Twitter followers who are testnet node operators, crypto/DePIN
enthusiasts, and prospective node operators. Tone: confident, technical-but-accessible, no hype
words like "revolutionary" or "game-changing," short punchy sentences, real substance over
buzzwords. Brand colors are navy (#0a0e14) and gold (#b8862f) — mention this only for the image
prompt, not in the copy.

**What's being announced:** `@inaya-network/node-daemon` is now live on npm — a minimal
background daemon that lets anyone turn a spare Windows, macOS, or Linux machine into an Inaya
DePIN node operator candidate. Facts to use (don't invent anything beyond this):

- Install: `npm install -g @inaya-network/node-daemon`
- No Docker required — deliberately built as a plain Node.js tool because most operators are on
  Windows and Docker Desktop is a heavier ask than necessary.
- Three commands to get going: `inaya-node-daemon login` (encrypts your wallet key at rest,
  never stored in plaintext), `inaya-node-daemon register <capacityGB>` (registers your node
  on-chain), `inaya-node-daemon start` (starts reporting uptime).
- Can be installed as a native background service (Windows Service / systemd / launchd) so it
  keeps running unattended.
- **What it does today:** registration + wallet custody + uptime/heartbeat telemetry. It does
  **not** yet store or serve data shards — be explicit about this, don't imply it does.
- **Why operators should install it now, not later:** uptime history is being tracked starting
  now. Operators who maintain 95%+ uptime for at least 90 consecutive days on the testnet earn
  priority access when mainnet node assignments open. Early, consistent uptime = a real head
  start, not just a nice-to-have.
- Commission tiers when shard storage does go live: 30% (Entry, <500GB), 40% (Mid, 500GB–5TB),
  50% (Enterprise, 5TB+), paid in USDT.

**Write three things:**

1. **Telegram announcement post** (150–250 words, can use light markdown/emoji, ends with a
   clear call to action and the install command in a code block).
2. **X/Twitter post** (under 280 characters, one punchy hook + the install command + 1-2
   relevant hashtags like #DePIN, no more than that).
3. **An image generation prompt** I can feed to an image model for an accompanying announcement
   graphic: dark navy background, gold accent color, clean modern tech/crypto aesthetic, a
   terminal/command-line visual motif (since this is a CLI tool), text overlay space for a
   headline like "Node Operator Daemon — Live Now," no photorealistic humans, DePIN/network-node
   visual theme (abstract connected nodes), 16:9 for X and 1:1 for Telegram — give me both
   variants of the prompt.

Keep the Telegram and X copy factually distinct pieces (not just the same text shortened), and
make sure neither one claims operators can already store data or earn money today — the honest
hook is "get in early, build your uptime record, earn priority."
