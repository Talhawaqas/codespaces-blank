// Investment Memorandum — editable content. Source of truth for
// public/documents/inaya-investment-memorandum.pdf. Edit this file, then run
// `node scripts/fundraising-docs/generate.mjs`. See README.md.
//
// PROTECTED — do not edit without explicit founder sign-off (per the
// fundraising-docs SOW, August 2026): Section 05's "Roadmap highlight"
// paragraph and Section 11's mainnet-readiness language, Section 13's
// financial projections, and Section 17's funding ask/use-of-funds/
// milestones. These are marked inline below.

export const investmentMemorandum = {
  cover: {
    company: "INAYA NETWORK",
    classification: "STRICTLY CONFIDENTIAL",
    kicker: "INVESTMENT MEMORANDUM — VC EDITION",
    title: "Building the Sovereign Storage Layer",
    subtitle:
      "A DePIN protocol bridging Web2 enterprise infrastructure with Web3 sovereign storage — raising a Seed round to scale developer adoption and enterprise revenue.",
    docLine: "Document INAYA-IM-2026-V1 · Classification Strictly Confidential · August 2026",
  },
  docId: "INAYA-IM-2026-V1",
  sections: [
    {
      number: "01",
      title: "Executive Summary",
      blocks: [
        {
          type: "paragraphs",
          text: [
            "Inaya Network represents the next evolution in decentralized physical infrastructure networks (DePIN), targeting the $100B+ cloud storage sector. By bridging traditional Web2 enterprise environments and Web3 storage protocols, Inaya solves the critical bottlenecks of data sovereignty, vendor lock-in, and infrastructure vulnerability that plague centralized cloud providers.",
            "We are raising Seed capital to aggressively expand our go-to-market strategy, secure enterprise partnerships, and scale our developer ecosystem. With our open-source framework and file management components fully active and mainnet applications reviewed and ready for deployment, Inaya is positioned to capture significant market share — offering a hybrid model that pairs BNB Chain's high-throughput execution with proprietary binary sharding and client-side encryption to guarantee zero-knowledge data persistence.",
            "The transition from legacy architectures to distributed, resilient DePIN solutions is accelerating. Inaya leads by prioritizing developer experience and enterprise-grade billing logic — a suite of APIs, React components, and SDKs that make decentralized storage as intuitive as AWS S3, with unmatched security and economic efficiency.",
          ],
        },
      ],
    },
    {
      number: "02",
      title: "Vision",
      blocks: [
        {
          type: "columns",
          items: [
            {
              heading: "Why Inaya Exists",
              body: "To democratize data ownership. Hyperscalers have monopolized digital real estate for over a decade, turning data into a leveraged asset controlled by third parties. Inaya builds a future where data is sovereign, immutable, and immune to censorship or localized hardware failure.",
            },
            {
              heading: "Why Now",
              body: "Mature blockchain infrastructure, edge computing adoption, and rising enterprise anxiety over data privacy converge to make this the moment for DePIN to cross the chasm — as CTOs seek alternatives to opaque hyperscaler egress fees.",
            },
            {
              heading: "Why Storage",
              body: "Decentralized storage is the foundational layer for an uncensorable internet and the safest repository for AI training data. As models consume proprietary enterprise data, cryptographic chain-of-custody becomes a compliance requirement, not a feature.",
            },
          ],
        },
      ],
    },
    {
      number: "03",
      title: "Problem",
      blocks: [
        { type: "lead", text: "The contemporary cloud market is fundamentally misaligned with the needs of modern, agile enterprises." },
        {
          type: "bullets",
          items: [
            "Cloud market oligopoly. AWS, Google Cloud, and Azure control the vast majority of infrastructure, concentrating systemic risk — a single availability-zone outage can cascade across the digital economy.",
            "Vendor lock-in. Ecosystems are walled gardens. Migrating petabytes away from a major provider incurs crippling egress fees that effectively hold enterprise data hostage.",
            "AI risk and data ownership. As AI companies scrape the internet, enterprises are realizing centrally-stored data is vulnerable to unauthorized model training, and are demanding cryptographic guarantees of sovereignty.",
            "Compliance complexity. Rapidly evolving data-residency laws (GDPR, CCPA) make global data management in centralized silos an administrative nightmare.",
          ],
        },
      ],
    },
    {
      number: "04",
      title: "Solution",
      blocks: [
        {
          type: "lead",
          text: "Inaya re-architects how data is stored, processed, and retrieved — abstracting blockchain complexity while delivering full DePIN benefits.",
        },
        {
          type: "columns",
          items: [
            {
              heading: "Client-Side Encryption & Sharding",
              body: "Military-grade AES-256 encryption before data ever leaves the device, followed by binary sharding across our global node network — no single participant ever holds a complete, decryptable file.",
            },
            {
              heading: "DePIN & Smart Contracts",
              body: "Coordinated via optimized smart contracts on BNB Chain for rapid consensus, minimal fees, and transparent orchestration of storage proofs and node slashing.",
            },
            {
              heading: "Enterprise Payments & Tooling",
              body: "A fiat-to-token gateway (Enterprise Reserve) removes the wallet hurdle for B2B clients; SDKs, REST APIs, and React components let developers integrate in minutes.",
            },
          ],
        },
        // Approved addition — one bridging sentence to Section 05's new
        // Business Workspace bullet. See fundraising docs SOW §5.
        {
          type: "note",
          text: "On top of this infrastructure, Inaya also ships a Business Workspace — encrypted document management, workflow, and permissions for companies that need SaaS simplicity, not blockchain literacy (see Product Suite, next).",
        },
      ],
    },
    {
      number: "05",
      title: "Product Suite",
      blocks: [
        {
          type: "lead",
          text: "Inaya is a fully realized product ecosystem designed for immediate deployment, not merely a protocol.",
        },
        {
          type: "bullets",
          items: [
            "Mobile App & dApp — consumer-friendly interfaces for managing storage, analytics, and the token ecosystem.",
            "Developer SDK & CLI — programmatic bucket management, chunked uploads, and CI/CD integration via GitHub and Vercel.",
            "React Package & Storybook — modular UI components (uploaders, file explorers, permission managers) fully documented for frontend teams.",
            "Templates & Knowledge Base — quick-start boilerplates and a technical wiki accelerating enterprise onboarding.",
            "Open Source Ecosystem — core file management components are publicly verifiable, ensuring trust and community-driven security review.",
            // Approved addition. See fundraising docs SOW §5.
            "Business Workspace — a B2B SaaS layer for companies: organizations, departments, projects, and documents with server-enforced approval workflows, VIEW/EDIT/MANAGE permissions, secure external sharing, full audit history, and a permission-aware AI assistant. Email-based sign-in, no wallet required — available on web and mobile.",
            // New addition, ecosystem-doc audit pass, August 2026 — factual,
            // no financial claims, mirrors the same additive pattern as the
            // Business Workspace line above.
            "Security Layer (\"Inaya Firewall\") — decentralized, node-reported threat intelligence with reputation-weighted, on-chain-confirmed verdicts. Public web transparency page, mobile protection screen, and real OS-level firewall enforcement on desktop.",
            "Inaya Learn — an educational video platform with a built-in AI tutor, on web and mobile, built to make the product a daily-use destination beyond storage and staking.",
            "Investor Data Room — a branded, access-controlled document room for sharing investor materials, with per-visitor engagement tracking.",
            "Two native desktop apps (Windows + Linux) — thin Tauri wrappers around the Business Workspace and the main dApp, with system tray, native notifications, and signed auto-updates.",
            "Three purpose-built AI assistants — Business, Security, and Learn — sharing one Gemini-powered tool-calling architecture, each with a guardrail philosophy suited to its job.",
          ],
        },
        {
          // PROTECTED — do not edit this paragraph without founder sign-off.
          type: "note",
          label: "Roadmap highlight.",
          text: "Inaya is executing the final stages of mainnet deployment. Having resolved front-end issues during testnet, the immediate focus is scaling the node operator network and rolling out enterprise-tier SLAs.",
        },
      ],
    },
    {
      number: "06",
      title: "Market Size & Dynamics",
      blocks: [
        {
          type: "lead",
          text: "Inaya's total addressable market sits at the intersection of traditional cloud infrastructure and the rapidly expanding Web3 economy.",
        },
        {
          type: "table",
          headers: ["Segment", "Estimated Value", "Inaya's Approach"],
          rows: [
            ["TAM", "$100B+\nGlobal cloud storage", "Disrupting legacy providers by offering lower baseline costs and eliminating egress fees."],
            ["SAM", "$10B\nWeb3 & AI data storage", "Targeting dApps, NFT platforms, and AI datasets requiring immutable, cryptographically secure storage."],
            ["SOM", "$150M\nYear 1-3 target", "Capturing early adopters in DePIN, migrating projects from less developer-friendly decentralized alternatives."],
          ],
        },
        {
          type: "note",
          text: "The era of “free money” in tech is over — enterprises are scrutinizing their AWS bills. DePIN infrastructure is projected to grow at a 35% CAGR over the next five years as the technology matures from experimental to enterprise-ready.",
        },
      ],
    },
    {
      number: "07",
      title: "Competition",
      blocks: [
        { type: "lead", text: "The storage landscape is bifurcated into centralized incumbents and decentralized pioneers." },
        {
          type: "columns",
          items: [
            {
              heading: "Incumbents",
              body: "AWS, Google Cloud, Azure — unmatched ecosystem lock-in. Inaya wins on zero vendor lock-in, zero egress fees, cryptographic sovereignty, and immunity to centralized outages.",
            },
            {
              heading: "DePIN Pioneers",
              body: "Filecoin (cold archival), Arweave (permanent records), Storj (closest peer, lacks modern frontend tooling).",
            },
            {
              heading: "Niche Players",
              body: "Sia, Akash, Crust — often suffer fragmented UX and difficult enterprise onboarding.",
            },
          ],
        },
        {
          type: "note",
          label: "Where Inaya wins.",
          text: "Developer experience and enterprise abstraction. Vercel-like deployment simplicity, intuitive React components, and fiat-gateway enterprise payments remove the friction that has historically blocked decentralized storage from mass adoption.",
        },
      ],
    },
    {
      number: "08",
      title: "Technology & Architecture",
      blocks: [
        { type: "lead", text: "Built for resilience, scalability, and speed." },
        {
          type: "bullets",
          items: [
            "Architecture & metadata. A dual-layer system: file names, permissions, and shard maps are managed via a state-channel-like layer anchored to BNB Chain for rapid retrieval without burdening the L1; physical storage is distributed across independent nodes.",
            "Security & encryption. Client-side AES-GCM encryption before sharding guarantees node operators remain entirely blind to the data they host — true zero-knowledge storage.",
            "BNB Chain integration. Low transaction costs and high throughput; sharding logic is inherently parallelized, so read/write speed scales linearly with network growth.",
          ],
        },
      ],
    },
    {
      number: "09",
      title: "Business Model",
      blocks: [
        {
          type: "columns",
          items: [
            {
              heading: "Pay-As-You-Go",
              body: "Developers pay strictly for storage and bandwidth consumed, settled dynamically via smart contracts.",
            },
            {
              heading: "Enterprise Reserve",
              body: "Traditional fiat contracts; Inaya programmatically purchases and distributes tokens on the backend, integrating Web2 capital into the token economy.",
            },
            {
              heading: "Margins",
              body: "Decentralized hardware means significantly higher gross margins — projected 75%+ — versus centralized hyperscalers maintaining physical data centers.",
            },
          ],
        },
        // Approved addition. See fundraising docs SOW §5.
        {
          type: "note",
          text: "Alongside token/storage economics, the Business Workspace opens a second, structurally distinct revenue path: SaaS subscription and seat-based pricing for document management, workflow, and the AI Business Assistant — priced and sold independently of storage consumption, the same way a company would evaluate any B2B software tool, with Inaya's DePIN infrastructure underneath but not part of the buying decision.",
        },
      ],
    },
    {
      number: "10",
      title: "Go-To-Market Strategy",
      blocks: [
        {
          type: "numbered",
          items: [
            {
              heading: "Developer Evangelism.",
              body: "Aggressively seeding the ecosystem through hackathons, grants, and deep integration with React and Next.js — developers are the Trojan horse into larger organizations.",
            },
            {
              heading: "Enterprise Partnerships.",
              body: "Targeting mid-market companies optimizing infrastructure costs, particularly those migrating away from legacy virtualization (e.g. VMware) toward modern, distributed stacks.",
            },
            {
              heading: "Community & Node Operators.",
              body: "Incentivizing early hardware providers with attractive bootstrap yields to ensure network redundancy from day one.",
            },
          ],
        },
      ],
    },
    {
      number: "11",
      title: "Traction & Milestones",
      // PROTECTED — mainnet-readiness language, do not edit without founder sign-off.
      blocks: [
        {
          type: "bullets",
          items: [
            "Technical foundation. Open-source framework, core file management components, and integration docs fully active and production-ready.",
            "Deployment & CI/CD. Robust GitHub workflows, secure identity verification, and seamless Vercel production pipelines.",
            "Mainnet readiness. Exhaustive testnet phases executed; deployment parameters reviewed and blocking front-end issues resolved.",
            "Financial structuring. Liquidity pool allocations evaluated and interval-selling strategy formulated ahead of token launch.",
            "Institutional outreach. Investor communications drafted detailing technical milestones, pricing, and go-to-market plans.",
          ],
        },
      ],
    },
    {
      number: "12",
      title: "Token Economics",
      blocks: [
        { type: "lead", text: "The Inaya Token ($INAYA) is the utility and governance lifeblood of the network." },
        {
          type: "columns",
          items: [
            { heading: "Supply", body: "Fixed at 30,000,000 tokens." },
            {
              heading: "Buybacks",
              body: "A share of Enterprise Reserve fiat revenue is algorithmically used for market buybacks, creating deflationary pressure aligned with usage.",
            },
            {
              heading: "Staking",
              body: "Node operators stake $INAYA as an economic guarantee of uptime, earning tapering inflationary rewards plus a share of network fees.",
            },
          ],
        },
      ],
    },
    {
      number: "13",
      title: "Financial Model",
      // PROTECTED — Year 1-5 projections, do not edit without founder sign-off.
      blocks: [
        {
          type: "lead",
          text: "Conservative penetration of the DePIN SAM, driven by an enterprise-first billing strategy.",
        },
        {
          type: "table",
          headers: ["Metric", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5"],
          rows: [
            ["Active Storage (PB)", "15", "60", "200", "650", "1,500"],
            ["Enterprise ARR", "$0.8M", "$3.2M", "$11.5M", "$35.0M", "$85.0M"],
            ["Burn Rate", "$1.5M", "$2.0M", "$2.5M", "$3.5M", "$4.5M"],
            ["Net Income", "($0.7M)", "$1.2M", "$9.0M", "$31.5M", "$80.5M"],
          ],
        },
        {
          type: "note",
          text: "Projections assume successful execution of the Seed use-of-funds and rapid onboarding of targeted Web2 enterprise pilot programs.",
        },
      ],
    },
    {
      number: "14",
      title: "Risks & Mitigations",
      blocks: [
        {
          type: "table",
          headers: ["Risk", "Mitigation"],
          rows: [
            ["Technical\nSmart contract vulnerabilities", "Multiple audits from top-tier security firms prior to mainnet launch."],
            [
              "Execution & Competition\nGetting squeezed by AWS or outpaced by Filecoin",
              "Laser focus on UX/DX and React ecosystems where Web3 protocols traditionally fail. Enterprise Reserve structured so B2B clients never touch the token directly, isolating them from regulatory ambiguity.",
            ],
            ["Regulation\nShifting crypto regulatory frameworks", "Strict vesting schedules, interval selling strategies, and robust staking requirements for node operators."],
            ["Token Dynamics\nPost-launch dump risk", "Strict vesting schedules, interval selling strategies, and robust staking requirements for node operators."],
          ],
        },
      ],
    },
    {
      number: "15",
      title: "Why Inaya Wins",
      blocks: [
        {
          type: "lead",
          text: "Inaya wins because it does not force the market to adapt to Web3 — it adapts Web3 to the market. By providing an open-source framework that feels identical to deploying on Vercel, combined with enterprise-grade fiat billing, Inaya removes the friction of DePIN adoption.",
        },
        {
          type: "quote",
          text: "We win on architecture, we win on developer experience, and we win on sustainable tokenomics designed to accrue value from real-world usage.",
        },
      ],
    },
    {
      number: "16",
      title: "Team",
      blocks: [
        {
          type: "profile",
          name: "Talha Waqas — Founder & CTO",
          paragraphs: [
            "Talha brings deep technical leadership to Inaya, with core expertise architecting secure cryptocurrency wallet operations, orchestrating complex blockchain testnets, and designing robust tokenomic models. A strong track record resolving intricate codebase issues, managing secure server configurations, and streamlining modern web deployments via GitHub and Vercel gives him the blend of Web2 infrastructure knowledge and Web3 protocol design Inaya's roadmap requires.",
            // Updated (August 2026, ecosystem-doc audit pass) — the prior
            // edition described Talha as the sole founder shipping
            // everything alone; the team has since grown to three. AI-
            // assisted development remains real and load-bearing to the
            // velocity described below, it's just no longer attributed to
            // one person working solo.
            "AI-assisted development remains a core part of Inaya's execution model — not a supplementary tool, but a genuine mechanism behind shipping a full product surface (web dApp, mobile app, SDK ecosystem, a complete B2B Business Workspace, a decentralized Security Layer, and more) at this pace with a small founding team. This velocity is a genuine, current differentiator, and expanding the broader team is an explicit, funded use of Seed proceeds.",
          ],
        },
        {
          type: "profile",
          name: "Yakub Adnan — Co-Founder & Growth Lead",
          paragraphs: [
            "Web3 growth operator and community strategist specializing in DePIN, user acquisition, and AI-driven ecosystem scaling. Leads growth architecture, community operations, and campaign distribution — bridging complex protocol features with on-chain adoption.",
          ],
        },
        {
          type: "profile",
          name: "Fibha Urooj — CFO",
          paragraphs: [
            "B.Com in Accounting & Finance. Leads financial planning, budgeting, compliance, and operational finance — building the financial foundation supporting Inaya Network's long-term growth.",
          ],
        },
      ],
    },
    {
      number: "17",
      title: "Funding Ask",
      // PROTECTED — round size, use-of-funds split, milestones, do not edit without founder sign-off.
      blocks: [
        { type: "lead", text: "We are raising a $2,000,000 Seed Round." },
        {
          type: "columns",
          items: [
            {
              heading: "Use of Funds",
              body: "50% Protocol & Front-end Engineering\n30% Go-to-Market, Developer Relations & Marketing\n20% Security Audits, Legal & Liquidity Provisioning",
            },
            {
              heading: "Milestones",
              body: "Full mainnet public launch, first 5 enterprise pilot partners, and 10 PB of decentralized active storage.",
            },
            {
              heading: "Runway",
              body: "24 months, bringing the protocol to self-sustaining profitability based on initial enterprise ARR.",
            },
          ],
        },
      ],
    },
    {
      number: "18",
      title: "Long-Term Vision",
      blocks: [
        {
          type: "paragraphs",
          text: [
            "5 years. Inaya becomes the default storage layer for the decentralized web and the premier DePIN alternative for mid-market enterprises escaping hyperscaler lock-in — capturing 5% of the Web3 storage market.",
            "10 years. As AI and edge computing reshape the internet, centralized data centers become legacy bottlenecks. Inaya evolves into the foundational data substrate of the internet — a globally distributed, perfectly secure, entirely user-owned infrastructure layer powering everything from consumer applications to sovereign AI datasets.",
          ],
        },
        // Approved addition — two-engine framing. See fundraising docs SOW §4/§5.
        {
          type: "note",
          label: "Two engines, one foundation.",
          text: "This trajectory runs on two connected engines. The Web3/DePIN engine — users, node infrastructure, and decentralized storage — remains the foundation. The Business SaaS engine — companies, their workspace, documents, permissions, workflow, and an AI assistant, all running on that same infrastructure — is how that foundation reaches ordinary business users who will never think about blockchain at all. The long-term direction is to make the decentralized layer increasingly invisible, while keeping its security and ownership guarantees fully intact underneath.",
        },
      ],
    },
  ],
};
