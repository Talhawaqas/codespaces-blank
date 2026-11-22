# Inaya Commerce — Event Contract (Master SOW §5.3)

Events are delivered through the existing signed webhook registry (`src/lib/webhooks/registry.js`): HMAC signatures, retries with backoff (6 attempts), auto-pause, delivery status, redelivery. **An event is a notification, never proof that downstream work completed**; consumers check delivery status and may poll.

## Envelope (every commerce event)
| Field | Meaning |
|---|---|
| `id` | event id; `<name>:<idempotencyKey>` when the operation had one, so a retried operation never emits twice per endpoint (unique `webhookId + eventId`) |
| `type` | event name (below) |
| `organizationId` | tenant |
| `createdAt` | ISO time (UTC) |
| `data.version` | contract version (`1`) |
| `data.entityId` | sale / product / order / shift id |
| `data.actor`, `data.source` | who and which surface (`pos`, `catalogue`, `pricing`, ...) |
| `data.occurredAt` | ISO time (UTC); the company's local zone is applied in reports, not in events |
| `data.correlationId` | ties all events of one business operation together |
| `data.idempotencyKey` | the caller's key, when given |

PII minimisation: payloads carry ids, SKUs, amounts and counts; never customer names, emails, phone numbers, card data or free-text notes (`sanitizePayload` also strips content-like keys).

## Events (v1)
`product.created`, `product.updated`, `price.changed`, `sale.completed`, `sale.voided`, `refund.completed`, `order.created`, `order.updated`, `payment.recorded`, `inventory.received`, `inventory.adjusted`, `inventory.transferred`, `shift.opened`, `shift.closed`. Loyalty, online-order, fulfilment and workforce events are added with their phases.

## Processing and failure
Queued per subscribed endpoint at the time of the operation (never inside the sale transaction's critical path: a failed enqueue is logged, not a failed sale). Delivery workers retry with backoff; after the last attempt the delivery is `FAILED` and visible for redelivery (dead letter). Audit evidence for the operation itself is in `org_activity` (the cryptographic audit chain), referenced by `entityId`.
