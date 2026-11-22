# Inaya Commerce: user and support guide

Inaya Commerce is a paid add-on for the Business and Enterprise plans. Inaya switches it on for a company from the admin License Manager (**Paid add-ons → Inaya Commerce → Switch on**, with a reason or invoice reference). Companies cannot switch it on themselves. Without it, **Point of Sale** shows an explanation and nothing else.

## 1. Who can do what

| Role | Sell | Approve discounts, refunds and voids | Cash in/out | Reports | Setup |
|---|---|---|---|---|---|
| Cashier | yes | no (asks for approval) | no | no | no |
| Supervisor | yes | up to the supervisor limit | yes | yes | no |
| Manager (owners and admins are always managers) | yes | yes | yes | yes | yes |

Set roles in **Point of Sale → Setup → Staff**. Nobody can approve their own request. Approvals are made from the approver's own login, are tied to the exact cart or return, expire after 10 minutes and can be used once.

## 2. First-time setup (manager)
1. **Inventory**: add locations (warehouses) and products. Give each product a SKU, price, barcode (optional), category and cost. Variants (sizes, colours) are separate products in the same variant group.
2. **Point of Sale → Setup**: set the currency, whether shelf prices include tax, discount limits, who may change prices, cash rounding, the return policy and window, the receipt footer, the refund role, the quarantine location, the shift cash tolerance and the time zone used for reports.
3. **Tax categories**: add a default category (for example GST 18% or VAT 20%). Rates can differ by location.
4. **Price lists and special prices** (optional): a wholesale list, or one price for one customer.
5. **Registers** (optional): add a till per counter. When a till is used, a shift must be open before it can sell.
6. **Billing profile** (Document Automation settings): legal name, address, tax number, logo and brand colour, all printed on receipts.

## 3. Selling (Register tab)
- Scan a barcode (the search box stays focused, so any USB or Bluetooth scanner that types works), search, or tap a product. Products with several variants open a picker.
- **⋯** on a line: note, price change, line discount. **Discount**: a discount on the whole sale. Anything over your limit shows *Needs approval*. Press **Pay**, then **Request approval**.
- **F4** customer, **F8** park, **F9** pay, **F2** search. Parked sales can be resumed from **Parked**.
- **Pay**: cash, bank transfer or another referenced method; split payments; change and cash rounding are calculated by the server. Payments are recorded by the shop; **no card is charged by Inaya**.
- The receipt can be printed, downloaded as a PDF, emailed (when email is configured) or saved to **Documents** (the `pos-receipts` bucket).

## 4. Returns, exchanges and voids (Sales tab → Open)
- **Return or exchange**: choose quantities and what happens to each item (back on the shelf, quarantine, damaged, not restockable), give a reason, and pick the refund method (the original payment by default). The refund and tax reversal are calculated from the original sale. You can never return more than was sold.
- **Exchange**: choose the replacement items. The return's value pays for them first; only the difference changes hands.
- **Needs approval** when outside the return window (manager), when the refunder is below the refund role, or when refunding by a different method or more than that method paid (supervisor).
- **Void**: cancels a whole sale while its shift is still open (or on the same day if no register). Cashiers need a supervisor. Once a sale has a return, it can't be voided.

## 5. Shifts and cash (Register tab bar, Shifts tab)
- **Open shift** with the opening float. **Cash in / out** (supervisors) with a reason. **Shift report** at any time.
- **Close shift**: count the drawer and enter the total. Expected = float + cash taken − change − cash refunds + cash in − cash out. Over/short is shown; beyond the tolerance it is flagged.
- Managers review closed shifts in **Shifts → Waiting for review** and can correct a count (with a reason; the history is kept). A flagged shift must be reviewed by a manager other than the one who closed it.

## 6. Sales orders (CRM → Sales orders)
Quote → accepted → confirmed (stock reserved) or backordered → picking → packed → ready for pickup → dispatched/collected → delivered. Deposits and part payments are recorded on the order. Reserved stock can't be sold at the till. Cancelling releases it. A deposit can be refunded while the invoice is unpaid; after that, refund through Accounting.

## 7. Reports (Reports tab, supervisors and managers)
Gross sales, discounts, returns, net sales, tax, total collected, payment methods, average sale, items per sale, gross margin (labelled *partial* if some items have no cost), voids, overrides, cash over/short and sales orders, broken down by day, hour, employee, register, branch, product and category. **Click any figure** to see the sales behind it.

