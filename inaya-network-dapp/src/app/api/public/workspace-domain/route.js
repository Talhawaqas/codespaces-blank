// app/api/public/workspace-domain/route.js
//
// GET ?host=files.example.com -> { workspace: true, orgName, portalTitle, accent, logo, loginBackground } when that host is a
// company's verified custom domain (Business and Enterprise), else { workspace: false }. Public: it says only what the company's
// own sign-in page shows anyway. Used by src/middleware.js to decide what to serve on an unknown host, and by the sign-in screen
// to show the company's branding.
import { NextResponse } from "next/server";
import { workspaceForHost } from "../../../../lib/branding/branding.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const host = new URL(req.url).searchParams.get("host") || "";
  try {
    const w = await workspaceForHost(host);
    return NextResponse.json(w ? { workspace: true, ...w } : { workspace: false }, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (err) {
    console.error("public/workspace-domain failed:", err?.name);
    return NextResponse.json({ workspace: false }, { status: 200 });
  }
}
