# Business Operations — Phase 3: Procurement

**Built:** August 26, 2026. Phase 3 of the "Inaya Business Operations" SOW — Suppliers, Purchase Requests, and Purchase Orders, including real receiving that moves inventory (see BUSINESS_OPERATIONS_INVENTORY.md).

## Where it lives

- **Schema + indexes:** `src/lib/orgs.js` (`suppliers`, `purchaseRequests`, `purchaseOrders`)
- **Request approval state machine:** `src/lib/purchase-request-workflow.js`
- **PO lifecycle + receiving:** `src/lib/purchase-order-workflow.js` — `transitionPurchaseOrder()`, `receivePurchaseOrder()`
- **API:** `src/app/api/orgs/procurement/suppliers/**`, `.../requests/**`, `.../orders/**` (including `.../orders/[orderId]/receive/route.js`)
- **Dashboard:** `procurementSummary` field in `src/app/api/orgs/dashboard/route.js`
- **AI tools:** `list_suppliers`, `list_purchase_orders` in `src/lib/ai-business-tools.js`
- **Web UI:** `src/components/business/ProcurementView.js` (Suppliers / Requests / Orders tabs)
- **Mobile UI:** `inaya-mobile/src/screens/business/ProcurementScreen.js` + `OrderDetailScreen.js`
- **Tests:** `test/procurement-workflow.test.mjs`

## Data model

```
suppliers
  _id, orgId, departmentId, name, contactEmail, phone, notes, status: ACTIVE|INACTIVE,
  createdByEmail, createdAt, updatedAt, deletedAt

purchase_requests
  _id, orgId, departmentId, supplierId (nullable), title, description, estimatedCost (nullable),
  status, createdByEmail, createdAt, updatedAt, deletedAt

purchase_orders
  _id, orgId, departmentId, supplierId, sourceRequestId (nullable — set when converted from an
    APPROVED request), items: [{description, sku, productId, warehouseId, quantity, unitPrice,
    receivedQuantity}], status, createdByEmail, createdAt, updatedAt, deletedAt
```

An item with both `productId` and `warehouseId` set is one that **actually moves inventory** when received — see below. An item without them is a plain line item for record-keeping (a service, or a product not tracked in the Inventory module).

## Permission model

Department-level access for everything, same as Tasks/CRM. Approval authority — `approve`/`reject` on both requests and POs — is the only `requiresManage: true` gate in this phase, the simpler of the two options the approved plan weighed (vs. a dedicated `canApprovePurchases` capability flag): zero new surface, consistent with every other approval gate already in this codebase.

## Purchase request state machine

```
DRAFT -> PENDING_APPROVAL -> APPROVED | REJECTED
DRAFT | PENDING_APPROVAL -> CANCELLED
```

## Purchase order lifecycle — the full 8-state machine from the SOW

```
DRAFT -> PENDING_APPROVAL -> APPROVED -> ORDERED -> PARTIALLY_RECEIVED -> RECEIVED
                                                   \-> REJECTED (from PENDING_APPROVAL)
DRAFT | PENDING_APPROVAL | APPROVED | ORDERED -> CANCELLED
```

`receive` is deliberately **not** a fixed-target transition in the table above — it carries a per-item quantity payload (`{itemIndex, quantity}` for one or more items in one call), and the resulting status is *derived*, not chosen by the caller: `RECEIVED` once every item's cumulative `receivedQuantity` reaches its ordered `quantity`, `PARTIALLY_RECEIVED` otherwise. A client can never force a PO into `RECEIVED` while items are still outstanding just by asserting that status name.

**Real inventory integration**: receiving an item linked to a real product+warehouse calls `inventory.js`'s `recordStockMovement()` — a real, append-only stock movement, not a note that inventory changed. This closes a gap the original phased plan explicitly flagged and accepted as a one-release-cycle trade-off (Inventory shipping in a later phase than Procurement); since both ship in this same pass, the gap never actually existed in production. The ordering is deliberate: the PO's optimistic-concurrency update wins the race *before* any stock movement is posted, so a losing concurrent `receive` call's 409 never leaves an orphaned inventory movement behind (see the header comment in `purchase-order-workflow.js` for the specific race this guards against).

## AI integration

`list_purchase_orders` answers the SOW's example question directly ("What POs are awaiting approval") by filtering on real `status` values from the caller's accessible scope — no fabricated approval-queue concept separate from the PO's own status.

## Verified, not just written

- `node --env-file=.env.local --test test/procurement-workflow.test.mjs` — 9/9 tests pass against the real database: request approval-gate enforcement, PO lifecycle including the manage-only approve gate, partial receipt → `PARTIALLY_RECEIVED` with a real stock movement posted, full receipt → `RECEIVED`, over-receiving rejected with no state change, receiving rejected from the wrong PO state, and the inventory negative-stock guard (see BUSINESS_OPERATIONS_INVENTORY.md).
- `npm run build` / `npx expo export --platform android` — both clients compile cleanly with the new routes/screens.

## Explicitly out of scope (this pass)

- No PO line-item editing after creation (cancel and recreate instead) — editing items after `DRAFT` would need to interact with `receivedQuantity`/status in ways the SOW doesn't call for yet.
- No multi-currency, tax, or shipping-cost handling on POs.
- No supplier scorecards/performance tracking.
