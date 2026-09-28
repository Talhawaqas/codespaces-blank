// app/api/feedback/upload/route.js
//
// POST /api/feedback/upload — public, multipart/form-data with a `file`
// field. /api/upload (the existing route) pins JSON (pinJSONToIPFS) — it's
// built for encrypted shard strings, not raw binary, so base64-stuffing a
// screenshot into it would bloat the payload ~33% for no reason. This
// calls Pinata's actual file endpoint (pinFileToIPFS) directly instead,
// reusing the SAME PINATA_JWT credential already configured — no new env
// var, no new pinning account.
//
// SECURITY (found in the September 2026 hardening pass): this is an ANONYMOUS route that hands
// out a real, permanent, publicly-reachable IPFS URL, billed to Inaya's own Pinata account -- and
// it previously trusted the client-supplied Content-Type outright and never inspected the bytes
// at all. That combination (no auth, permanent public hosting, unvalidated content, no malware
// scan) is exactly the shape of "anonymous free file host" abuse: an attacker could upload
// anything under a spoofed image/pdf Content-Type -- malware, or content Inaya would not want its
// own storage account permanently, publicly serving. Every other upload path in this codebase
// (bookkeeper, support, portal, doc-intelligence) validates real file bytes and runs it through
// scanBuffer() before it is ever stored; this route now does the same, closing the one place that
// didn't.

import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "../../../../lib/rateLimit.js";
import { scanBuffer, scanRefusal } from "../../../../lib/support/scanner.js";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"];
// Real magic-byte signatures for every allowed type that has one (plain text has none, and is
// covered instead by scanBuffer's own "script/PHP hidden in a text file" and exec-header checks).
const MAGIC_CHECK = {
  "image/png": (b) => b.length >= 8 && b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a"),
  "image/webp": (b) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "application/pdf": (b) => b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-",
};

export async function POST(req) {
  try {
    // SQA-012: anonymous upload that is pinned to OUR storage account -- bounded per IP so it cannot be used to run up the bill
    try { await checkRateLimit({ action: "feedback:upload", key: getClientIp(req), max: 10, windowMs: 3600000 }); }
    catch (err) { return NextResponse.json({ error: err.message }, { status: 429 }); }
    let formData;
    try { formData = await req.formData(); }
    catch { return NextResponse.json({ error: "Send the file as multipart/form-data." }, { status: 400 }); }
    const file = formData.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "File is too large (max 5MB)." }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: "Unsupported file type — use an image, PDF, or plain text file." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const magicCheck = MAGIC_CHECK[file.type];
    if (magicCheck && !magicCheck(buffer)) {
      return NextResponse.json({ error: "The file's content does not match its declared type." }, { status: 415 });
    }
    const scan = await scanBuffer({ filename: file.name, buffer, mode: "static" });
    if (scan.status !== "CLEAN") {
      return NextResponse.json({ error: scanRefusal(scan) }, { status: 422 });
    }

    const pinataJWT = process.env.PINATA_JWT;
    if (!pinataJWT) {
      return NextResponse.json({ error: "System error: server missing PINATA_JWT." }, { status: 500 });
    }

    const pinataFormData = new FormData();
    pinataFormData.append("file", new Blob([buffer], { type: file.type }), file.name);

    const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${pinataJWT.trim()}` },
      body: pinataFormData,
    });

    if (!response.ok) {
      // Per project policy: never surface a raw response body from a call
      // that carried a credential. Status only.
      console.error("feedback/upload: Pinata pin failed, status", response.status);
      return NextResponse.json({ error: "Could not upload attachment. Please try again." }, { status: 502 });
    }

    const data = await response.json();
    return NextResponse.json({ url: `https://gateway.pinata.cloud/ipfs/${data.IpfsHash}` });
  } catch (err) {
    console.error("feedback/upload failed:", err);
    return NextResponse.json({ error: "Could not upload attachment." }, { status: 500 });
  }
}
