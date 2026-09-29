// scripts/pilot-guides/build-complete-guide-v2.mjs
//
// The Complete Inaya Network Guide, second edition: the original 47 step-by-step sections PLUS every product added since, assembled from the real
// product documentation, runbooks and READMEs (converted verbatim by md-to-blocks.mjs, so commands and steps cannot drift from their source).
//
//   node scripts/pilot-guides/build-complete-guide-v2.mjs [outputPdfPath]
//
// Extra (non-repo) user summaries are read from INAYA_GUIDE_EXTRA_DIR (default: the current user's Downloads folder); a missing file is skipped and
// reported, never silently invented.

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { mdToBlocks, stripFrontmatter } from "./md-to-blocks.mjs";
import { completeFeatureGuide } from "./complete-feature-guide-content.js";
import { multicloudGuide } from "./multicloud-content.js";
import { storageCapabilitiesGuide } from "./storage-capabilities-content.js";
import { gcsGuide } from "./gcs-content.js";
import { migrationAgentGuide } from "./migration-agent-content.js";
import { buildGtmStrategyHTML } from "../fundraising-docs/template.js";
import { ROADMAP_STAGES } from "../../src/lib/saasRoadmap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "../..");           // inaya-network-dapp
const REPO = path.resolve(APP, "..");                    // monorepo root
const EXTRA = process.env.INAYA_GUIDE_EXTRA_DIR || path.join(os.homedir(), "Downloads");
const OUT = process.argv[2] || path.join(EXTRA, "Inaya Complete Ecosystem Guide.pdf");
const missing = [];

function src(p) { const full = path.isAbsolute(p) ? p : path.join(APP, p); if (!existsSync(full)) { missing.push(p); return null; } return readFileSync(full, "utf8"); }
function fromMd(p, opts = {}) { const t = src(p); if (!t) return []; return mdToBlocks(t, opts).blocks; }
const lead = (what, why) => [{ type: "paragraphs", text: [`WHAT IT IS. ${what}`, `WHY USE IT. ${why}`] }];
// complete-feature-guide-content.js grew from 47 to 56 sections
// (2026-09-29, nine real completed SOWs added) -- this counter must track
// its actual current section count, or this script's own appended
// sections collide/renumber incorrectly.
let counter = 56;
const entries = [];
const PLACEHOLDERS = [];
const R = (from, to) => { const token = `@@REF${PLACEHOLDERS.length}@@`; PLACEHOLDERS.push({ token, from, to }); return token; };
const divider = (kicker, title, subtitle) => entries.push({ type: "divider", kicker, title, subtitle });
let currentPart = "I";
function section(title, blocks, part = currentPart) { counter += 1; if (blocks.length) entries.push({ number: String(counter), part, title, blocks }); else missing.push(`(empty) ${title}`); }

// ---------------------------------------------------------------- cover
const cover = {
  company: "INAYA NETWORK",
  classification: "COMPLETE ECOSYSTEM GUIDE",
  kicker: "STEP-BY-STEP · SECOND EDITION",
  title: "The Complete Inaya Ecosystem Guide",
  subtitle: "What every product is, why you would use it, and exactly how to use it, with every command and instruction. The wallet dApp, Business Workspace, storage and edge products, AI and automation, identity, developer tools and the roadmap.",
  docLine: "Document INAYA-GUIDE-2026-V2 · Edition of 27 September 2026",
};

