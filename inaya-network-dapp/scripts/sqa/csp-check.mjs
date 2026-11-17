// scripts/sqa/csp-check.mjs -- opens public pages (and, with --cookie, signed-in pages) in headless Chrome and reports
// every Content-Security-Policy violation the browser raises (securitypolicyviolation events + "Refused to" console
// errors). Used to verify csp.config.mjs before it ships (SQA 17 Nov 2026).
//   node scripts/sqa/csp-check.mjs [--base http://localhost:3001] [--cookie <session token>] [--paths /a,/b]
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const BASE = arg("base", "http://localhost:3001");
const COOKIE = arg("cookie");
const PATHS = (arg("paths", "/,/business,/business/pricing,/business/demo,/about,/faq,/learn,/apps,/nfts,/reserve,/stats,/trust,/security,/docs,/whitepaper,/changelog,/download,/book,/support,/privacy,/terms,/build,/bridge,/dataroom,/verify-document,/meet,/portal,/guardian,/operator,/outlook/taskpane.html")).split(",");
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
if (COOKIE) await page.setCookie({ name: "inaya_org_session", value: COOKIE, url: BASE });
await page.evaluateOnNewDocument(() => {
  document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP-VIOLATION ${e.violatedDirective} ${e.blockedURI || "(inline)"} ${e.sourceFile || ""}`));
});
let current = ""; const hits = {};
page.on("console", (m) => { const t = m.text(); if (/CSP-VIOLATION|Content Security Policy/i.test(t)) (hits[current] ||= new Set()).add(t.slice(0, 240)); });
let total = 0;
for (const p of PATHS) {
  current = p;
  let status = "";
  try { const r = await page.goto(BASE + p, { waitUntil: "networkidle2", timeout: 120000 }); status = r?.status(); } catch (e) { status = "nav-error " + e.message.slice(0, 60); }
  await new Promise((r) => setTimeout(r, 2500));
  const n = hits[p]?.size || 0; total += n;
  console.log(`${n ? "CSP " : "ok  "} ${p.padEnd(28)} ${status}${n ? "\n   " + [...hits[p]].join("\n   ") : ""}`);
}
console.log(`\n${PATHS.length} pages, ${total} CSP violations`);
await browser.close();
