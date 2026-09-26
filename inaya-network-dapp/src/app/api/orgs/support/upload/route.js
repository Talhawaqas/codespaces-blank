// POST /api/orgs/support/upload?orgId=&ticketId=&messageId=&internal=1  (multipart/form-data, field "file")
// Agent attachment upload. Bytes never touch the database: they go to encrypted storage (lib/support/attachments.js).
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../../lib/rateLimit.js";
import { agentUpload } from "../../../../../lib/support/agentApi.js";

export const dynamic = "force-dynamic";
const MAX = 4 * 1024 * 1024 + 4096;

export async function POST(req) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId"); const ticketId = url.searchParams.get("ticketId");
    if (!orgId || !ticketId) return NextResponse.json({ error: "orgId and ticketId are required." }, { status: 400 });
    if (Number(req.headers.get("content-length") || 0) > MAX) return NextResponse.json({ error: "The file is larger than 4 MB." }, { status: 413 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    try { await checkRateLimit({ action: "support:upload", key: auth.session.email, max: 60, windowMs: 15 * 60 * 1000 }); } catch { return NextResponse.json({ error: "Too many uploads. Please wait a moment." }, { status: 429 }); }
    const form = await req.formData();
    const f = form.get("file");
    if (!f || typeof f === "string" || typeof f.arrayBuffer !== "function") return NextResponse.json({ error: "A file is required." }, { status: 400 });
    if (f.size > MAX) return NextResponse.json({ error: "The file is larger than 4 MB." }, { status: 413 });
    const r = await agentUpload({ orgId, membership: auth.membership, email: auth.session.email, ticketId, messageId: url.searchParams.get("messageId") || null, internal: url.searchParams.get("internal") === "1", file: { filename: f.name, buffer: Buffer.from(await f.arrayBuffer()) } });
    if (r.error) return NextResponse.json({ error: r.error, reasonCode: r.reasonCode }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("support upload failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