// ---------------------------------------------------------------- PART 0/I: how to read + product map + the original 47 sections
divider("PART I", "Start here, the wallet dApp and the Business Workspace", "The original step-by-step guide (sections 01 to 47), plus a product map of the whole ecosystem.");
entries.push({
  number: "00", part: "I", title: "How to Use This Guide, and the Product Map",
  blocks: [
    { type: "paragraphs", text: [
      "Inaya is a family of products built on one idea: your data and your business records stay encrypted and under your control, every important action leaves tamper-evident proof, and AI assists but never acts without permission. This guide covers all of it, in the order most people meet it.",
      "Every product section answers three questions: WHAT IT IS, WHY USE IT, and HOW (numbered steps, screens to open, and every command to run). Parts II to IV are assembled directly from each product's own documentation, runbooks and READMEs, so the commands and steps are the real ones.",
    ] },
    { type: "subsection", heading: "How the status labels work" },
    { type: "table", headers: ["Label", "Meaning"], rows: [
      ["VERIFIED / Proven", "Tested against the real thing: a real database, a real client tool, a real outside account."],
      ["UNVERIFIED / Not yet verified", "Built and tested against a local stand-in, but not against the real outside product or service."],
      ["Testnet", "Runs on a test blockchain with test tokens; no real money is involved."],
      ["Not built / FUTURE", "Deliberately not built yet, and stated plainly so nobody plans around it."],
    ] },
    { type: "subsection", heading: "Product map: what each product is, and why you would use it" },
    { type: "table", headers: ["Product", "What it is", "Why use it", "See"], rows: [
      ["Sovereign Vault (wallet dApp)", "Encrypt files in your browser, split them into two halves stored on independent networks, and register proof of ownership on-chain.", "Nobody, including Inaya, can read your files or take them; you can prove what you stored and when.", "04 to 05"],
      ["Staking, referrals, airdrop, faucet", "The $INAYA token features on BNB Chain Testnet.", "Earn rewards, get test tokens, take part in the network.", "02, 07 to 09"],
      ["Business Workspace", "A full business suite (documents, projects, tasks, CRM, procurement, inventory, finance, HR) on encrypted, permissioned storage.", "One workplace where files, deals and money are private by default and provable.", "11 to 27, 33 to 36"],
      ["Evidence Graph, Audit Trail, Digital Twin", "Tamper-evident records of business events, and read-only what-if simulations.", "Answer \"why did this happen?\" and \"what if?\" with proof, not memory.", "24 to 26"],
      ["AI Business Assistant and Voice", "An assistant that answers from your own permission-scoped data.", "Ask questions of your business in plain language, safely.", "35, " + R("The Voice AI")],
      ["Automations (AI Business Operations Manager)", "A visual builder for automatic routines with AI, approvals and evidence.", "Stop repeating daily checks; keep humans in charge of anything that matters.", R("Automations")],
      ["Document & Invoice Automation", "Nine document types generated from your real records, approved, encrypted and delivered.", "Correct, numbered, traceable invoices and documents without retyping.", R("Document & Invoice Automation")],
      ["Customer Portal & Customer Service", "A support desk: tickets, a customer portal, SLAs, knowledge base, AI assist, and Help & Support for Inaya's own users.", "Look after customers properly, and get help from Inaya yourself.", R("Customer Portal, Customer Service")],
      ["Identity Integration", "Microsoft Entra, Active Directory, SCIM, Rewst and MSP integration with verified leaver revocation.", "When someone leaves your directory, prove they lost access.", R("Identity Integration — Overview", "Identity — Troubleshooting")],
      ["AI Bookkeeper", "AI reads bills, receipts and bank statements, matches and reconciles them, and asks a person when unsure.", "Cut the matching work without giving up control.", R("AI Bookkeeper")],
      ["AI Security Workflow and Controlled Actions", "One checkpoint in front of every text AI, and human approval for risky AI actions.", "Stop prompt injection and data leaks; keep a person in charge.", R("AI Security Workflow", "AI Controlled Actions")],
      ["S3, Azure and Google-compatible storage", "Use Inaya storage from the AWS CLI, rclone, AzCopy, gsutil and Terraform.", "Adopt Inaya without changing your tools or scripts.", "28, 29, " + R("Multi-Cloud Storage", "Verified Client Commands")],
      ["Storage Control Plane, Inaya Drive, migration, DirectSync, Cloud Backup", "Volumes, snapshots, a mountable drive, moving data in, automatic backup.", "Run and protect storage like infrastructure.", "30 to 32, " + R("The Terraform Provider", "Verifying Downloads")],
      ["Sovereign NAS", "A managed on-premises file server (SMB/NFS) with snapshots, WORM, ransomware response and backup.", "Local speed and data residency with cloud-grade protection.", R("Sovereign NAS", "Sovereign NAS — Deployment")],
      ["Mainframe & Legacy Data Access", "Query old databases with standard SQL, JDBC and ODBC, read-only and audited.", "Use legacy data in modern tools without moving it.", R("Mainframe & Legacy", "The Inaya ODBC")],
      ["Developer tools", "The SDK, React components, CLI, node daemon, scaffolding tool, bridge SDK, public API, Terraform provider.", "Build on Inaya, automate it, or run a node.", "45, 46, " + R("The Custody SDK: Quick Start", "IP Protection")],
      ["Industry workspaces", "Health, Legal, Financial, Private Capital, Regulated and Government OS.", "Vertical features and controls for regulated work.", "37, " + R("Health OS and Legal OS", "Enterprise OS")],
      ["Cross-chain bridge and interoperability", "Move value between chains.", "Use Inaya across networks.", "43, " + R("Cross-Chain, Interoperability")],
      ["Roadmap and quality review", "What each stage delivers and how the codebase is being hardened.", "Know what is real today and what is coming.", R("The Roadmap", "Glossary")],
    ] },
  ],
});
for (const s of completeFeatureGuide.sections) entries.push({ number: s.number, part: "I", title: s.title, blocks: s.blocks });

