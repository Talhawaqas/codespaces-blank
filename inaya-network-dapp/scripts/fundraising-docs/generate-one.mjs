// scripts/fundraising-docs/generate-one.mjs
//
// Regenerates a single fundraising PDF by name -- for when the full
// 15-document batch in generate.mjs is impractical to re-run just to pick
// up one content edit (e.g. this machine's Chrome/puppeteer flaking on a
// long batch run). Usage:
//
//   node scripts/fundraising-docs/generate-one.mjs ecosystem-overview

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { ecosystemOverview } from "./content/ecosystem-overview.js";
import { ecosystemArchitecture } from "./content/ecosystem-architecture.js";
import { ecosystemDevDeepdive } from "./content/ecosystem-dev-deepdive.js";
import { buildInvestmentMemorandumHTML } from "./template.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, "../../public/documents");

const REGISTRY = {
  "ecosystem-overview": { name: "inaya-ecosystem-overview.pdf", html: buildInvestmentMemorandumHTML(ecosystemOverview) },
  "ecosystem-architecture": { name: "inaya-ecosystem-architecture.pdf", html: buildInvestmentMemorandumHTML(ecosystemArchitecture) },
  "ecosystem-dev-deepdive": { name: "inaya-ecosystem-dev-deepdive.pdf", html: buildInvestmentMemorandumHTML(ecosystemDevDeepdive) },
};

const CANDIDATE_CHROME_PATHS = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

function findChrome() {
  for (const p of CANDIDATE_CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  throw new Error("Could not find a Chrome/Edge install.");
}

async function inlineBrandCss(html) {
  const css = await readFile(path.join(__dirname, "brand.css"), "utf8");
  return html.replace('<head><meta charset="utf-8"/></head>', `<head><meta charset="utf-8"/><style>${css}</style></head>`);
}

async function main() {
  const keys = process.argv.slice(2);
  if (keys.length === 0) {
    console.error(`Usage: node generate-one.mjs <key> [<key> ...]. Known: ${Object.keys(REGISTRY).join(", ")}`);
    process.exit(1);
  }
  for (const key of keys) {
    if (!REGISTRY[key]) {
      console.error(`Unknown target "${key}". Known: ${Object.keys(REGISTRY).join(", ")}`);
      process.exit(1);
    }
  }

  const executablePath = findChrome();
  const browser = await puppeteer.launch({ executablePath, headless: true, timeout: 30000 });
  try {
    for (const key of keys) {
      const target = REGISTRY[key];
      const page = await browser.newPage();
      const fullHtml = await inlineBrandCss(target.html);
      await page.setContent(fullHtml, { waitUntil: "domcontentloaded", timeout: 30000 });
      const outputPath = path.join(OUTPUT_DIR, target.name);
      await page.pdf({ path: outputPath, format: "A4", printBackground: true, preferCSSPageSize: true });
      await page.close();
      console.log(`Generated ${outputPath}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Single-doc generation failed:", err);
  process.exit(1);
});
