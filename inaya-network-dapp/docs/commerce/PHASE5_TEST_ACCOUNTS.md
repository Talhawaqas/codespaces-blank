# Phase 5: test accounts needed for live verification

We go through these one by one together. Each is free and in TEST / SANDBOX mode only: no real money, no real customers. You create the account and type any password yourself. Claude never enters passwords or card details. Keys are pasted into Inaya's own settings screen (they are stored encrypted), not into chat.

| # | Account | Why we need it | What you'll do | Time |
|---|---|---|---|---|
| 1 | **Shopify Partners + development store** | Proves Shopify sync works for real: products, prices, stock and orders both ways | Sign up at partners.shopify.com → Stores → Add store → Development store. In the store: Settings → Apps → Develop apps → create an app with product, inventory, order and fulfilment access → install → copy the Admin API access token | ~15 min |
| 2 | **WooCommerce test site** | Proves WooCommerce sync works for real | Either (a) a free test WordPress + WooCommerce site you already have, or (b) you allow Claude to run one locally (Docker or a local PHP install; Docker Desktop had a bug before, so we may need the second route). Then WooCommerce → Settings → Advanced → REST API → create a key with read/write access | ~15-30 min |
| 3 | **Stripe test mode** (UK) | Proves card checkout and payment confirmation (webhook) for UK shops | In the Stripe dashboard, switch on *Test mode* → Developers → API keys → copy the test secret key (starts `sk_test_`) → Developers → Webhooks → add the endpoint Inaya shows you → copy the signing secret (`whsec_`). Test cards only (4242 4242 4242 4242) | ~10 min |
| 4 | **Safepay sandbox** (Pakistan) | Proves card checkout and confirmation for Pakistan shops | Sign up at getsafepay.com for a sandbox account → Developers → API keys (public key + secret key) → Endpoints → add the webhook endpoint Inaya shows you → copy its shared secret | ~10-20 min (Safepay may need to approve the account) |
| 5 | **Store subdomain DNS** (optional, later) | `yourshop.<shop domain>` addresses; until then stores work at inayanetwork.com/shop/yourshop | Decide the shop domain (e.g. shop.inayanetwork.com) and add a wildcard DNS record + the domain in Vercel. We'll do this together | ~10 min |

Until each row is done and checked end-to-end, that capability is NOT claimed anywhere customer-facing (owner rule: claim only what is built and verified live).
