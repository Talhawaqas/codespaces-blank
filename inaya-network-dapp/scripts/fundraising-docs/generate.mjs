// scripts/fundraising-docs/generate.mjs
//
// Regenerates the investor-facing PDFs at public/documents/ from the
// structured content in content/*.js. Run:
//
//   node scripts/fundraising-docs/generate.mjs
//
// Uses puppeteer-core against a system-installed Chrome/Edge (no bundled
// Chromium download) — set CHROME_PATH if neither is at its default
// Windows install location. This is the first tracked source these three
// PDFs have ever had in this repo; previously they were edited outside the
// project and the binary was swapped in directly (see the fundraising-docs
// SOW, August 2026, for the investigation that found this).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { executiveSummary } from "./content/executive-summary.js";
import { investmentMemorandum } from "./content/investment-memorandum.js";
import { gtmStrategy } from "./content/gtm-strategy.js";
import { saasBusinessModel } from "./content/saas-business-model.js";
import { operatorManifesto } from "./content/operator-manifesto.js";
import { ecosystemArchitecture } from "./content/ecosystem-architecture.js";
import { ecosystemDevDeepdive } from "./content/ecosystem-dev-deepdive.js";
import { ecosystemOverview } from "./content/ecosystem-overview.js";
import { whitepaper } from "./content/whitepaper.js";
import { companyProfile } from "./content/company-profile.js";
import { communityFaqs } from "./content/community-faqs.js";
import { institutionalFaqs } from "./content/institutional-faqs.js";
import { storageBusinessModel } from "./content/storage-business-model.js";
import { enterpriseRevenueArchitecture } from "./content/enterprise-revenue-architecture.js";
import { sdkGuide } from "./content/sdk-guide.js";
import { buildExecutiveSummaryHTML, buildInvestmentMemorandumHTML, buildGtmStrategyHTML, buildOperatorManifestoHTML } from "./template.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, "../../public/documents");

const CANDIDATE_CHROME_PATHS = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function findChrome() {
  for (const p of CANDIDATE_CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "Could not find a Chrome/Edge install. Set CHROME_PATH to your browser executable and retry."
  );
}

async function renderToPdf(browser, html, outputPath) {
  // One page per document, reusing the single shared browser instance —
  // launching a fresh Chrome process per PDF (the old approach) turned out
  // to be seriously flaky on this machine: the first launch in a run would
  // succeed, then the second+ would intermittently hang past even a 90s
  // navigation timeout. A single long-lived browser sidesteps that
  // per-launch flakiness entirely and is faster besides.
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });
    await page.pdf({
      path: outputPath,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await page.close();
  }
}

async function inlineBrandCss(html) {
  const css = await readFile(path.join(__dirname, "brand.css"), "utf8");
  return html.replace("<head><meta charset=\"utf-8\"/></head>", `<head><meta charset="utf-8"/><style>${css}</style></head>`);
}

async function main() {
  const targets = [
    { name: "inaya-executive-summary.pdf", html: buildExecutiveSummaryHTML(executiveSummary) },
    { name: "inaya-investment-memorandum.pdf", html: buildInvestmentMemorandumHTML(investmentMemorandum) },
    { name: "inaya-gtm-strategy.pdf", html: buildGtmStrategyHTML(gtmStrategy) },
    // Reuses the Investment Memorandum's builder — same {cover, sections,
    // docId} shape, no new template function needed.
    { name: "inaya-saas-business-model.pdf", html: buildInvestmentMemorandumHTML(saasBusinessModel) },
    { name: "inaya-operator-manifesto.pdf", html: buildOperatorManifestoHTML(operatorManifesto) },
    // Reuses the Investment Memorandum's builder — same {cover, sections,
    // docId} shape, no new template function needed.
    { name: "inaya-ecosystem-architecture.pdf", html: buildInvestmentMemorandumHTML(ecosystemArchitecture) },
    { name: "inaya-ecosystem-dev-deepdive.pdf", html: buildInvestmentMemorandumHTML(ecosystemDevDeepdive) },
    { name: "inaya-ecosystem-overview.pdf", html: buildInvestmentMemorandumHTML(ecosystemOverview) },
    // Below: the 7 previously-untracked PDFs, given real source for the
    // first time (August 2026 ecosystem-doc audit pass). All reuse the
    // Investment Memorandum's {cover, sections, docId} builder.
    { name: "inaya-whitepaper.pdf", html: buildInvestmentMemorandumHTML(whitepaper) },
    { name: "inaya-company-profile.pdf", html: buildInvestmentMemorandumHTML(companyProfile) },
    { name: "inaya-community-faqs.pdf", html: buildInvestmentMemorandumHTML(communityFaqs) },
    { name: "inaya-institutional-faqs.pdf", html: buildInvestmentMemorandumHTML(institutionalFaqs) },
    { name: "inaya-business-model.pdf", html: buildInvestmentMemorandumHTML(storageBusinessModel) },
    { name: "inaya-enterprise-revenue-node-reward-architecture.pdf", html: buildInvestmentMemorandumHTML(enterpriseRevenueArchitecture) },
    { name: "inaya-sdk-guide.pdf", html: buildInvestmentMemorandumHTML(sdkGuide) },
  ];

  const executablePath = findChrome();
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    for (const target of targets) {
      const fullHtml = await inlineBrandCss(target.html);
      const outputPath = path.join(OUTPUT_DIR, target.name);
      await renderToPdf(browser, fullHtml, outputPath);
      console.log(`Generated ${outputPath}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Fundraising doc generation failed:", err);
  process.exit(1);
});
