// Hero regression for the Why Inaya SOW (11.1). Captures the /business landing hero at desktop, tablet and phone widths:
// a screenshot of the hero column plus its exact rendered HTML and text. Run once on the baseline and again after the
// change, then compare: any difference in hero HTML or text is a release blocker.
//   node scripts/why-inaya/hero-regression.mjs <baseUrl> <outDir>
//   node scripts/why-inaya/hero-regression.mjs --compare <dirA> <dirB>
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const req = createRequire(import.meta.url);

if (process.argv[2] === "--compare") {
  const [, , , a, b] = process.argv; let bad = 0;
  for (const w of ["desktop", "tablet", "mobile"]) {
    const A = JSON.parse(readFileSync(join(a, `hero-${w}.json`), "utf8")), B = JSON.parse(readFileSync(join(b, `hero-${w}.json`), "utf8"));
    const same = A.htmlHash === B.htmlHash && A.text === B.text && A.box.width === B.box.width && A.box.height === B.box.height;
    console.log(`${w}: ${same ? "IDENTICAL" : "DIFFERENT"} (html ${A.htmlHash.slice(0, 12)} vs ${B.htmlHash.slice(0, 12)}, box ${A.box.width}x${A.box.height} vs ${B.box.width}x${B.box.height})`);
    if (!same) bad++;
  }
  process.exit(bad ? 1 : 0);
}

const [, , base, out] = process.argv; mkdirSync(out, { recursive: true });
const puppeteer = req("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
const sizes = { desktop: { width: 1440, height: 900 }, tablet: { width: 834, height: 1112 }, mobile: { width: 390, height: 844, isMobile: true, hasTouch: true } };
try {
  for (const [name, vp] of Object.entries(sizes)) {
    const page = await browser.newPage(); await page.setViewport(vp);
    await page.goto(`${base.replace(/\/$/, "")}/business`, { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForSelector("h1", { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500)); // let the fade-in animation finish
    const info = await page.evaluate(() => {
      const h1 = [...document.querySelectorAll("h1")].find((h) => /Run your whole business/.test(h.textContent));
      const hero = h1?.closest(".inaya-fade-in-up"); if (!hero) return null;
      const r = hero.getBoundingClientRect();
      return { html: hero.outerHTML, text: hero.innerText, box: { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) } };
    });
    if (!info) throw new Error(`hero not found at ${name}`);
    const el = await page.evaluateHandle(() => [...document.querySelectorAll("h1")].find((h) => /Run your whole business/.test(h.textContent)).closest(".inaya-fade-in-up"));
    await el.screenshot({ path: join(out, `hero-${name}.png`) });
    writeFileSync(join(out, `hero-${name}.json`), JSON.stringify({ url: page.url(), viewport: vp, box: info.box, text: info.text, htmlHash: createHash("sha256").update(info.html).digest("hex"), capturedAt: new Date().toISOString() }, null, 1));
    writeFileSync(join(out, `hero-${name}.html`), info.html);
    console.log(name, info.box, createHash("sha256").update(info.html).digest("hex").slice(0, 12));
    await page.close();
  }
} finally { await browser.close(); }
