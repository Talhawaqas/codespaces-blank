// app/api/feedback/upload/route.js
//
// POST /api/feedback/upload — public, multipart/form-data with a `file`
// field. /api/upload (the existing route) pins JSON (pinJSONToIPFS) — it's
// built for encrypted shard strings, not raw binary, so base64-stuffing a
// screenshot into it would bloat the payload ~33% for no reason. This
// calls Pinata's actual file endpoint (pinFileToIPFS) directly instead,
// reusing the SAME PINATA_JWT credential already configured — no new env
// var, no new pinning account.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"];

export async function POST(req) {
  try {
    const formData = await req.formData();
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

    const pinataJWT = process.env.PINATA_JWT;
    if (!pinataJWT) {
      return NextResponse.json({ error: "System error: server missing PINATA_JWT." }, { status: 500 });
    }

    const pinataFormData = new FormData();
    pinataFormData.append("file", file, file.name);

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