// ---------------------------------------------------------------- PART II: AI, automation, business systems
divider("PART II", "AI, automation and business systems", "Automations, documents, the support desk, identity, the bookkeeper, AI security, controlled actions and voice.");
currentPart = "II";
section("Automations — the AI Business Operations Manager", [...lead("A visual, node-based builder in the Business Workspace for automatic routines: a trigger, steps that read your data, an AI analysis, rules, notifications and approvals.", "Companies repeat the same checks every day. Automations run them for you, explain every decision, and never change a record without a person's approval."), ...fromMd("content/docs/products/ai-business-operations-manager.md")]);
section("Document & Invoice Automation", [...lead("One pipeline that turns your Finance, CRM and Procurement records into nine kinds of professional, numbered, approved, encrypted documents, then delivers and verifies them.", "Documents always match the source records, every number is accounted for, and every step leaves proof an auditor can check."), ...fromMd("content/docs/products/document-automation.md"), { type: "subsection", heading: "Operating it: state, playbooks and limits (runbook)" }, ...fromMd("docs/document-automation-runbook.md")]);
section("Customer Portal, Customer Service and Help & Support", [...lead("A complete support desk: a customer portal, tickets with business-hours SLAs, a knowledge base, an AI helper, and a Help & Support entry so Inaya's own users can raise a ticket with Inaya.", "Look after your customers in one place, and get your own questions answered by the Inaya team, with an email copy going to the support mailbox."), ...fromMd("content/docs/products/customer-portal.md")]);
section("Identity Integration — Overview", [...lead("Inaya follows your company's directory (Microsoft Entra, Active Directory) so access follows your real starters, movers and leavers, with verified revocation.", "Manual access management is slow and risky, especially when someone leaves."), ...fromMd("content/docs/identity/identity-integration.md")]);
for (const [t, f] of [["Identity — Architecture", "identity-architecture"], ["Identity — Directories: Entra, Active Directory and others", "identity-directories"], ["Identity — Microsoft Entra Step by Step", "identity-microsoft-entra"], ["Identity — SCIM", "identity-scim"], ["Identity — Joiner, Mover and Leaver Lifecycle", "identity-lifecycle"], ["Identity — Group and Attribute Mapping", "identity-mapping"], ["Identity — Rewst and Automation Platforms", "identity-rewst"], ["Identity — RMM, PSA and HR Tools", "identity-rmm-psa-hr"], ["Identity — Managed Service Providers (MSP)", "identity-msp"], ["Identity — Reconciliation, Access Reviews and Orphans", "identity-reconciliation-review"], ["Identity — The API", "identity-api"], ["Identity — Security", "identity-security"], ["Identity — Troubleshooting and FAQ", "identity-troubleshooting-faq"]]) section(t, fromMd(`content/docs/identity/${f}.md`));
section("AI Bookkeeper", [...lead("The AI reads bills, receipts and bank statements, works out what they are and which payments they match, and hands anything doubtful or risky to a person.", "Bookkeeping is mostly matching. This removes the matching work while a person still confirms everything that changes a record."), ...fromMd("content/docs/products/ai-bookkeeper.md")]);
section("AI Security Workflow", [...lead("A single gateway in front of Inaya's text AI assistants that detects prompt injection and personal data, applies your organization's policy and records every decision.", "Attackers hide instructions in documents and people paste private data into chats. One shared checkpoint protects every assistant and explains its decisions."), ...fromMd("content/docs/products/ai-security.md")]);
section("AI Controlled Actions — Human Approval for AI Proposals", [...lead("The rule that an AI may propose a business change but a person must approve it, followed by a 36-hour delay and then execution.", "AI mistakes and manipulation cannot change your records, because a human and a waiting period stand in between."), ...fromMd("docs/ai-controlled-actions.md")]);
section("The Voice AI Assistant", [...lead("Speak to the Business Assistant instead of typing.", "Hands-free access to the same permission-scoped answers."), ...fromMd("docs/inaya-voice-ai-assistant.md")]);
section("Managed Database, Document Intelligence & AI/ML Studio", [...lead("A real, provisioned PostgreSQL database, a general document-understanding studio for any document type, and an AI workbench for data cataloguing, quality checks, model registry and a governed sandboxed code runner.", "A growing business needs a real database and a way to read documents it did not have a specific reader for, and a data team needs somewhere safe to catalogue data and run code without standing up its own infrastructure."), ...fromMd("content/docs/products/managed-database-ml-studio.md")]);

