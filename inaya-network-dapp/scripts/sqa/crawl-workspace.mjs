// scripts/sqa/crawl-workspace.mjs — opens every Business Workspace module in a real (headless) browser as a signed-in
// company owner and records what a customer would hit: page crashes, error screens, console errors, failed API
// calls (4xx/5xx), and how long each module takes to settle. Screenshots at desktop and phone width.
//
//   node scripts/sqa/crawl-workspace.mjs --cookie <session token> [--base http://localhost:3000] [--out <dir>] [--only key1,key2] [--mobile]
//
// Runs against a dev server on the TEST database (npm run dev:testdb) with a throwaway company (test/_chunked_ui_seed.mjs).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { NAV_ITEMS } from "../../src/lib/navigation/navItems.js";

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const BASE = arg("base", "http://localhost:3000");
const COOKIE = arg("cookie");
const OUT = arg("out", path.join(os.tmpdir(), "sqa-crawl"));
const ONLY = arg("only", "");
const MOBILE = process.argv.includes("--mobile");
if (!COOKIE) { console.error("--cookie is required"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport(MOBILE ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
await page.setCookie({ name: "inaya_org_session", value: COOKIE, url: BASE });
// Skip the first-run welcome so it doesn't cover every screen.
await page.evaluateOnNewDocument(() => { try { for (let i = 0; i < localStorage.length; i++) { /* noop */ } } catch {} document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP-VIOLATION ${e.violatedDirective} ${e.blockedURI || "(inline)"}`)); });

let current = null;
const findings = {};
const note = (kind, text) => { if (!current) return; (findings[current] ||= { console: [], failed: [], pageErrors: [] })[kind].push(String(text).slice(0, 300)); };
page.on("console", (m) => { if (m.type() === "error") note("console", m.text()); });
page.on("pageerror", (e) => note("pageErrors", e.message));
page.on("response", (r) => { const u = r.url(); if (u.startsWith(BASE) && u.includes("/api/") && r.status() >= 400) note("failed", `${r.status()} ${r.request().method()} ${u.replace(BASE, "").slice(0, 160)}`); });

// Warm-up: load the Workspace once and dismiss the welcome dialog.
await page.goto(`${BASE}/business`, { waitUntil: "networkidle2", timeout: 180000 }).catch(() => {});
await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /skip for now/i.test(x.innerText)); b?.click(); });

const keys = NAV_ITEMS.map((i) => i.key).filter((k) => !ONLY || ONLY.split(",").includes(k));
const results = [];
for (const key of keys) {
  current = key;
  findings[key] = { console: [], failed: [], pageErrors: [] };
  const started = Date.now();
  let navError = null;
  try { await page.goto(`${BASE}/business?view=${key}`, { waitUntil: "networkidle2", timeout: 90000 }); }
  catch (e) { navError = e.message; }
  // A screen counts as stuck only if it is still showing nothing but "Loading…" after 60 s (dev mode compiles each
  // module on first visit, which alone can take tens of seconds).
  await page.waitForFunction(() => { const t = (document.body.innerText || "").trim(); return t.length > 400 || !/^loading…?$/i.test(t); }, { timeout: 60000, polling: 1000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  // A module may navigate on its own (a redirect); measure again on the page it lands on instead of crashing.
  const measure = () => page.evaluate(() => {
    const t = document.body.innerText || "";
    return {
      errorScreen: /something went wrong|application error|unhandled runtime error|this page could not be found/i.test(t),
      loading: /^\s*loading…?\s*$/im.test(t) && t.length < 400,
      textLength: t.length,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
      landedOn: location.pathname + location.search,
    };
  });
  let screen;
  try { screen = await measure(); } catch { await new Promise((r) => setTimeout(r, 3000)); screen = await measure().catch((e) => ({ errorScreen: false, loading: false, textLength: 0, overflowX: false, landedOn: `unmeasurable: ${e.message}` })); }
  const ms = Date.now() - started;
  await page.screenshot({ path: path.join(OUT, `${MOBILE ? "m-" : ""}${key}.png`) }).catch(() => {});
  const f = findings[key];
  const r = { key, ms, navError, ...screen, console: f.console.length, failed: f.failed, pageErrors: f.pageErrors, consoleErrors: f.console };
  results.push(r);
  writeFileSync(path.join(OUT, `${MOBILE ? "mobile" : "desktop"}-results.json`), JSON.stringify(results, null, 2)); // saved as it goes
  const bad = navError || screen.errorScreen || f.pageErrors.length || f.failed.length || f.console.length || screen.loading || (MOBILE && screen.overflowX);
  console.log(`${bad ? "ISSUE" : "ok   "} ${key.padEnd(22)} ${String(ms).padStart(6)}ms${screen.errorScreen ? " ERROR-SCREEN" : ""}${screen.loading ? " STUCK-LOADING" : ""}${MOBILE && screen.overflowX ? " H-OVERFLOW" : ""}${f.pageErrors.length ? ` pageErrors=${f.pageErrors.length}` : ""}${f.failed.length ? ` failedApi=${f.failed.length}` : ""}${f.console.length ? ` console=${f.console.length}` : ""}`);
}
writeFileSync(path.join(OUT, `${MOBILE ? "mobile" : "desktop"}-results.json`), JSON.stringify(results, null, 2));
console.log(`\n${results.length} modules, ${results.filter((r) => r.navError || r.errorScreen || r.pageErrors.length || r.failed.length || r.console || r.loading).length} with issues. Details: ${OUT}`);
await browser.close();
