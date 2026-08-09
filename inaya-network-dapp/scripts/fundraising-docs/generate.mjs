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
import { buildExecutiveSummaryHTML, buildInvestmentMemorandumHTML, buildGtmStrategyHTML } from "./template.js";

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

async function renderToPdf(html, outputPath) {
  const executablePath = findChrome();
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: outputPath,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
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
  ];

  for (const target of targets) {
    const fullHtml = await inlineBrandCss(target.html);
    const outputPath = path.join(OUTPUT_DIR, target.name);
    await renderToPdf(fullHtml, outputPath);
    console.log(`Generated ${outputPath}`);
  }
}

main().catch((err) => {
  console.error("Fundraising doc generation failed:", err);
  process.exit(1);
});