// ---------------------------------------------------------------- PART III: storage, edge, data access
divider("PART III", "Storage, edge and data-access products", "Sovereign NAS, mainframe and legacy data access, multi-cloud storage, migration, backup and verification.");
currentPart = "III";
section("Sovereign NAS", [...lead("Turns a Linux machine on your network into real SMB/NFS file storage, managed, snapshotted, ransomware-aware and audited by Inaya, and keeps working when the internet is down.", "Local speed and data residency, with the protection and proof of a cloud service."), ...fromMd("content/docs/products/sovereign-nas.md")]);
section("Sovereign NAS — Deployment Profile, Support Matrix and Recovery Runbook", fromMd("docs/nas-runbook.md"));
section("Mainframe & Legacy Data Access (SQL Virtualization)", [...lead("Connect an old database once, publish the tables you choose, and query them live with standard SQL, JDBC or ODBC: read-only, permission-scoped and audited.", "Modern tools can use legacy data without an expensive migration project."), ...fromMd("content/docs/products/legacy-data-access.md")]);
section("The Inaya JDBC Driver", fromMd("jdbc-driver/README.md"));
section("The Inaya ODBC Driver", fromMd("odbc-driver/README.md"));
section("The Terraform Provider", [...lead("A Terraform provider for Inaya storage resources, snapshots and backup policies.", "Manage Inaya storage as code, with reviewable changes."), ...fromMd("terraform-provider-inaya/README.md")]);
for (const [name, g] of [["Multi-Cloud Storage: AWS S3 and Azure Blob", multicloudGuide], ["Advanced Storage Capabilities: Versioning, Object Lock, Lifecycle and Access Grants", storageCapabilitiesGuide], ["Google Cloud Storage Compatibility", gcsGuide], ["Migrating Existing Cloud Data with the Migration Agent", migrationAgentGuide]]) {
  const merged = []; for (const s of g.sections) { merged.push({ type: "subsection", heading: `${s.number ? s.number + " · " : ""}${s.title}` }); merged.push(...s.blocks); }
  section(name, merged);
}
section("Migration Agent (command reference)", fromMd("../inaya-migration-agent/README.md"));
section("Verified Client Commands: AWS CLI and rclone Against Inaya Storage", [
  ...lead("Exact commands that were run against a live Inaya server during the quality review and passed.", "Copy them to check your own setup, or to see what a working integration looks like. Create an S3-compatible credential first (Business Workspace, S3-Compatible Storage, then Create credential); the secret is shown once."),
  { type: "subsection", heading: "AWS CLI (verified)" },
  { type: "code", label: "bash", text: "export AWS_ACCESS_KEY_ID=<your access key id>\nexport AWS_SECRET_ACCESS_KEY=<your secret>\nexport AWS_DEFAULT_REGION=inaya\n\n# use your deployment's address; the S3 endpoint is <site>/api/s3\nEP=\"--endpoint-url https://www.inayanetwork.com/api/s3\"\n\naws $EP s3 mb s3://my-bucket                                 # create a bucket\naws $EP s3 cp report.pdf s3://my-bucket/2026/report.pdf      # upload\naws $EP s3 cp \"my file (v1).pdf\" s3://my-bucket/             # names with spaces and brackets work\naws $EP s3 ls s3://my-bucket/ --recursive                    # list\naws $EP s3 cp s3://my-bucket/2026/report.pdf ./report.pdf    # download\naws $EP s3api head-object --bucket my-bucket --key 2026/report.pdf   # size, ETag (the content MD5), checksum\naws $EP s3api get-object --bucket my-bucket --key 2026/report.pdf --range bytes=0-1023 first-kb.bin   # byte range\naws $EP s3 presign s3://my-bucket/2026/report.pdf --expires-in 3600   # temporary download link (up to 7 days)\naws $EP s3 rm s3://my-bucket/2026/report.pdf                 # delete" },
  { type: "bullets", items: ["Large files use multipart upload automatically. Completing a very large object takes about a minute per 30 MB; keep the client's read timeout at its default or higher, and the retry is safe (the server completes once and answers the same to every retry).", "On the hosted site each request body is limited to about 4.5 MB by the hosting platform, so set the client chunk size to 4 MB or less for large uploads: aws configure set default.s3.multipart_chunksize 4MB.", "The ETag is the content MD5 for objects written from 27 September 2026 (md5-of-part-md5s-N for multipart), as in real S3. Older objects keep their earlier ETag."] },
  { type: "subsection", heading: "rclone (verified)" },
  { type: "code", label: "bash", text: "export RCLONE_CONFIG_INAYA_TYPE=s3\nexport RCLONE_CONFIG_INAYA_PROVIDER=Other\nexport RCLONE_CONFIG_INAYA_ENDPOINT=https://www.inayanetwork.com/api/s3\nexport RCLONE_CONFIG_INAYA_REGION=inaya\nexport RCLONE_CONFIG_INAYA_ACCESS_KEY_ID=<your access key id>\nexport RCLONE_CONFIG_INAYA_SECRET_ACCESS_KEY=<your secret>\n\nrclone mkdir inaya:my-bucket\nrclone copy ./folder inaya:my-bucket -v            # upload a folder\nrclone lsf -R inaya:my-bucket                       # list\nrclone check ./folder inaya:my-bucket               # verify by checksum (uses the MD5 ETag)\nrclone check ./folder inaya:my-bucket --download    # verify byte by byte\nrclone sync ./folder inaya:my-bucket -v             # make the bucket match the folder\nrclone purge inaya:my-bucket                        # delete the bucket contents" },
  { type: "note", label: "Verification status.", text: "AWS CLI and rclone were verified end to end against a live Inaya server on 26 to 27 September 2026 (upload, download, listing, ranged reads, presigned links, multipart, special-character names, integrity checks, wrong-secret rejection). AzCopy, gsutil and Terraform were verified in earlier work and are covered in the pilot guides above; they were not re-run in this review. One known oddity: after editing a single file, rclone sync re-copied every file in a test run; this is being investigated (Inaya may not preserve user metadata such as modification time)." },
]);
section("DirectSync — Automatic Folder Backup from the Desktop App", fromMd("docs/directsync-report.md"));
section("Smart Cloud Backup and Health Scheduler", fromMd("docs/cloud-backup-scheduler-report.md"));
section("Verifying Downloads and Reproducible Builds", [...fromMd("docs/reproducible-builds-and-verification.md"), { type: "subsection", heading: "Verifying the SDK release" }, ...fromMd("custody-sdk/docs/VERIFYING_RELEASES.md")]);

