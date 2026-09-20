// scripts/pilot-guides/generate.mjs
//
// Regenerates the two enterprise pilot onboarding PDFs from the structured
// content in this directory. Reuses the exact same brand.css and
// buildInvestmentMemorandumHTML template the fundraising-docs pipeline
// already uses (same {cover, sections, docId} content shape) — one visual
// system across every Inaya PDF, no new renderer needed. Run:
//
//   node scripts/pilot-guides/generate.mjs

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { multicloudGuide } from "./multicloud-content.js";
import { storageCapabilitiesGuide } from "./storage-capabilities-content.js";
import { gcsGuide } from "./gcs-content.js";
import { migrationAgentGuide } from "./migration-agent-content.js";
import { buildInvestmentMemorandumHTML } from "../fundraising-docs/template.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, "../../public/documents");
const BRAND_CSS_PATH = path.resolve(__dirname, "../fundraising-docs/brand.css");

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
  throw new Error("Could not find a Chrome/Edge install. Set CHROME_PATH to your browser executable and retry.");
}

async function inlineBrandCss(html) {
  const css = await readFile(BRAND_CSS_PATH, "utf8");
  return html.replace('<head><meta charset="utf-8"/></head>', `<head><meta charset="utf-8"/><style>${css}</style></head>`);
}

async function renderToPdf(browser, html, outputPath) {
  const page = await browser.newPage();
  try {
    // domcontentloaded, not networkidle0 -- brand.css is inlined as a
    // <style> tag (no external requests), and this proved more reliable
    // than networkidle0 on this machine's Chrome/puppeteer setup.
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.pdf({ path: outputPath, format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close();
  }
}

async function main() {
  const targets = [
    { name: "inaya-pilot-guide-multicloud-storage.pdf", html: buildInvestmentMemorandumHTML(multicloudGuide) },
    { name: "inaya-pilot-guide-advanced-storage-capabilities.pdf", html: buildInvestmentMemorandumHTML(storageCapabilitiesGuide) },
    { name: "inaya-pilot-guide-google-cloud-storage.pdf", html: buildInvestmentMemorandumHTML(gcsGuide) },
    { name: "inaya-pilot-guide-data-migration.pdf", html: buildInvestmentMemorandumHTML(migrationAgentGuide) },
  ];

  const executablePath = findChrome();
  const browser = await puppeteer.launch({ executablePath, headless: true, timeout: 30000 });
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
  console.error("Pilot guide generation failed:", err);
  process.exit(1);
});
