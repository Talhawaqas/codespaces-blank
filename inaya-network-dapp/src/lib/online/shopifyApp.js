// src/lib/online/shopifyApp.js -- one-click Shopify connection through INAYA'S OWN Shopify app (Dev Dashboard app, OAuth
// authorization-code grant, offline access token). Since 1 Jan 2026 merchants can't create legacy custom apps, so this is how
// real shops connect: the shop types its myshopify.com address, Shopify shows "Install Inaya?", the owner approves, Shopify
// sends them back here with a one-time code, and Inaya exchanges it for the store's access token (sealed, never shown).
//
// Configuration (Inaya's app, set once by Inaya in the environment):
//   SHOPIFY_APP_CLIENT_ID, SHOPIFY_APP_CLIENT_SECRET   from the app's page in the Shopify Dev Dashboard
//   SHOPIFY_APP_SCOPES (optional)                       defaults to the scopes the sync needs
// The app's "Allowed redirection URL" must be  <APP_URL>/api/shop/shopify/callback  and its compliance webhook URLs
// <APP_URL>/api/shop/shopify/compliance  (customers/data_request, customers/redact, shop/redact).
// Security: state is random, single-use, bound to the company and the person who started it, and expires in 10 minutes; the
// callback's HMAC is verified with the app secret; the shop address must be a myshopify.com host; the token exchange is a
// server-to-server call to that shop.
import { randomBytes, createHmac, createHash } from "node:crypto";
import { ccol, oid, sid, nowIso, fail, audit, commerceAccess } from "../commerce/store.js";
import { OK, ensureOnlineIndexes } from "./stores.js";
import { safeEqual } from "./crypto.js";

export const DEFAULT_SCOPES = "read_products,write_products,read_inventory,write_inventory,read_locations,read_orders,write_orders,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders";
const STATE_KIND = "o_oauth_state";
const sha = (x) => createHash("sha256").update(String(x)).digest("hex");
export function shopifyAppConfig() {
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID || ""; const clientSecret = process.env.SHOPIFY_APP_CLIENT_SECRET || "";
  return { enabled: !!(clientId && clientSecret), clientId, clientSecret, scopes: process.env.SHOPIFY_APP_SCOPES || DEFAULT_SCOPES };
}
export const normShop = (s) => { const h = String(s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""); const full = /\./.test(h) ? h : `${h}.myshopify.com`; return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(full) ? full : null; };

/** Shopify signs the callback query: hex HMAC-SHA256 over the other parameters, sorted, joined as k=v&k=v. */
export function verifyShopifyQuery(params, secret) {
  const entries = [...params.entries()].filter(([k]) => k !== "hmac" && k !== "signature").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const msg = entries.map(([k, v]) => `${k}=${v}`).join("&");
  return safeEqual(createHmac("sha256", secret).update(msg).digest("hex"), params.get("hmac") || "");
}

/** Step 1: checks the plan limit and that the shop isn't already connected, then returns Shopify's install/approve URL. */
export async function startShopifyInstall({ orgId, membership, actorEmail, shopDomain, baseUrl }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const cfg = shopifyAppConfig(); if (!cfg.enabled) return fail("One-click Shopify connection isn't configured yet. Use a custom app token instead.", 409, "SHOPIFY_APP_OFF");
  const shop = normShop(shopDomain); if (!shop) return fail("Enter your store's myshopify.com address (Shopify admin → Settings → Domains shows it).");
  await ensureOnlineIndexes(); const c = await ccol();
  const { checkChannelLimit } = await import("./channels.js"); const lim = await checkChannelLimit(orgId, "SHOPIFY"); if (lim) return lim;
  if (await c.findOne({ orgId: oid(orgId), kind: OK.channel, platform: "SHOPIFY", shopDomain: shop, deletedAt: null })) return fail("That Shopify store is already connected.", 409);
  const state = randomBytes(24).toString("base64url"); const now = Date.now();
  await c.insertOne({ orgId: oid(orgId), kind: STATE_KIND, stateHash: sha(state), shop, actorEmail, expiresAt: new Date(now + 10 * 60000).toISOString(), usedAt: null, createdAt: nowIso() });
  const q = new URLSearchParams({ client_id: cfg.clientId, scope: cfg.scopes, redirect_uri: `${baseUrl}/api/shop/shopify/callback`, state });
  return { url: `https://${shop}/admin/oauth/authorize?${q.toString()}`, shop };
}

