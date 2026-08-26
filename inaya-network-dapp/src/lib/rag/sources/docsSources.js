// src/lib/rag/sources/docsSources.js
//
// Source adapters feeding the "docs" domain — each returns
// { sourceId, domain, adapter } for ingest.js. Every adapter reads content
// this app already ships (no new content authored here), so ingestion
// stays a true reflection of what's actually documented.
//
// DELIBERATELY EXCLUDED (documented, not silently skipped):
//  - custody-sdk/SDK_GUIDE.md, README.md — custody-sdk is a separately
//    hosted git repo, explicitly excluded from this repo's tracked files
//    (see .gitignore's own comment). Reading it via fs works in local dev
//    (same disk) but the directory doesn't exist at all on Vercel's build/
//    runtime server — this is the EXACT class of bug that broke this
//    project's production build twice already this session (see the
//    custody-sdk npm-dependency fix). Not risking a repeat for a
//    supplementary knowledge source.
//  - src/app/page.js's KNOWLEDGE_ARTICLES (~1,950 lines) — not extracted
//    into its own module in this pass; INAYA_KNOWLEDGE_BASE already
//    covers the same ground at a curated-summary level, so Docs retrieval
//    isn't crippled by the omission. A real follow-up: extract
//    KNOWLEDGE_ARTICLES into its own src/lib/knowledgeArticles.js (the
//    same pattern learnConfig.js/saasRoadmap.js already use) so both
//    page.js and this adapter can share one source of truth, rather than
//    risk a large mechanical edit to the main dApp page's ~6,000-line
//    file under this pass's time constraints.

import fs from "node:fs";
import path from "node:path";
import { chunkMarkdownByHeading, chunkQaPairs, chunkStructuredSections } from "../chunking.js";
import { INAYA_KNOWLEDGE_BASE } from "../../inaya-knowledge.js";
import { faqs } from "../../../app/faq/page.js";

function readPublicFile(relativePath) {
  try {
    return fs.readFileSync(path.join(process.cwd(), "public", relativePath), "utf8");
  } catch (err) {
    console.error(`rag/docsSources: could not read public/${relativePath}:`, err.message);
    return null;
  }
}

const FUNDRAISING_DOCS = [
  { file: "whitepaper.js", exportName: "whitepaper", title: "Inaya Whitepaper" },
  { file: "community-faqs.js", exportName: "communityFaqs", title: "Inaya Community FAQs" },
  { file: "institutional-faqs.js", exportName: "institutionalFaqs", title: "Inaya Institutional FAQs" },
  { file: "company-profile.js", exportName: "companyProfile", title: "Inaya Company Profile" },
  { file: "executive-summary.js", exportName: "executiveSummary", title: "Inaya Executive Summary" },
  { file: "ecosystem-architecture.js", exportName: "ecosystemArchitecture", title: "Inaya Ecosystem Architecture" },
  { file: "ecosystem-dev-deepdive.js", exportName: "ecosystemDevDeepdive", title: "Inaya Ecosystem Developer Deep-Dive" },
  { file: "ecosystem-overview.js", exportName: "ecosystemOverview", title: "Inaya Ecosystem Overview" },
  { file: "enterprise-revenue-architecture.js", exportName: "enterpriseRevenueArchitecture", title: "Inaya Enterprise Revenue & Node Reward Architecture" },
  { file: "gtm-strategy.js", exportName: "gtmStrategy", title: "Inaya Go-To-Market Strategy" },
  { file: "investment-memorandum.js", exportName: "investmentMemorandum", title: "Inaya Investment Memorandum" },
  { file: "operator-manifesto.js", exportName: "operatorManifesto", title: "Inaya Operator Manifesto" },
  { file: "saas-business-model.js", exportName: "saasBusinessModel", title: "Inaya SaaS Business Model" },
  { file: "sdk-guide.js", exportName: "sdkGuide", title: "Inaya SDK Guide" },
  { file: "storage-business-model.js", exportName: "storageBusinessModel", title: "Inaya Storage Business Model" },
];

async function fundraisingDocAdapter({ file, exportName, title }) {
  const mod = await import(`../../../../scripts/fundraising-docs/content/${file}`);
  const doc = mod[exportName];
  if (!doc?.sections) return [];
  return chunkStructuredSections(doc.sections, {
    sourceId: `fundraising:${file}`, domain: "docs", title, version: doc.docId || null, url: null,
  });
}

export const DOCS_SOURCES = [
  {
    sourceId: "inaya-knowledge-base",
    domain: "docs",
    adapter: () => chunkMarkdownByHeading(INAYA_KNOWLEDGE_BASE, {
      sourceId: "inaya-knowledge-base", domain: "docs", category: "product", url: null,
    }).map((c) => ({ ...c, title: "Inaya Network — Product Knowledge Base" })),
  },
  {
    sourceId: "business-workspace-guide",
    domain: "docs",
    adapter: () => {
      const markdown = readPublicFile("docs/business-workspace-guide.md");
      if (!markdown) return [];
      return chunkMarkdownByHeading(markdown, {
        sourceId: "business-workspace-guide", domain: "docs", category: "business-workspace", url: "/docs/business-workspace-guide.md",
      });
    },
  },
  {
    sourceId: "faq",
    domain: "docs",
    adapter: () => chunkQaPairs(faqs, { sourceId: "faq", domain: "docs", title: "Inaya Network FAQ", category: "faq", url: "/faq" }),
  },
  ...FUNDRAISING_DOCS.map((doc) => ({
    sourceId: `fundraising:${doc.file}`,
    domain: "docs",
    adapter: () => fundraisingDocAdapter(doc),
  })),
];
