"""Writes content/docs/products/power-bi.md (customer guide + data dictionary) from powerbi/datasets.json, so the published
dictionary always matches what the Analytics API returns. Run after the datasets dump (see scripts/powerbi/starter.py)."""
import json, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DS = json.load(open(os.path.join(ROOT, "powerbi", "datasets.json"), encoding="utf-8"))
PERM = {"branches": "Any connected member", "sales_lines": "Shop supervisors/managers or finance", "sales_refunds": "Shop supervisors/managers or finance", "sales_orders": "Shop supervisors/managers or finance",
        "invoices": "Finance", "payments": "Finance", "expenses": "Finance", "products": "Any connected member", "stock_balances": "Any connected member", "stock_movements": "Any connected member",
        "purchase_order_lines": "Any connected member", "suppliers": "Any connected member", "customers": "Any connected member", "work_orders": "Manage Orders managers, dispatchers, advisors, storekeepers",
        "employees": "HR", "leave": "HR", "workforce_hours": "Managers (owner, admin, HR or store manager)"}

head = """---
slug: power-bi
title: "Microsoft Power BI: Connect, Refresh and Data Dictionary"
description: "Build your own Power BI dashboards on Inaya Business OS data: install the Inaya connector, sign in securely, load the starter reports, set up scheduled refresh, and look up every dataset, field and metric. Enterprise package, or an add-on for Business."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [business-admin, finance, operations, it-admin, analyst]
status: beta
version: current
tags: [power bi, microsoft, analytics, reports, dashboards, connector, data dictionary, metrics, refresh, gateway, enterprise, add-on]
lastVerifiedAt: "2026-11-27"
relatedDocs: [sign-in-and-package-features, business-workspace]
---

## What it is

Inaya Business OS stays where you run the business. **Microsoft Power BI** becomes an optional place to analyse it: your own dashboards on sales, refunds, invoices, payments, expenses, stock, purchasing, customers, suppliers, work and repair orders, staff hours and leave.

- **Enterprise package**, where it is included and on by default. **Business** companies can add it for $79 a month (PKR 10,000 in Pakistan) in Billing > Add-ons.
- **Read-only.** Power BI can't create, change or delete anything in Inaya.
- **Your permissions apply.** Each person sees only what their role, departments and branches allow in Inaya, and this is checked on every request.
- **No shared passwords or keys.** Each person signs in to Inaya from Power BI. Access tokens last 60 minutes, and you can disconnect anyone at any time.
- **Separate Microsoft product.** Power BI Desktop is free. Publishing and scheduled refresh in the Power BI Service need Power BI Pro (or Premium) licences, bought from Microsoft.

## Set up Power BI Desktop

1. In Inaya, open **Admin > Integrations > Microsoft Power BI**. Download **Inaya.mez** (the connector) and **Inaya-Starter-Reports.zip**.
2. Copy Inaya.mez to `Documents\\Power BI Desktop\\Custom Connectors` (create the folder if it doesn't exist).
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
| Discounts Given | Line and whole-sale discounts given. |
| Net Sales | Sales after discounts and before returns, excluding tax. |
| Returns | Refunds made in the period, excluding tax, counted on the refund date. |
| Net Sales After Returns | Net Sales minus Returns. |
| Tax Collected | Tax on point-of-sale sales. |
| Transactions | Completed sales (receipts). Voids are excluded. |
| Average Sale | Net Sales divided by Transactions. |
| Invoiced | Invoice totals. Deleted invoices are excluded. |
| Cash Received / Cash Paid Out | Payments in and out. |
| Invoiced Less Received | Invoiced minus received in the selected period. This is **not** an aged receivables balance. |
| Total Expenses | Expenses recorded. Deleted expenses are excluded. |
| Stock On Hand | Units on hand now. It isn't filtered by date. |
| Units In / Units Out | Stock added or removed by movements in the period. |
| Jobs / Jobs Completed | Work and repair orders created, and those that reached completed, closed or delivered. |
| Average Turnaround Hours | Hours from creation to first completion. |
| Hours Worked | From clock-ins, with breaks excluded, as in Inaya's timesheets. |

These are management figures. They are not audited financial statements.

## Troubleshooting

| Message | What to do |
|---|---|
| Inaya Business OS isn't listed in Get data | Check the .mez is in `Documents\\Power BI Desktop\\Custom Connectors` and the Data Extensions setting is changed, then restart Power BI Desktop. |
| "Power BI is included in the Enterprise package" or "not switched on yet" | Business companies: add Power BI in Billing > Add-ons. Otherwise ask your Inaya admin or Inaya support. |
| "Only owners and admins can connect" | An admin can allow members on the Power BI admin page. |
| A table is empty | Your role can't read that dataset, or there's no data in the date range. Check RangeStart and RangeEnd. |
| "This Power BI connection was revoked" | Sign in again: Data source settings > Inaya Business OS > Edit permissions > Sign in. |
| "Too many requests" | Refresh less often, or ask Inaya to raise the limit. |
| A refresh fails in the Power BI Service | Check the gateway is online, the .mez is in its custom connectors folder, and the connection is signed in. |

## Datasets and fields
"""
lines = [head]
for key, ds in DS.items():
    lines.append(f"\n### {ds['title']} (`{key}`)\n\nWho can read it: {PERM.get(key, 'Any connected member')}. " + (f"Dated by `{ds['window']}` (incremental).\n" if ds["window"] else "Not dated: loads in full.\n"))
    lines.append("\n| Field | Type | Meaning |\n|---|---|---|")
    for f in ds["fields"]: lines.append(f"| {f['name']} | {f['type']} | {f['description']} |")
lines.append("\n## Connector version\n\nInaya connector 1.0 (Beta), for the Inaya Analytics API v1. New fields are only ever added. A field is never removed or renamed within v1.\n")
open(os.path.join(ROOT, "content", "docs", "products", "power-bi.md"), "w", encoding="utf-8", newline="\n").write("\n".join(lines))
print("docs written")
