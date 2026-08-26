# Business Operations — Phase 4: Inventory

**Built:** August 26, 2026. Phase 4 of the "Inaya Business Operations" SOW — Products, Warehouses, stock levels, and stock movements. The most standalone of the four modules, but its `recordStockMovement()` is also the real integration point Procurement's PO receiving calls into (see BUSINESS_OPERATIONS_PROCUREMENT.md).

## Where it lives

- **Schema + indexes:** `src/lib/orgs.js` (`warehouses`, `products`, `stockLevels`, `stockMovements`)
- **Stock ledger:** `src/lib/inventory.js` — `recordStockMovement()`, `getStockLevel()`, `listStockLevelsForProduct()`, `totalStockForProduct()`, `isLowStock()`
- **API:** `src/app/api/orgs/inventory/warehouses/route.js`, `.../products/**` (including `.../products/[productId]/stock/route.js`), `.../movements/route.js`
- **Dashboard:** `inventorySummary` field in `src/app/api/orgs/dashboard/route.js`
- **AI tool:** `list_products` (with real stock totals and `lowStockOnly`) in `src/lib/ai-business-tools.js`
- **Web UI:** `src/components/business/InventoryView.js` (Products / Movements / Warehouses tabs)
- **Mobile UI:** `inaya-mobile/src/screens/business/InventoryScreen.js` + `ProductDetailScreen.js`
- **Tests:** `test/procurement-workflow.test.mjs` (the inventory-ledger cases; there's no separate module boundary worth a second test file for logic this size, and the real integration test — receiving actually moving stock — has to live where both modules meet anyway)

## Data model — the ledger relationship

`stock_levels` is a **materialized view**, never written to directly except by `$inc`. `stock_movements` is the real, append-only audit trail — the same "ledger is truth, a balance is just a cached sum of the ledger" relationship the faucet's lifetime-cap tracking (`src/lib/faucet.js`) already established elsewhere in this codebase.

```
warehouses
  _id, orgId, departmentId, name, location, createdByEmail, createdAt

products
  _id, orgId, departmentId, sku (unique per org), name, description, unitPrice (nullable),
  reorderThreshold (default 0), status: ACTIVE|DISCONTINUED, createdByEmail, createdAt, updatedAt, deletedAt

stock_levels
  _id, orgId, productId, warehouseId, quantity   -- ONLY ever changed via $inc

stock_movements   (append-only — this collection IS the inventory activity history the SOW calls for)
  _id, orgId, productId, warehouseId, type: RECEIPT|ISSUE|ADJUSTMENT|TRANSFER_IN|TRANSFER_OUT,
  delta (signed), relatedPurchaseOrderId (nullable), note, actorEmail, createdAt
```

## Permission model

Department-level access, same as every other Business Operations module. Warehouses have no soft-delete in this pass — a warehouse with real stock levels/movements attached shouldn't just vanish; a real deactivation story is a follow-up, not blocking Phase 4's core scope.

## The negative-stock guard

`recordStockMovement()` checks a negative delta against the current level before applying it — best-effort, not perfectly race-free under concurrent issues against the same product+warehouse (the same accepted trade-off every low-contention path in this codebase makes rather than reaching for a distributed lock). A rejected issue changes nothing: no level change, no movement recorded.

## Low-stock indicator

`isLowStock(product, totalQuantity)` returns true only when `reorderThreshold > 0 AND totalQuantity <= reorderThreshold` — a product with no threshold set is never flagged, so "low stock" always means a real, deliberately-configured signal, never an artifact of an unset default.

## AI integration

`list_products` computes **real** cross-warehouse stock totals via one extra query (not a re-derivation per product), so `lowStockOnly` reflects genuinely current quantities — this was specifically fixed during implementation after an early version of the tool would have judged "low stock" against whether a reorder threshold was merely *set*, not against real inventory. See the tool's own comment in `ai-business-tools.js` for why that distinction mattered enough to rewrite.

## Verified, not just written

- `node --env-file=.env.local --test test/procurement-workflow.test.mjs` — the inventory-specific cases: a negative-stock ISSUE is rejected with the level unchanged, and a valid ADJUSTMENT correctly reduces the level and is recorded in the ledger with the right signed delta. The receiving integration tests in the same file independently confirm a linked PO item's receipt posts a real movement and updates the real level.
- `npm run build` / `npx expo export --platform android` — both clients compile cleanly with the new routes/screens.

## Explicitly out of scope (this pass)

- No barcode scanning, no multi-unit conversion (each SKU is tracked in one unit).
- No warehouse-to-warehouse transfer UI yet (the `TRANSFER_IN`/`TRANSFER_OUT` movement types exist in the schema for this, but no route wires them up — a manual two-movement workaround via the existing ISSUE/RECEIPT types covers the same real effect today).
- No automatic reorder/purchase-request generation when a product goes low-stock — the dashboard/AI surfaces the signal, a human still decides to act on it.
