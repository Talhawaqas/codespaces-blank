// app/api/m/o/[token]/route.js -- PUBLIC open-tracking pixel for marketing email (signed token, see engagement/suppression.js).
import { trackOpen } from "../../../../../lib/engagement/sender.js";

export const dynamic = "force-dynamic";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function GET(_req, ctx) {
  try { const { token } = await ctx.params; await trackOpen(token); } catch (err) { console.error("open tracking failed:", err?.message); }
  return new Response(GIF, { status: 200, headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, private", "Content-Length": String(GIF.length) } });
}
