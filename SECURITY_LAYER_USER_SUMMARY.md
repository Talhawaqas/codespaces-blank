# Inaya Network now has a built-in Security Layer

Inaya can now warn you — and, on desktop, actually block — when you're about to reach a destination the network has flagged as malicious, backed by real reports from independent Inaya nodes, not a single company's say-so.

## How it works, in plain terms

- Inaya nodes (people running the Inaya node software) can report a suspicious website or address they've spotted.
- A single report isn't enough on its own — Inaya waits for several independent nodes to agree, and weighs each node's track record (nodes that have been right before count for more; nodes that have been wrong before count for less).
- Once enough independent, trustworthy reports agree, the threat is marked **confirmed** and permanently, tamper-evidently recorded on the blockchain — so the verdict can't quietly be changed later.
- Your app then checks against that confirmed list before you land somewhere risky.

## What you get, by platform

- **Website**: a public **Security** page at inayanetwork.com/security — no wallet, no login needed. See how many threats the network has confirmed, how many nodes are contributing reports, check any domain or IP yourself, and browse the recently-confirmed-threats list. There's a live animated view of the node network in the header, just to make the "this is a real distributed network, not one server" idea visible at a glance. You can now also **ask the AI Security Assistant directly on the website** — it's front and center on the page with sample questions you can just tap, and every answer is grounded in real network data, never a guess.
- **Desktop app**: links you click inside the Business Workspace are checked automatically. A confirmed-malicious link gets blocked with a native notification instead of opening. On Windows, a genuinely confirmed threat can also be blocked at the firewall level, not just inside the app window.
- **Mobile app**: a new **Security** screen — check any domain or IP before you trust it, see your recent security events, keep your own personal allow/blocklist, choose how cautious Inaya should be (Monitor / Protect / Strict), and ask the built-in Security Assistant "why was this blocked?" or "what is this threat?" for a plain-language answer grounded only in real, verified data — never a guess.
- **Everywhere**: nothing about this collects your browsing history or reads the contents of what you're doing — only the destination (a domain or IP) is ever checked, never your traffic. The public website page never shows anything private either — no node identities, just totals and confirmed threats.

## We're on testnet — this is an early release

The on-chain piece runs on BNB Chain Testnet right now, not mainnet — this is a real, working system being proven out before a wider release. If you run a node and want to help build up the threat network, or if something looks off, tell us — that's exactly the feedback that shapes what ships next.

## What's not here yet

- On mobile, this checks destinations *inside* the Inaya app — it doesn't (yet) protect your phone's overall internet traffic. That's a bigger, separate piece we're being deliberate about, since getting it wrong could affect your phone's regular internet connection.
- No macOS support yet (Windows and Linux only, matching the rest of the desktop app).
