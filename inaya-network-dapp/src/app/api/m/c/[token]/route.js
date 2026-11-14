// app/api/m/c/[token]/route.js -- PUBLIC click tracking for marketing email. The destination is signed together with the send
// id, so this can never be used as an open redirect; a tampered link gets a plain error page instead of a redirect.
import { trackClick } from "../../../../../lib/engagement/sender.js";

export const dynamic = "force-dynamic";

export async function GET(req, ctx) {
  const { token } = await ctx.params;
  const url = new URL(req.url);
  try {
    const dest = await trackClick(token, url.searchParams.get("u"), url.searchParams.get("s"));
    if (dest) return new Response(null, { status: 302, headers: { Location: dest, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (err) {
    console.error("click tracking failed:", err?.message);
    const u = url.searchParams.get("u");
    // tracking store down: still take the reader where they meant to go if the link is genuinely ours
    const { verifyClick, verifyToken } = await import("../../../../../lib/engagement/suppression.js");
    const id = verifyToken("c", token);
    if (id && u && /^https:\/\//i.test(u) && verifyClick(id, u, url.searchParams.get("s"))) return new Response(null, { status: 302, headers: { Location: u } });
  }
  return new Response("This link isn't valid.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