// ---------------------------------------------------------------- PART IV: developers
divider("PART IV", "Developers and integrators", "The SDK, the React components, the CLI, the node daemon, the scaffolding tool, the bridge SDK, Trust Fabric and the public API.");
currentPart = "IV";
section("The Custody SDK: Quick Start", fromMd("custody-sdk/README.md"));
section("The Custody SDK: Developer Guide", fromMd("custody-sdk/SDK_GUIDE.md"));
section("The Ecosystem Packages: React, CLI, Scaffolding and Node Daemon", fromMd("custody-sdk/packages/README.md"));
section("The React Components", fromMd("custody-sdk/packages/react/README.md"));
section("inaya-cli: Command Reference", fromMd("custody-sdk/packages/cli/README.md"));
section("create-inaya-dapp: Scaffolding", fromMd("custody-sdk/packages/create-inaya-dapp/README.md"));
section("The Node Operator Daemon: Command Reference", fromMd("custody-sdk/packages/node-daemon/README.md"));
section("The Bridge SDK", fromMd("custody-sdk/packages/bridge-sdk/README.md"));
section("Trust Fabric: Compliance Proofs, Attestation and Intent Routing", [...(src(path.join(EXTRA, "TRUST_FABRIC_SOW_USER_SUMMARY.md")) ? fromMd(path.join(EXTRA, "TRUST_FABRIC_SOW_USER_SUMMARY.md")) : []), { type: "subsection", heading: "Design record" }, ...fromMd("custody-sdk/docs/trust-fabric-phase0-1.md"), ...fromMd("custody-sdk/docs/trust-fabric-phase3-adr.md")]);
{
  const api = [];
  try { const m = await import("../../src/lib/docsApiReference.js"); const list = m.API_ENDPOINTS || m.ENDPOINTS || m.default || Object.values(m).find((v) => Array.isArray(v)); if (Array.isArray(list)) api.push({ type: "table", headers: ["Method", "Path", "What it does"], rows: list.map((e) => [e.method, e.path, e.summary || e.description || e.title || ""]) }); } catch (err) { missing.push("docsApiReference: " + err.message); }
  section("The Public API and OpenAPI Specification", [...lead("A small, stable HTTP API authenticated with an organization API key (Authorization: Bearer <key>).", "Integrate Inaya into your own systems and scripts. The machine-readable OpenAPI 3.0 description is published at /openapi.json on the site and is generated from the same reference data."), ...api, ...fromMd("content/docs/developer/overview.md")]);
}
section("Contributing to the Documentation", fromMd("content/docs/developer/contributing.md"));
section("IP Protection and Ownership", fromMd("../docs/ip-protection/README.md"));

