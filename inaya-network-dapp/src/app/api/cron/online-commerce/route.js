// GET /api/cron/online-commerce -- every 15 minutes (CRON_SECRET bearer token, like every cron). Online Commerce housekeeping:
//   expire     online orders whose card payment wasn't completed (60 min) or whose bank transfer didn't arrive (store hold time):
//              cancelled, reservations released, promotion uses given back
//   reconcile  provider payments still pending after 2 minutes are re-read from Stripe / Safepay (a webhook can be lost)
//   channels   every active Shopify / WooCommerce connection: import new/changed orders, push stock, retry failed sync jobs
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function runJob(fn) { try { return { ok: true, ...(await fn()) }; } catch (err) { console.error("cron/online-commerce job failed:", err); return { ok: false, error: err.message }; } }

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const reconcile = await runJob(async () => { const { reconcilePending } = await import("../../../../lib/online/payments.js"); return reconcilePending(); });
  const expire = await runJob(async () => { const { expireDueOrders } = await import("../../../../lib/online/orders.js"); return expireDueOrders(); });
  const channels = await runJob(async () => { const { runChannelJobs } = await import("../../../../lib/online/channels.js"); return runChannelJobs(); });
  return NextResponse.json({ success: reconcile.ok && expire.ok && channels.ok, reconcile, expire, channels });
}
