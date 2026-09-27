// GET /api/help/config: public. Tells the UI whether Inaya's support desk is connected and where its customer portal lives. No secrets, no ids.
import { NextResponse } from "next/server";
import { getHelpConfig } from "../../../../lib/help.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getHelpConfig(), { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (err) {
    console.error("help/config failed:", err?.message || err);
    return NextResponse.json({ enabled: false, portalPath: null });
  }
}