/** Step 2: Shopify redirects back with code + state + hmac. Everything is verified before the token exchange. */
export async function completeShopifyInstall({ params, sessionEmail, resolveMembership, fetchImpl = fetch }) {
  const cfg = shopifyAppConfig(); if (!cfg.enabled) return fail("Shopify app not configured.", 409);
  if (!verifyShopifyQuery(params, cfg.clientSecret)) return fail("Shopify's signature didn't match. Start the connection again from Inaya.", 400, "BAD_HMAC");
  const shop = normShop(params.get("shop")); if (!shop) return fail("Invalid shop address.", 400);
  const ts = Number(params.get("timestamp")); if (!(ts > 0) || Math.abs(Date.now() / 1000 - ts) > 3600) return fail("This link has expired. Start the connection again.", 400);
  const c = await ccol();
  const st = await c.findOneAndUpdate({ kind: STATE_KIND, stateHash: sha(params.get("state") || ""), usedAt: null, expiresAt: { $gt: nowIso() } }, { $set: { usedAt: nowIso() } }, { returnDocument: "before" });
  if (!st) return fail("This connection request expired or was already used. Start again from Inaya.", 400, "BAD_STATE");
  if (st.shop !== shop) return fail("The store Shopify returned doesn't match the one you started with.", 400);
  if (String(sessionEmail || "").toLowerCase() !== String(st.actorEmail || "").toLowerCase()) return fail("Finish the connection while signed in as the person who started it.", 403);
  const membership = await resolveMembership(sid(st.orgId)); if (!membership) return fail("You're no longer a member of this company.", 403);
  const code = params.get("code"); if (!code) return fail("Shopify didn't send an authorization code.", 400);
  const r = await fetchImpl(`https://${shop}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) return fail(`Shopify didn't issue an access token (${r.status}). Try again.`, 502);
  const granted = String(j.scope || "").split(",").map((x) => x.trim()); const missing = cfg.scopes.split(",").filter((x) => !granted.includes(x) && !granted.includes(x.replace(/^read_/, "write_")));
  const { connectChannel, registerWebhooks } = await import("./channels.js");
  const res = await connectChannel({ orgId: sid(st.orgId), membership, actorEmail: st.actorEmail, input: { platform: "SHOPIFY", shopDomain: shop }, oauthGrant: { token: j.access_token, secret: cfg.clientSecret, scope: j.scope || null }, fetchImpl });
  if (res.error) return res;
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  let webhooks = null; if (baseUrl.startsWith("https://")) webhooks = await registerWebhooks({ orgId: sid(st.orgId), membership, actorEmail: st.actorEmail, id: res.channel.id, baseUrl, fetchImpl }).catch(() => null);
  await audit({ orgId: st.orgId, actorEmail: st.actorEmail, recordType: "SALES_CHANNEL", recordId: oid(res.channel.id), action: "SHOPIFY_APP_INSTALLED", metadata: { shop, scopes: j.scope || null, missingScopes: missing } });
  return { channel: res.channel, orgId: sid(st.orgId), webhooks: !!webhooks && !webhooks.error, missingScopes: missing };
}

/** Shopify's mandatory privacy webhooks for apps (and app/uninstalled). Verified with the app secret. Inaya keeps order records it
 *  needs for the company's accounting; a shop/redact (48h after uninstall) or app/uninstalled removes the connection and its token. */
export async function shopifyAppWebhook({ topic, shopDomain, rawBody, hmac }) {
  const cfg = shopifyAppConfig(); if (!cfg.enabled) return fail("Not configured.", 404);
  if (!safeEqual(createHmac("sha256", cfg.clientSecret).update(rawBody, "utf8").digest("base64"), String(hmac || "").trim())) return fail("Invalid signature.", 401);
  const shop = normShop(shopDomain); const c = await ccol(); const now = nowIso();
  const chans = shop ? await c.find({ kind: OK.channel, platform: "SHOPIFY", shopDomain: shop, deletedAt: null }).toArray() : [];
  if (["shop/redact", "app/uninstalled"].includes(topic)) {
    for (const ch of chans) {
      await c.updateOne({ _id: ch._id }, { $set: { deletedAt: now, status: "DISCONNECTED", tokenSealed: null, webhookSecretSealed: null, disconnectReason: topic } });
      await audit({ orgId: ch.orgId, actorEmail: "shopify", recordType: "SALES_CHANNEL", recordId: ch._id, action: topic === "shop/redact" ? "SHOPIFY_SHOP_REDACT" : "SHOPIFY_APP_UNINSTALLED", metadata: { shop } });
    }
  } else if (["customers/data_request", "customers/redact"].includes(topic)) {
    for (const ch of chans) await audit({ orgId: ch.orgId, actorEmail: "shopify", recordType: "SALES_CHANNEL", recordId: ch._id, action: topic === "customers/redact" ? "SHOPIFY_CUSTOMER_REDACT_REQUEST" : "SHOPIFY_CUSTOMER_DATA_REQUEST", metadata: { shop, body: rawBody.slice(0, 2000) } });
  }
  return { received: true, channels: chans.length };
}
