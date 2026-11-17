// scripts/patch-next-head-content-length.mjs — runs on every `npm install` (postinstall), including Vercel builds.
//
// Why: Next.js 15.5.28+ (the release that fixes the critical image-optimizer RCE, GHSA-2464-fhr4-w9xw) strips
// `content-length` from every route-handler response, because a transparently decoded body could no longer match
// it. A HEAD response has no body at all, so stripping it removes the object size that S3 / Azure Blob clients
// rely on: rclone, AzCopy and DirectSync then read the size as 0, call every upload "corrupted on transfer" and
// delete it (found by the Business Workspace SQA, 17 Nov 2026).
//
// The patch: after Next copies the response headers, a response gets its own content-length back when it sends no
// body (HEAD, or a null body) or carries no content-encoding. A transparently decoded body always comes with a
// content-encoding header, so the upstream protection is unchanged for exactly the responses it was written for. Applied to all three copies of Next's sendResponse: the CommonJS
// build, the ESM build, and the minified production runtime used on Vercel.
//
// Idempotent. If a future Next.js changes this code, the script fails loudly instead of silently doing nothing.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let root;
try { root = path.join(path.dirname(require.resolve("next/package.json")), "dist"); }
catch { console.log("patch-next-head: next is not installed here, skipping"); process.exit(0); }

const MARK = "inaya-head-content-length-v2";
const readable = `const { originalResponse } = res;`;
const readableFix = `const { originalResponse } = res; /* ${MARK} */ if (!response.body || req.method === 'HEAD' || !(response.headers && response.headers.get('content-encoding'))) { const cl = response.headers && response.headers.get('content-length'); if (cl && typeof originalResponse.getHeader('content-length') === 'undefined') originalResponse.setHeader('content-length', cl); }`;
const minified = `let{originalResponse:s}=t;r.body&&"HEAD"!==e.method?await t3(r.body,s,n):s.end()`;
const minifiedFix = `let{originalResponse:s}=t;/* ${MARK} */if(!r.body||"HEAD"===e.method||!(r.headers&&r.headers.get("content-encoding"))){let cl=r.headers&&r.headers.get("content-length");cl&&void 0===s.getHeader("content-length")&&s.setHeader("content-length",cl)}r.body&&"HEAD"!==e.method?await t3(r.body,s,n):s.end()`;

// Earlier insertions of this patch (v1), removed before the current one is applied so they never stack.
const PREVIOUS = [
  ` /* inaya-head-content-length */ if (!response.body || req.method === 'HEAD') { const cl = response.headers && response.headers.get('content-length'); if (cl && typeof originalResponse.getHeader('content-length') === 'undefined') originalResponse.setHeader('content-length', cl); }`,
  `/* inaya-head-content-length */if(!r.body||"HEAD"===e.method){let cl=r.headers&&r.headers.get("content-length");cl&&void 0===s.getHeader("content-length")&&s.setHeader("content-length",cl)}`,
];

const targets = [
  ["server/send-response.js", readable, readableFix],
  ["esm/server/send-response.js", readable, readableFix],
  ["compiled/next-server/server.runtime.prod.js", minified, minifiedFix],
];
let failed = false;
for (const [rel, from, to] of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { console.log(`patch-next-head: ${rel} not present, skipping`); continue; }
  let src = fs.readFileSync(file, "utf8");
  for (const p of PREVIOUS) if (src.includes(p)) { src = src.split(p).join(""); fs.writeFileSync(file, src); console.log(`patch-next-head: removed the earlier patch from ${rel}`); }
  if (src.includes(MARK)) { console.log(`patch-next-head: ${rel} already patched`); continue; }
  if (!src.includes("content-length") || !/FORBIDDEN_HEADERS|"content-length","content-encoding","transfer-encoding"/.test(src)) { console.log(`patch-next-head: ${rel} does not strip content-length, nothing to do`); continue; }
  const n = src.split(from).length - 1;
  if (n !== 1) { console.error(`patch-next-head: ${rel} changed shape (${n} anchors); review this script, S3 HEAD sizes will be missing`); failed = true; continue; }
  fs.writeFileSync(file, src.replace(from, to));
  console.log(`patch-next-head: patched ${rel}`);
}
process.exit(failed ? 1 : 0);
