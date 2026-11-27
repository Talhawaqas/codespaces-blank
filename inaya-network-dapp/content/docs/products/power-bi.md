---
slug: power-bi
title: "Microsoft Power BI: Connect, Refresh and Data Dictionary"
description: "Build your own Power BI dashboards on Inaya Business OS data: install the Inaya connector, sign in securely, load the starter reports, set up scheduled refresh, and look up every dataset, field and metric. Enterprise package."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [business-admin, finance, operations, it-admin, analyst]
status: beta
version: current
tags: [power bi, microsoft, analytics, reports, dashboards, connector, data dictionary, metrics, refresh, gateway, enterprise]
lastVerifiedAt: "2026-11-27"
relatedDocs: [sign-in-and-package-features, business-workspace]
---

## What it is

Inaya Business OS stays where you run the business. **Microsoft Power BI** becomes an optional place to analyse it: your own dashboards on sales, refunds, invoices, payments, expenses, stock, purchasing, customers, suppliers, work and repair orders, staff hours and leave.

- **Enterprise package.** During the pilot, Inaya switches it on per company.
- **Read-only.** Power BI can't create, change or delete anything in Inaya.
- **Your permissions apply.** Each person sees only what their role, departments and branches allow in Inaya, and this is checked on every request.
- **No shared passwords or keys.** Each person signs in to Inaya from Power BI. Access tokens last 60 minutes, and you can disconnect anyone at any time.
- **Separate Microsoft product.** Power BI Desktop is free. Publishing and scheduled refresh in the Power BI Service need Power BI Pro (or Premium) licences, bought from Microsoft.

## Set up Power BI Desktop