## 8. Books and integrations
- Each sale posts Cash / Sales / Sales Tax Payable; refunds and voids post reversals; order deposits sit in Customer Deposits until the order's invoice is paid. Postings happen right after each sale and again in the nightly sync.
- Webhooks: `sale.completed`, `sale.voided`, `refund.completed`, `payment.recorded`, `price.changed`, `shift.opened`, `shift.closed` and product events (see EVENT_CONTRACT.md).

## 9. Support runbook
| Symptom | Check |
|---|---|
| "Inaya Commerce is not enabled" | Admin → License Manager → company → Paid add-ons |
| "You don't have a commerce role" | Setup → Staff (a manager assigns cashier/supervisor/manager) |
| "Open a shift on this register first" | Register bar → Open shift, or choose "No register" |
| "Not enough free stock … reserved for orders" | Stock is held by confirmed sales orders (CRM → Sales orders) |
| Stock figures look wrong | The nightly check logs differences; a manager can run `GET /api/orgs/commerce/stock-reconciliation` and repair with `POST {repair:true}` (audited) |
| "Email isn't configured" | Email receipts need the workspace email provider; download or print instead |
| A sale was submitted twice | The second submission returns the first sale (same receipt number); nothing is duplicated |

Not included in this release (approved decisions): card or terminal payments, offline selling, certified hardware, loyalty, gift cards and store credit (Phase 4), and the online store (Phase 5).

## 10. Advanced inventory (Phase 3): Inventory → Availability, Transfers, Stock counts, Reorder planning, Supplier catalogue
- **Availability**: on hand, reserved, available (what can be sold), in transit, incoming from purchase orders, backordered and available to promise (ATP = available + in transit + incoming − backordered).
- **Transfers**: request → owner/admin approves (stock is held at the source) → the sending location dispatches (stock is in transit) → the receiving location records what arrived, what was short and what was damaged (damaged goes to the quarantine location). A transfer can be cancelled before dispatch or reversed after it.
- **Stock counts**: full or by category, optionally blind; scan barcodes (a repeated scan is ignored) or type quantities; export/import the count sheet as CSV. Expected quantities allow for sales made while counting. An owner/admin who did not count approves the adjustments; each one is a COUNT movement with a reason.
- **Reorder planning**: suggestions from sales history with lead time, safety stock, minimum order and multiples, each with a "Why?" and a confidence level. Change a suggestion with a reason, create a purchase request, and see forecast accuracy and stock value by branch.
- **Purchasing**: supplier catalogue (their SKU, price history, lead time, minimum order); landed costs (freight, insurance, duty, handling) added to unit cost when received (locked after the first receipt); approval levels by order value (Inventory settings); amendments with a reason; "Receive with problems" for damaged, wrong or short goods and the packing slip; returns to suppliers with credit tracking; a supplier invoice read by the AI Bookkeeper becomes a reviewed draft purchase order, never automatically.
- **Products**: kits (selling one takes its components), serial numbers (one unique serial per unit), min/max, safety stock, lead time, preferred supplier and per-location reorder levels and bins.

## 11. Customer growth (Phase 4): Sales → Customer Growth
- **Customers**: one profile with everything the customer did (purchases, quotes and orders, invoices, payments, refunds, support, bookings, points, gift cards, emails, notes), value metrics with their definitions, a relationship summary and suggested next products.
- **Loyalty & members**: points per amount spent, tiers by 12-month spend, redemption limits, expiry, a daily earning cap; manual adjustments by a manager with a reason. Points are a ledger with a liability report (not posted to the books, by company policy). Membership plans with a member discount and points multiplier; fees are recorded by staff.
- **Gift cards & store credit**: sold at the till as a gift-card item (no tax). The code shows once on the receipt screen. Spend with the code (or the customer's store credit); refunds can go to store credit or back onto the gift card. Lost or stolen cards are blocked and the balance moved to a new card. Balances are a liability until spent; writing one off needs two managers.
- **Promotions**: % off, amount off, buy X get Y, coupon codes, dates and hours, branches, first purchase, members, segments, usage limits; another manager approves before an offer applies; offers that don't combine never stack.
- **Automation**: welcome, review request, repeat and replenishment reminders, win-back, birthday, tier change and membership-ending emails through approved sequences, only to people who agreed, never to unsubscribed people, with a weekly cap and quiet hours. Test environments never send real emails.
- **Duplicates**: likely duplicates are listed; merging (owner/admin) moves everything to the customer you keep and can be undone.
- **Assistant**: at-risk customers, unusual refund/points patterns, campaign drafts. It suggests; people decide.
