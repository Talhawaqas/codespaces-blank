# Inaya Commerce — Implementation Plan (Master SOW Phases 1–2, pre-January 2027)

Approved inputs (21 Nov 2026): Lightspeed Capability Gap Audit (Phase 0) and all 18 owner-decision recommendations.
Owner scope decision: **pre-January = P0 integrity fixes + a complete POS (Master SOW §6), production quality, not labelled beta.**

## Reuse versus build (from the audit)
| Need | Reuse | Build |
|---|---|---|
| Catalogue | `products` (SKU/barcode unique, units, lots), warehouses | product type, category, variants (variant group → each variant a product with its own SKU/barcode), images, active status, cost price + moving-average cost, tax category, location availability |
| Pricing/tax | invoice tax/discount maths | tax rates/categories (inclusive/exclusive, per location), rounding, price lists, customer prices, discount rules with approval thresholds and audited overrides |
| Stock | `stock_movements` ledger, `recordStockMovement`, lots/FEFO | atomic guarded decrement + movement in one transaction, idempotency keys, oversell policy, reconciliation job and repair report (P0) |
| Sale | sales-order code paths, CRM contacts, invoices, ledger | POS sale transaction (12-step completion in one MongoDB transaction), tenders (cash, bank transfer, manual reference; split; change), park/resume, guest sale, receipts |
| Returns | ledger reversals | returns/exchanges/refunds linked to the original sale and payment, bounded, dispositions (restock/quarantine/damaged), refund receipts |
| Cash control | — | registers, shifts (float, cash in/out, count, expected vs actual, over/short, manager review) |
| Orders | sales orders | quote→order, deposits, part-paid, reservation, partial fulfilment/backorder, pick/pack, ready, dispatched, delivered/collected |
| Finance | `syncLedger` state-derived posting | posting rules for POS sales (revenue, tax payable, tenders), refunds, COGS/inventory when cost exists, cash over/short |
| Customer | CRM contacts | purchase history roll-up on the contact (Customer 360 minimum) |
| Reporting | finance reports | commerce reports §6.11 with drill-down |
| Platform | orgId tenancy, RBAC, License Manager gate, audit, webhooks | `FEATURE_COMMERCE` entitlement (server-side), commerce roles (cashier, supervisor, manager), events `sale.completed` etc. via the webhook registry |

## Storage constraint (owner decision required)
Production MongoDB is at **500 of 500 collections** (Atlas limit). Options:
- **A. Reuse existing collections (no cost):** POS sales live in `sales_orders` (`channel: "POS"`, shares the order lifecycle the SOW wants shared with Online Commerce); configuration (tax rates, price lists, registers, shifts, receipt counters) lives in an existing kind-scoped collection, following the Hospitality pattern (`calendar_records`, `kind: "c_*"`), with dedicated indexes. Works today; slightly less tidy.
- **B. Upgrade the Atlas tier** to a dedicated cluster (no 500 limit; monthly cost) and use clean `pos_sales` / `commerce_records` collections.

## Batches and acceptance gates
1. **Foundation (Phase 1 subset):** stock-ledger atomicity, oversell policy, idempotency, reconciliation; product cost + average cost; catalogue extensions; tax engine; price lists; `FEATURE_COMMERCE`; commerce roles; event contract. *Gate:* concurrent-issue tests cannot oversell; ledger and balances reconcile; tenant tests pass.
2. **POS core (Phase 2):** register UI (desktop + tablet, standard + ERP mode, barcode keyboard-wedge input), cart, pricing engine, tenders, transactional sale completion, receipts (print/PDF/email), park/resume, customer association, ledger posting, Customer 360 history. *Gate:* §6.12 sale criteria.
3. **Returns and cash control:** returns/exchanges/refunds, voids with supervisor approval, registers and shift close. *Gate:* refunds linked, bounded, auditable; shift reconciliation tests.
4. **Orders and reporting:** extended order lifecycle, commerce reports with drill-down. *Gate:* report totals reconcile to transactions.
5. **Hardening and release:** full §6.12 suite, concurrency and performance tests (large catalogue), security and tenant/branch isolation, browser SQA (desktop/tablet/phone, both layouts), documentation and support guide, production deploy behind the entitlement. *Gate:* all acceptance criteria pass; owner sign-off.

Not in this release (approved decisions): card/provider payments, offline POS, certified hardware, loyalty/gift cards/store credit (liability policy first), online storefront, golf, restaurant ordering.