// ---------------------------------------------------------------- PART V: verticals and reference
divider("PART V", "Industry workspaces, roadmap and reference", "Health, Legal, Financial, Government and Enterprise OS, the cross-chain layers, the roadmap and the quality review.");
currentPart = "V";
for (const [t, f] of [["Health OS and Legal OS", "HEALTH_LEGAL_OS_USER_SUMMARY.md"], ["Financial Services, Private Capital and Regulated Enterprise OS", "FINANCIAL_REGULATED_SOW_USER_SUMMARY.md"], ["Government and Public Sector OS", "GOVERNMENT_OS_USER_SUMMARY.md"], ["Enterprise OS", "ENTERPRISE_OS_USER_SUMMARY.md"], ["Business Workspace: Four Extensions (Data Room Templates, What-If Studio and more)", "Business Workspace - Four New Features Update.md"], ["The Hackathon", "Hackathon_Announcement_Summary.md"]]) { const p = path.join(EXTRA, f); section(t, existsSync(p) ? fromMd(p) : (missing.push(f), [])); }
{
  const b = []; for (const [t, f] of [["Cross-chain bridge", "../CROSS_CHAIN_BRIDGE_USER_SUMMARY.md"], ["Interoperability layer", "../INTEROP_LAYER_USER_SUMMARY.md"], ["Multichain update", "../MULTICHAIN_UPDATE_USER_SUMMARY.md"], ["Security layer", "../SECURITY_LAYER_USER_SUMMARY.md"], ["Node registry and daemon", "../NODE_REGISTRY_AND_DAEMON_SUMMARY.md"], ["The desktop apps", "../DAPP_DESKTOP_APP_USER_SUMMARY.md"]]) { b.push({ type: "subsection", heading: t }, ...fromMd(f)); }
  section("Cross-Chain, Interoperability, Security Layer, Node Registry and Desktop Apps: User Summaries", b);
}
section("The Ecosystem Overview and Benefits", [...fromMd("../INAYA_ECOSYSTEM_OVERVIEW.md"), { type: "subsection", heading: "Features and benefits" }, ...fromMd("INAYA_ECOSYSTEM_FEATURES_AND_BENEFITS.md"), { type: "subsection", heading: "For individuals, corporations and enterprises" }, ...fromMd("../INAYA_FOR_INDIVIDUALS_CORPORATE_ENTERPRISE.md")]);
section("The Roadmap: What Each Stage Delivers", [
  { type: "paragraphs", text: ["Generated from the roadmap data that also powers the website's Business Roadmap page. A stage is marked LIVE only when it really ships; every unverified piece is named in its notes."] },
  ...ROADMAP_STAGES.flatMap((s) => [{ type: "subsection", heading: `Stage ${s.number} · ${s.title} [${s.status}]` }, { type: "paragraphs", text: [s.description] }, ...(s.features?.length ? [{ type: "bullets", items: s.features }] : []), ...(s.notes ? [{ type: "note", label: "Verification and limits.", text: s.notes }] : [])]),
]);
section("Quality and Security Review: Defects Found and Fixed", [...lead("An independent quality review that attacks the product, fixes what it finds and locks each fix in with a test.", "It tells you what has been hardened, what remains open, and what could not be verified."), ...fromMd("docs/sqa/master-defect-registry.md")]);
section("Glossary", [{ type: "table", headers: ["Term", "Meaning"], rows: [
  ["dApp", "Decentralized application: the wallet-based Inaya website."], ["Passkey", "The secret you set to encrypt files in your browser. Inaya never sees it; lose it and the files cannot be recovered."], ["Shard", "One half of an encrypted file. Each half is stored on a different network, so neither alone is useful."], ["Pinning provider", "A service that stores shards (Pinata, Filebase)."], ["Evidence Graph", "A connected, tamper-evident record of business events and how they relate."], ["Audit chain", "A hash-linked log where changing any entry breaks every later one."], ["Controlled Action", "An AI-proposed change that waits for a person's approval and a 36-hour delay."], ["Digital Twin", "A read-only simulation of your organization for what-if questions."], ["WORM", "Write once, read many: data that cannot be changed or deleted until a date."], ["SCIM", "The standard protocol directories use to create, update and remove users in another system."], ["SigV4", "The request-signing method used by the AWS CLI and SDKs; Inaya accepts it."], ["Presigned URL", "A temporary link that grants one action on one object until it expires."], ["ETag", "The content fingerprint returned by S3-compatible storage (the MD5 for single-part objects)."], ["SLA", "A service-level deadline for responding to or resolving a ticket."], ["MSP", "Managed service provider: a company that looks after several customer companies."], ["Testnet", "A test blockchain with test tokens."],
] }]);