1. In Inaya, open **Admin > Integrations > Microsoft Power BI**. Download **Inaya.mez** (the connector) and **Inaya-Starter-Reports.zip**.
2. Copy Inaya.mez to `Documents\Power BI Desktop\Custom Connectors` (create the folder if it doesn't exist).
3. In Power BI Desktop, open **File > Options and settings > Options > Security**. Under **Data Extensions**, choose **Allow any extension to load without validation or warning**, then restart Power BI Desktop. The connector isn't certified by Microsoft yet, so Power BI asks for this.
4. **Get data > Inaya Business OS > Connect > Sign in.** Sign in to Inaya with a passkey, company SSO or a code sent to your email. Choose the company and allow.
5. Pick the datasets to load. Or unzip the starter reports and open **Inaya Starter Reports.pbip**.

Only owners and admins can connect unless an admin ticks **Let members connect Power BI** on the same Admin page.

## The starter reports

Five pages, all using the measures defined below:

- **Executive Overview:** net sales, returns, expenses, transactions, a monthly trend and branch comparison.
- **Finance and Cash:** invoiced, received, paid out, expenses by category and an invoice list.
- **Sales and Commerce:** gross sales, discounts, average sale, categories, channels and top products.
- **Inventory:** stock on hand, units in and out, and stock by product against its reorder level.
- **Operations:** work and repair orders by status, turnaround and technician workload, plus hours worked.

Amounts are added up in each record's own currency, so use the **Currency** slicer. Inaya doesn't invent exchange rates.

The history loaded is set by the **RangeStart** and **RangeEnd** parameters (Transform data > Manage parameters).

## Scheduled refresh in the Power BI Service

1. Publish the report from Power BI Desktop. You need a Power BI Pro or Premium Per User licence.
2. Install Microsoft's **on-premises data gateway** on a Windows computer that stays on. Copy Inaya.mez into the gateway's custom connectors folder and enable custom connectors in the gateway app. Microsoft requires a gateway for connectors it hasn't certified.
3. In the Power BI Service, open **Settings > Manage connections and gateways**. Add an **Inaya Business OS** connection on that gateway and sign in to Inaya.
4. Set the refresh schedule on the semantic model.
5. Optional: for large histories, turn on **incremental refresh** on the dated tables (they're filtered by RangeStart and RangeEnd).

If a person is removed in Inaya, loses the role, or their connection is disconnected, the next refresh fails with a clear message. Someone else then has to sign in.

## Security and privacy

- **The company comes from the sign-in, never from the report.** A company only ever sees its own data. This is checked on every request.
- **Branch staff see only their branches. Members see only their departments.** Finance, HR, workforce, shop and Manage Orders datasets each need the matching role.
- **Personal data:** customer and supplier datasets include names, emails and phone numbers for people allowed to read them. Staff data is limited to name, work email, department and job title, with hours per day and leave. There are no salaries, bank or card details, passwords, keys, document contents or security records.
- **Data already in Power BI stays there.** Data that Power BI has already downloaded stays in your Power BI files and workspaces. Inaya can stop new data, but it can't erase copies.
- **Disconnecting:** Admin > Integrations > Microsoft Power BI lists every connection (who, when connected, last used). Disconnect stops it immediately.
- **Limits per connection:** 600 requests per 10 minutes, 5,000 rows per page, and at most 366 days per request (the connector splits longer ranges automatically).
- **Audit trail:** connections, disconnections and data reads (dataset and date range) are recorded in the company audit trail.

## Metric definitions

Sales measures use the same rules as Inaya's own Commerce reports, and the automated tests check that the two match.

| Measure | Definition |
|---|---|
| Gross Sales | Net sales plus discounts, excluding tax. Voided sales are excluded. |
| Discounts | Line and whole-sale discounts given. |
| Net Sales | Sales after discounts and before returns, excluding tax. |
| Returns | Refunds made in the period, excluding tax, counted on the refund date. |
| Net Sales After Returns | Net Sales minus Returns. |
| Tax Collected | Tax on point-of-sale sales. |
| Transactions | Completed sales (receipts). Voids are excluded. |
| Average Sale | Net Sales divided by Transactions. |
| Invoiced | Invoice totals. Deleted invoices are excluded. |
| Cash Received / Cash Paid Out | Payments in and out. |
| Invoiced Less Received | Invoiced minus received in the selected period. This is **not** an aged receivables balance. |
| Expenses | Expenses recorded. Deleted expenses are excluded. |
| Stock On Hand | Units on hand now. It isn't filtered by date. |
| Units In / Units Out | Stock added or removed by movements in the period. |
| Jobs / Jobs Completed | Work and repair orders created, and those that reached completed, closed or delivered. |
| Average Turnaround Hours | Hours from creation to first completion. |
| Hours Worked | From clock-ins, with breaks excluded, as in Inaya's timesheets. |

These are management figures. They are not audited financial statements.

## Troubleshooting

| Message | What to do |
|---|---|
| Inaya Business OS isn't listed in Get data | Check the .mez is in `Documents\Power BI Desktop\Custom Connectors` and the Data Extensions setting is changed, then restart Power BI Desktop. |
| "Power BI is included in the Enterprise package" or "not switched on yet" | Ask your Inaya admin or Inaya support. |
| "Only owners and admins can connect" | An admin can allow members on the Power BI admin page. |
| A table is empty | Your role can't read that dataset, or there's no data in the date range. Check RangeStart and RangeEnd. |
| "This Power BI connection was revoked" | Sign in again: Data source settings > Inaya Business OS > Edit permissions > Sign in. |
| "Too many requests" | Refresh less often, or ask Inaya to raise the limit. |
| A refresh fails in the Power BI Service | Check the gateway is online, the .mez is in its custom connectors folder, and the connection is signed in. |

## Datasets and fields


### Branches (`branches`)

Who can read it: Any connected member. Not dated: loads in full.


| Field | Type | Meaning |
|---|---|---|
| id | id | Branch ID |
| name | text | Branch name |
| city | text | City |
| createdAt | datetime | Created |

### Shop sales lines (point of sale) (`sales_lines`)

Who can read it: Shop supervisors/managers or finance. Dated by `completedAt` (incremental).


| Field | Type | Meaning |
|---|---|---|
| id | id | Sale ID and line number |
| saleId | id | Sale ID |
| saleNumber | text | Receipt number |
| completedAt | datetime | When the sale was completed |
| branchId | id | Branch |
| registerId | id | Till |
| cashierEmail | text | Cashier |
| customerId | id | Customer (if given) |
| productId | id | Product |
| sku | text | SKU |
| productName | text | Product name |
| productType | text | Product type |
| quantity | number | Units |
| grossSales | money | Gross sales: net plus discounts, excluding tax |
| discounts | money | Line and whole-sale discounts |
| netSales | money | Net sales after discounts, excluding tax |
| tax | money | Tax |
| total | money | Net sales plus tax |
| cost | money | Cost of goods at sale time (blank when unknown) |
| currency | text | Currency |
| isVoided | boolean | The sale was voided (exclude from totals) |

### Shop refunds (point of sale) (`sales_refunds`)

Who can read it: Shop supervisors/managers or finance. Dated by `refunds.createdAt` (incremental).


| Field | Type | Meaning |
|---|---|---|
| id | id | Refund number and line |
| saleId | id | Original sale |
| refundNumber | text | Refund number |
| refundedAt | datetime | When refunded |
| branchId | id | Branch |
| processedBy | text | Who processed it |
| productId | id | Product |
| sku | text | SKU |
| productName | text | Product |
| quantity | number | Units returned |
| netRefund | money | Refund excluding tax |
| tax | money | Tax refunded |
| total | money | Total refunded |
| disposition | text | Restocked, quarantined or written off |
| reason | text | Reason |
| currency | text | Currency |

### Sales orders (online and office) (`sales_orders`)

Who can read it: Shop supervisors/managers or finance. Dated by `createdAt` (incremental).


| Field | Type | Meaning |
|---|---|---|
| id | id | Order ID |
| orderNumber | text | Order number |
| channel | text | Channel (office, online store, Shopify, WooCommerce) |
| status | text | Status |
| stage | text | Stage |
| customerId | id | Customer |
| branchId | id | Branch / warehouse |
| orderDate | date | Order date |
| subtotal | money | Subtotal |
| tax | money | Tax |
| total | money | Total |
| currency | text | Currency |
| fulfilmentMethod | text | Fulfilment |
| invoiceId | id | Invoice |
| createdAt | datetime | Created |
| updatedAt | datetime | Last changed |
| isDeleted | boolean | Deleted in Inaya |

### Invoices (`invoices`)

Who can read it: Finance. Dated by `createdAt` (incremental).


| Field | Type | Meaning |
|---|---|---|
| id | id | Invoice ID |
| invoiceNumber | text | Invoice number |
| customerId | id | Customer |
| status | text | Status |
| issueDate | date | Issue date |
| dueDate | date | Due date |
| total | money | Total |
| currency | text | Currency |
| departmentId | id | Department |
| createdAt | datetime | Created |
| updatedAt | datetime | Last changed |
| isDeleted | boolean | Deleted in Inaya |

### Payments (`payments`)

Who can read it: Finance. Dated by `createdAt` (incremental).


| Field | Type | Meaning |
|---|---|---|
| id | id | Payment ID |
| paymentDate | date | Payment date |
| direction | text | IN (received) or OUT (paid) |
| amount | money | Amount |
| currency | text | Currency |
| method | text | Method |
| status | text | Status |
| invoiceId | id | Invoice paid |
| expenseId | id | Expense paid |
| purchaseOrderId | id | Purchase order paid |
| departmentId | id | Department |
| createdAt | datetime | Created |
| isDeleted | boolean | Deleted in Inaya |

### Expenses (`expenses`)

Who can read it: Finance. Dated by `createdAt` (incremental).


| Field | Type | Meaning |
|---|---|---|
| id | id | Expense ID |
| expenseDate | date | Expense date |
| vendor | text | Vendor |
| category | text | Category |
| description | text | Description |
| amount | money | Amount |
| currency | text | Currency |
| status | text | Status |
| departmentId | id | Department |
| createdAt | datetime | Created |
| updatedAt | datetime | Last changed |
| isDeleted | boolean | Deleted in Inaya |

### Products (`products`)

Who can read it: Any connected member. Not dated: loads in full.


| Field | Type | Meaning |
|---|---|---|
| id | id | Product ID |
| sku | text | SKU |
| name | text | Name |
| category | text | Category |
| productType | text | Type |
| unit | text | Unit |
| status | text | Status |
| unitPrice | money | Selling price |
| averageCost | money | Average cost |
| reorderAt | number | Reorder level |
| createdAt | datetime | Created |
| isDeleted | boolean | Deleted in Inaya |

### Stock on hand (`stock_balances`)

Who can read it: Any connected member. Not dated: loads in full.


| Field | Type | Meaning |
|---|---|---|
| id | id | Product and branch |
| productId | id | Product |
| branchId | id | Branch / warehouse |
| quantity | number | Units on hand now |

### Stock movements (`stock_movements`)

Who can read it: Any connected member. Dated by `createdAt` (incremental).


| Field | Type | Meaning |
|---|---|---|
| id | id | Movement ID |
| at | datetime | When |
| productId | id | Product |
| branchId | id | Branch / warehouse |
| type | text | Movement type (sale, receipt, transfer, count, adjustment...) |
| quantityChange | number | Units added (+) or removed (-) |
| balanceAfter | number | Units on hand after |
| unitCost | money | Unit cost |
| purchaseOrderId | id | Purchase order |
| saleId | id | Sale |

### Purchase order lines (`purchase_order_lines`)

Who can read it: Any connected member. Dated by `createdAt` (incremental).


| Field | Type | Meaning |
|---|---|---|
| id | id | Purchase order and line |
| purchaseOrderId | id | Purchase order |
| poNumber | text | PO number |
| supplierId | id | Supplier |
| branchId | id | Receiving branch |
| status | text | Status |
| productId | id | Product |
| sku | text | SKU |
| quantityOrdered | number | Ordered |
| quantityReceived | number | Received |
| unitPrice | money | Unit price |
| lineTotal | money | Ordered x price |
| currency | text | Currency |
| createdAt | datetime | Created |
| updatedAt | datetime | Last changed |
| isDeleted | boolean | Deleted in Inaya |

### Suppliers (`suppliers`)

Who can read it: Any connected member. Not dated: loads in full.


| Field | Type | Meaning |
|---|---|---|
| id | id | Supplier ID |
| name | text | Name |
| email | text | Email |
| phone | text | Phone |
| createdAt | datetime | Created |
| isDeleted | boolean | Deleted in Inaya |

### Customers (`customers`)

Who can read it: Any connected member. Not dated: loads in full.


| Field | Type | Meaning |
|---|---|---|
| id | id | Customer ID |
| name | text | Name |
| company | text | Company |
| type | text | Type (customer, lead...) |
| email | text | Email |
| phone | text | Phone |
| createdAt | datetime | Created |
| isDeleted | boolean | Deleted in Inaya |

### Work and repair orders (`work_orders`)

Who can read it: Manage Orders managers, dispatchers, advisors, storekeepers. Dated by `createdAt` (incremental).


| Field | Type | Meaning |
|---|---|---|
| id | id | Job ID |
| number | text | WO / RO number |
| type | text | WO (work order) or RO (repair order) |
| status | text | Status |
| priority | text | Priority |
| category | text | Category |
| branchId | id | Branch |
| customerId | id | Customer |
| managerEmail | text | Manager |
| assignees | text | Assigned technicians (comma separated) |
| plannedStart | datetime | Planned start |
| dueAt | datetime | Due |
| createdAt | datetime | Created |
| completedAt | datetime | Completed (first time it reached a done state) |
| turnaroundHours | number | Created to completed, hours |
| estimatedCost | money | Estimated cost |
| updatedAt | datetime | Last changed |
| isArchived | boolean | Archived |

### Employees (`employees`)

Who can read it: HR. Not dated: loads in full.


| Field | Type | Meaning |
|---|---|---|
| id | id | Employee ID |
| name | text | Name |
| email | text | Work email |
| departmentId | id | Department |
| jobTitle | text | Job title |
| createdAt | datetime | Created |

### Leave (`leave`)

Who can read it: HR. Dated by `createdAt` (incremental).


| Field | Type | Meaning |
|---|---|---|
| id | id | Leave request ID |
| employeeId | id | Employee |
| leaveType | text | Leave type |
| startDate | date | From |
| endDate | date | To |
| days | number | Calendar days |
| status | text | Status |
| createdAt | datetime | Requested |
| updatedAt | datetime | Last changed |

### Hours worked per person per day (`workforce_hours`)

Who can read it: Managers (owner, admin, HR or store manager). Dated by `at` (incremental).


| Field | Type | Meaning |
|---|---|---|
| id | id | Person and day |
| email | text | Staff member |
| date | date | Day |
| workedHours | number | Hours worked (breaks excluded) |
| breakHours | number | Break hours |
| late | boolean | Arrived late for a scheduled shift |
| lateMinutes | number | Minutes late |
| leftEarly | boolean | Left before the shift ended |

## Connector version

Inaya connector 1.0 (Beta), for the Inaya Analytics API v1. New fields are only ever added. A field is never removed or renamed within v1.
