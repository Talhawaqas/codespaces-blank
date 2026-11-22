# Phase 5 research: competitor prices and free card-payment providers (22 Nov 2026)

Sources are third-party listings unless marked; they disagree in places, so ranges are shown. Re-check vendor pages before any public comparison.

## 1. What competitors charge for back office + store/marketplace sync

| Product | Price (USD / month) | Shopify / WooCommerce sync | Source |
|---|---|---|---|
| Lightspeed Retail | Basic 89-109, Core 149-179, Plus 289-339 (1 register) | Own e-commerce bundled from Core; e-commerce add-ons reported at 10-25% of licence | Capterra, Findstack, CostBench, NerdWallet |
| Square for Retail | Free / Plus 49 / Premium 149 per location | Own online store; third-party sync via apps | NerdWallet, ERPResearch, Capterra |
| Zoho Inventory | Free plan; Standard ~39 (500 orders, 2 users, 1 warehouse) | Shopify and WooCommerce included | GetApp, Capterra |
| Odoo | Standard ~31, Custom ~61 per user (annual) | Own e-commerce + POS included; Shopify/Woo via paid third-party connectors | Capterra, GetApp, Ecosire |
| Cin7 Core | Standard 349, Pro 599, Advanced 1,199 | Counted against an integration cap (2 / 4 / 6); extra integrations cost more | Capterra, Shopify App Store listing |

What it means for Inaya:
- Cin7 is the closest match (back office + POS + Shopify/Woo) and starts at $349/month with only 2 integrations included. Including 1 Shopify + 1 WooCommerce + an own store in the Commerce add-on is a clear price advantage.
- Lightspeed and Square push their own online store; syncing an existing Shopify or WooCommerce store is not their focus.
- Zoho Inventory includes both connectors cheaply but has no full ERP + POS in the same plan; Odoo needs per-user fees and third-party connectors for Shopify/Woo.
- The approved defaults (extra store $12, 3-pack $29, Enterprise 3 stores) stay well under competitor connector pricing.

## 2. Card payments without a monthly fee

The shop connects its OWN account; Inaya never holds the money (it only creates the checkout and records the payment when the provider confirms it).

| Provider | Market | Monthly fee | Per-transaction (reported) | Notes |
|---|---|---|---|---|
| Stripe | UK | None | ~1.5% + 20p UK cards; higher for EEA/premium/international | Already used by Inaya for its own billing; does not accept Pakistan-based merchants |
| SumUp online | UK | None on base plan | 1.4% + 25p UK cards (SumUp) or 2.5% (other sources) | Payment links and online checkout |
| Safepay | Pakistan | No annual fee reported | ~2.5% + 13% SST on the fee (Safepay help article example) | SBP-regulated; Shopify app exists |
| PayFast (PK) | Pakistan | Not published | Not published | First PSO/PSP commercial licence from SBP; also Raast QR |
| XPay (PK) | Pakistan | Not published | Not published | No reliable fee data found |

Recommendation: Stripe (UK, connect-your-own-account) and Safepay (Pakistan). Both have no monthly fee, both are pay-per-sale only, and bank transfer and cash on delivery stay available. PayFast and XPay need a sales enquiry before they can be judged.

### Sources
- Lightspeed: https://www.capterra.com/p/120491/Lightspeed-Retail/pricing/ ; https://findstack.com/products/lightspeed-retail-pos/pricing ; https://www.costbench.com/software/retail-pos/lightspeed-retail/hidden-costs/ ; https://www.nerdwallet.com/reviews/small-business/lightspeed-retail-pos
- Square: https://www.nerdwallet.com/business/software/learn/square-fees ; https://erpresearch.com/erp-add-ons/pos/square-for-retail/pricing ; https://www.capterra.com/p/170272/Square-for-Retail/pricing/
- Zoho Inventory: https://www.getapp.com/operations-management-software/a/zoho-inventory/ ; https://www.capterra.com/p/146241/Zoho-Inventory/pricing/
- Odoo: https://capterra.com/p/135618/Odoo/pricing/ ; https://ecosire.com/fr/tools/erp-cost-calculator/odoo
- Cin7 Core: https://www.capterra.com/p/133038/Cin7-Core/pricing/ ; https://apps.shopify.com/dear-inventory?locale=en
- Stripe UK: https://stripe.com/resources/more/uk-card-processing-fees-101 ; https://www.wearefounders.uk/stripe-fees-uk-2026/
- SumUp: https://www.sumup.com/en-gb/compare/sumup-vs-stripe/ ; https://wise.com/gb/blog/stripe-vs-sumup
- Safepay: https://safepay.helpscoutdocs.com/article/120-how-much-does-safepay-charge ; https://apps.shopify.com/safepay-checkout
- PayFast: https://www.dawn.com/news/1962818 ; https://apps.shopify.com/payfast-gateway-app