// resolve the product map's section references from the real numbering
{
  const num = (prefix) => { const e = entries.find((x) => x.number && x.title.startsWith(prefix)); if (!e) throw new Error("product map: no section starts with " + prefix); return e.number; };
  const resolve = (v) => (typeof v === "string" ? PLACEHOLDERS.reduce((acc, p) => acc.split(p.token).join(p.to ? `${num(p.from)} to ${num(p.to)}` : num(p.from)), v) : v);
  for (const e of entries) for (const b of e.blocks || []) if (b.type === "table") b.rows = b.rows.map((r) => r.map(resolve));
}

// ---------------------------------------------------------------- render
const content = { cover, docId: "INAYA-GUIDE-2026-V2", entries };
const html = buildGtmStrategyHTML(content);
const css = await readFile(path.resolve(__dirname, "../fundraising-docs/brand.css"), "utf8");
const full = html.replace('<head><meta charset="utf-8"/></head>', `<head><meta charset="utf-8"/><style>${css}
.code-block pre{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
table.data td,table.data th{word-break:break-word;overflow-wrap:anywhere}</style></head>`);
if (process.env.HTML_OUT) (await import("node:fs")).writeFileSync(process.env.HTML_OUT, full);
const chrome = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome"].filter(Boolean).find((p) => existsSync(p));
if (!chrome) throw new Error("No Chrome/Edge found; set CHROME_PATH.");
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, timeout: 60000 });
try {
  const page = await browser.newPage();
  await page.setContent(full, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.pdf({ path: OUT, format: "A4", printBackground: true, preferCSSPageSize: true, timeout: 600000 });
} finally { await browser.close(); }
console.log(`Wrote ${OUT}`);
console.log(`Sections: ${entries.filter((e) => e.number).length}; parts: 5`);
if (missing.length) console.log("SKIPPED / EMPTY SOURCES:\n - " + missing.join("\n - "));
