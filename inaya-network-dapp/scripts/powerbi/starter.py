"""Generates the starter Power BI project (PBIP: TMDL semantic model + report pages) from powerbi/datasets.json.

    node (dump datasets) -> python scripts/powerbi/starter.py -> python scripts/powerbi/build.py

Measures follow the published metric definitions (docs: /docs/products/power-bi, "Metric definitions"): the same rules as
Inaya's own Commerce and finance reports. Amounts are summed in each record's own currency, so every page has a Currency
slicer; no exchange rates are applied.
"""
import json, os, shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DS = json.load(open(os.path.join(ROOT, "powerbi", "datasets.json"), encoding="utf-8"))
OUT = os.path.join(ROOT, "powerbi", "starter")
NAME = "Inaya Starter Reports"
SM = os.path.join(OUT, f"{NAME}.SemanticModel"); RP = os.path.join(OUT, f"{NAME}.Report")
shutil.rmtree(OUT, ignore_errors=True); os.makedirs(os.path.join(SM, "definition", "tables")); os.makedirs(RP)

TYPES = {"id": "string", "text": "string", "money": "double", "number": "double", "integer": "int64", "boolean": "boolean", "datetime": "dateTime", "date": "dateTime"}
TABLE_NAMES = {"branches": "Branches", "sales_lines": "Sales Lines", "sales_refunds": "Sales Refunds", "sales_orders": "Sales Orders", "invoices": "Invoices", "payments": "Payments",
    "expenses": "Expenses", "products": "Products", "stock_balances": "Stock Balances", "stock_movements": "Stock Movements", "purchase_order_lines": "Purchase Order Lines",
    "suppliers": "Suppliers", "customers": "Customers", "work_orders": "Work Orders", "employees": "Employees", "leave": "Leave", "workforce_hours": "Workforce Hours"}
# date-only helper columns used for the Date relationships (DAX calculated columns)
DAY_COLUMNS = {"Sales Lines": ("Sale Date", "completedAt"), "Sales Refunds": ("Refund Date", "refundedAt"), "Sales Orders": ("Order Day", "orderDate"), "Invoices": ("Issue Day", "issueDate"),
    "Payments": ("Payment Day", "paymentDate"), "Expenses": ("Expense Day", "expenseDate"), "Stock Movements": ("Movement Day", "at"), "Purchase Order Lines": ("Order Day", "createdAt"),
    "Work Orders": ("Created Day", "createdAt"), "Workforce Hours": ("Work Day", "date")}
MEASURES = {
    "Sales Lines": [
        ("Gross Sales", "CALCULATE(SUM('Sales Lines'[grossSales]), 'Sales Lines'[isVoided] = FALSE())", "#,0.00", "Net sales plus discounts, excluding tax. Voided sales excluded."),
        ("Discounts", "CALCULATE(SUM('Sales Lines'[discounts]), 'Sales Lines'[isVoided] = FALSE())", "#,0.00", "Line and whole-sale discounts given."),
        ("Net Sales", "CALCULATE(SUM('Sales Lines'[netSales]), 'Sales Lines'[isVoided] = FALSE())", "#,0.00", "Sales after discounts, before returns, excluding tax."),
        ("Tax Collected", "CALCULATE(SUM('Sales Lines'[tax]), 'Sales Lines'[isVoided] = FALSE())", "#,0.00", "Tax on point-of-sale sales."),
        ("Transactions", "CALCULATE(DISTINCTCOUNT('Sales Lines'[saleId]), 'Sales Lines'[isVoided] = FALSE())", "#,0", "Completed sales (receipts), voids excluded."),
        ("Units Sold", "CALCULATE(SUM('Sales Lines'[quantity]), 'Sales Lines'[isVoided] = FALSE())", "#,0", "Units sold."),
        ("Average Sale", "DIVIDE([Net Sales], [Transactions])", "#,0.00", "Net sales per transaction."),
        ("Net Sales After Returns", "[Net Sales] - [Returns]", "#,0.00", "Net sales less refunds made in the same period, excluding tax (as Inaya's Commerce report)."),
    ],
    "Sales Refunds": [("Returns", "SUM('Sales Refunds'[netRefund])", "#,0.00", "Refunds made in the period, excluding tax, by refund date.")],
    "Sales Orders": [("Order Value", "CALCULATE(SUM('Sales Orders'[total]), 'Sales Orders'[isDeleted] = FALSE())", "#,0.00", "Online and office order totals (deleted excluded).")],
    "Invoices": [("Invoiced", "CALCULATE(SUM(Invoices[total]), Invoices[isDeleted] = FALSE())", "#,0.00", "Invoice totals issued (deleted invoices excluded).")],
    "Payments": [
        ("Cash Received", "CALCULATE(SUM(Payments[amount]), Payments[direction] = \"IN\", Payments[isDeleted] = FALSE())", "#,0.00", "Payments received."),
        ("Cash Paid Out", "CALCULATE(SUM(Payments[amount]), Payments[direction] = \"OUT\", Payments[isDeleted] = FALSE())", "#,0.00", "Payments made."),
        ("Invoiced Less Received", "[Invoiced] - [Cash Received]", "#,0.00", "Invoiced minus received in the selected period. Not an aged receivables balance."),
    ],
    "Expenses": [("Expenses", "CALCULATE(SUM(Expenses[amount]), Expenses[isDeleted] = FALSE())", "#,0.00", "Expenses recorded (deleted excluded).")],
    "Stock Balances": [("Stock On Hand", "SUM('Stock Balances'[quantity])", "#,0", "Units on hand now (not filtered by date).")],
    "Stock Movements": [("Units In", "CALCULATE(SUM('Stock Movements'[quantityChange]), 'Stock Movements'[quantityChange] > 0)", "#,0", "Units added."),
                        ("Units Out", "-CALCULATE(SUM('Stock Movements'[quantityChange]), 'Stock Movements'[quantityChange] < 0)", "#,0", "Units removed.")],
    "Work Orders": [
        ("Jobs", "CALCULATE(COUNTROWS('Work Orders'), 'Work Orders'[isArchived] = FALSE())", "#,0", "Work and repair orders created."),
        ("Jobs Completed", "CALCULATE(COUNTROWS('Work Orders'), NOT ISBLANK('Work Orders'[completedAt]))", "#,0", "Jobs that reached completed, closed or delivered."),
        ("Average Turnaround Hours", "AVERAGE('Work Orders'[turnaroundHours])", "#,0.0", "Created to completed, hours."),
    ],
    "Workforce Hours": [("Hours Worked", "SUM('Workforce Hours'[workedHours])", "#,0.0", "Hours worked, breaks excluded."), ("Late Days", "CALCULATE(COUNTROWS('Workforce Hours'), 'Workforce Hours'[late] = TRUE())", "#,0", "Days someone arrived late for a scheduled shift.")],
}
RELATIONSHIPS = [("Sales Lines", "productId", "Products", "id"), ("Sales Lines", "branchId", "Branches", "id"), ("Sales Refunds", "productId", "Products", "id"),
    ("Sales Refunds", "branchId", "Branches", "id"), ("Stock Balances", "productId", "Products", "id"), ("Stock Balances", "branchId", "Branches", "id"),
    ("Stock Movements", "productId", "Products", "id"), ("Stock Movements", "branchId", "Branches", "id"), ("Work Orders", "branchId", "Branches", "id"),
    ("Invoices", "customerId", "Customers", "id"), ("Sales Orders", "customerId", "Customers", "id"), ("Purchase Order Lines", "supplierId", "Suppliers", "id"),
    ("Purchase Order Lines", "productId", "Products", "id"), ("Leave", "employeeId", "Employees", "id")]

q = lambda n: f"'{n}'" if (" " in n or not n.isidentifier()) else n
def w(path, text): open(path, "w", encoding="utf-8", newline="\n").write(text)

def table_tmdl(key, ds):
    t = TABLE_NAMES[key]; L = [f"table {q(t)}", ""]
    for (name, expr, fmt, desc) in MEASURES.get(t, []):
        L += [f"\t/// {desc}", f"\tmeasure {q(name)} = {expr}", f"\t\tformatString: {fmt}", ""]
    for f in ds["fields"]:
        L += [f"\t/// {f['description']}", f"\tcolumn {q(f['name'])}", f"\t\tdataType: {TYPES[f['type']]}"]
        if f["type"] in ("money", "number"): L += ["\t\tformatString: #,0.00", "\t\tsummarizeBy: sum"]
        elif f["type"] == "integer": L += ["\t\tsummarizeBy: sum"]
        else: L += ["\t\tsummarizeBy: none"]
        if f["type"] == "date": L += ["\t\tformatString: yyyy-mm-dd"]
        L += [f"\t\tsourceColumn: {f['name']}", ""]
    if t in DAY_COLUMNS:
        col, src = DAY_COLUMNS[t]
        L += [f"\tcolumn {q(col)} = IF(ISBLANK({q(t)}[{src}]), BLANK(), DATE(YEAR({q(t)}[{src}]), MONTH({q(t)}[{src}]), DAY({q(t)}[{src}])))", "\t\tdataType: dateTime", "\t\tformatString: yyyy-mm-dd", "\t\tsummarizeBy: none", ""]
    rng = "RangeStart, RangeEnd" if ds["window"] else "RangeStart, RangeEnd"
    L += [f"\tpartition {q(t)} = m", "\t\tmode: import", "\t\tsource =", "\t\t\t\tlet", f"\t\t\t\t    Source = Inaya.Dataset(\"{key}\", {rng})", "\t\t\t\tin", "\t\t\t\t    Source", ""]
    return "\n".join(L)

date_tmdl = "\n".join(["table Date", "\tdataCategory: Time", "",
    "\tcolumn Date", "\t\tdataType: dateTime", "\t\tformatString: yyyy-mm-dd", "\t\tisKey", "\t\tsummarizeBy: none", "\t\tisNameInferred", "\t\tsourceColumn: [Date]", "",
    "\tcolumn Year = YEAR('Date'[Date])", "\t\tdataType: int64", "\t\tsummarizeBy: none", "",
    "\tcolumn Month = FORMAT('Date'[Date], \"yyyy-mm\")", "\t\tdataType: string", "\t\tsummarizeBy: none", "",
    "\tcolumn Weekday = FORMAT('Date'[Date], \"ddd\")", "\t\tdataType: string", "\t\tsummarizeBy: none", "",
    "\tpartition Date = calculated", "\t\tmode: import", "\t\tsource = CALENDARAUTO()", ""])

d = os.path.join(SM, "definition")
w(os.path.join(SM, "definition.pbism"), json.dumps({"version": "4.0", "settings": {}}, indent=2))
w(os.path.join(d, "database.tmdl"), "database\n\tcompatibilityLevel: 1600\n")
tables = [TABLE_NAMES[k] for k in DS] + ["Date"]
w(os.path.join(d, "model.tmdl"), "model Model\n\tculture: en-US\n\tdefaultPowerBIDataSourceVersion: powerBI_V3\n\tsourceQueryCulture: en-US\n\tdataAccessOptions\n\t\tlegacyRedirects\n\t\treturnErrorValuesAsNull\n\n" + "\n".join(f"ref table {q(t)}" for t in tables) + "\n")
w(os.path.join(d, "expressions.tmdl"), "\n".join([
    "/// Start of the data loaded (and of each incremental-refresh partition). Change it in Transform data > Manage parameters.",
    "expression RangeStart = #datetime(2025, 1, 1, 0, 0, 0) meta [IsParameterQuery=true, Type=\"DateTime\", IsParameterQueryRequired=true]", "",
    "/// End of the data loaded.",
    "expression RangeEnd = DateTime.From(Date.AddDays(DateTime.Date(DateTime.LocalNow()), 1)) meta [IsParameterQuery=true, Type=\"DateTime\", IsParameterQueryRequired=true]", ""]))
for key, ds in DS.items(): w(os.path.join(d, "tables", f"{TABLE_NAMES[key]}.tmdl"), table_tmdl(key, ds))
w(os.path.join(d, "tables", "Date.tmdl"), date_tmdl)
rel = []
for i, (ft, fc, tt, tc) in enumerate(RELATIONSHIPS): rel += [f"relationship r{i + 1}", f"\tfromColumn: {q(ft)}.{q(fc)}", f"\ttoColumn: {q(tt)}.{q(tc)}", ""]
for i, (t, (col, _)) in enumerate(DAY_COLUMNS.items()): rel += [f"relationship d{i + 1}", f"\tfromColumn: {q(t)}.{q(col)}", "\ttoColumn: Date.Date", ""]
w(os.path.join(d, "relationships.tmdl"), "\n".join(rel))

# ------------------------------------------------------------------------------------------- report (PBIR-Legacy report.json)
def sel(entity, prop, kind):
    alias = "t"; key = "Measure" if kind == "m" else "Column"
    return {key: {"Expression": {"SourceRef": {"Source": alias}}, "Property": prop}, "Name": f"{entity}.{prop}"}
def visual(vid, vtype, x, y, wd, h, roles, title):
    froms, selects, proj, aliases = [], [], {}, {}
    for role, items in roles.items():
        proj[role] = []
        for (entity, prop, kind) in items:
            if entity not in aliases: aliases[entity] = f"t{len(aliases)}"; froms.append({"Name": aliases[entity], "Entity": entity, "Type": 0})
            s = sel(entity, prop, kind); s[list(s)[0]]["Expression"]["SourceRef"]["Source"] = aliases[entity]
            if s not in selects: selects.append(s)
            proj[role].append({"queryRef": f"{entity}.{prop}", **({"active": True} if role == "Category" else {})})
    cfg = {"name": vid, "layouts": [{"id": 0, "position": {"x": x, "y": y, "z": 0, "width": wd, "height": h}}],
           "singleVisual": {"visualType": vtype, "projections": proj, "prototypeQuery": {"Version": 2, "From": froms, "Select": selects},
                            "vcObjects": {"title": [{"properties": {"show": {"expr": {"Literal": {"Value": "true"}}}, "text": {"expr": {"Literal": {"Value": f"'{title}'"}}}}}]}}}
    return {"x": x, "y": y, "z": 0, "width": wd, "height": h, "config": json.dumps(cfg), "filters": "[]"}
def card(vid, x, y, entity, measure): return visual(vid, "card", x, y, 230, 110, {"Values": [(entity, measure, "m")]}, measure)
def slicer(vid, x, y, entity, col, title): return visual(vid, "slicer", x, y, 230, 110, {"Values": [(entity, col, "c")]}, title)
M, C = "m", "c"
PAGES = [
    ("Executive Overview", [card("e1", 20, 20, "Sales Lines", "Net Sales"), card("e2", 260, 20, "Sales Refunds", "Returns"), card("e3", 500, 20, "Expenses", "Expenses"), card("e4", 740, 20, "Sales Lines", "Transactions"),
        slicer("e5", 1000, 20, "Sales Lines", "currency", "Currency"),
        visual("e6", "lineChart", 20, 150, 760, 300, {"Category": [("Date", "Month", C)], "Y": [("Sales Lines", "Net Sales", M), ("Expenses", "Expenses", M)]}, "Net sales and expenses by month"),
        visual("e7", "clusteredBarChart", 800, 150, 460, 300, {"Category": [("Branches", "name", C)], "Y": [("Sales Lines", "Net Sales", M)]}, "Net sales by branch"),
        visual("e8", "tableEx", 20, 470, 1240, 230, {"Values": [("Date", "Month", C), ("Sales Lines", "Gross Sales", M), ("Sales Lines", "Discounts", M), ("Sales Lines", "Net Sales", M), ("Sales Refunds", "Returns", M), ("Sales Lines", "Net Sales After Returns", M), ("Sales Lines", "Tax Collected", M)]}, "Period summary")]),
    ("Finance and Cash", [card("f1", 20, 20, "Invoices", "Invoiced"), card("f2", 260, 20, "Payments", "Cash Received"), card("f3", 500, 20, "Payments", "Cash Paid Out"), card("f4", 740, 20, "Payments", "Invoiced Less Received"),
        slicer("f5", 1000, 20, "Invoices", "currency", "Currency"),
        visual("f6", "clusteredColumnChart", 20, 150, 760, 300, {"Category": [("Date", "Month", C)], "Y": [("Invoices", "Invoiced", M), ("Payments", "Cash Received", M)]}, "Invoiced vs received by month"),
        visual("f7", "clusteredBarChart", 800, 150, 460, 300, {"Category": [("Expenses", "category", C)], "Y": [("Expenses", "Expenses", M)]}, "Expenses by category"),
        visual("f8", "tableEx", 20, 470, 1240, 230, {"Values": [("Invoices", "invoiceNumber", C), ("Customers", "name", C), ("Invoices", "status", C), ("Invoices", "issueDate", C), ("Invoices", "dueDate", C), ("Invoices", "Invoiced", M)]}, "Invoices")]),
    ("Sales and Commerce", [card("s1", 20, 20, "Sales Lines", "Gross Sales"), card("s2", 260, 20, "Sales Lines", "Discounts"), card("s3", 500, 20, "Sales Lines", "Average Sale"), card("s4", 740, 20, "Sales Lines", "Units Sold"),
        slicer("s5", 1000, 20, "Branches", "name", "Branch"),
        visual("s6", "clusteredBarChart", 20, 150, 620, 300, {"Category": [("Products", "category", C)], "Y": [("Sales Lines", "Net Sales", M)]}, "Net sales by category"),
        visual("s7", "clusteredColumnChart", 660, 150, 600, 300, {"Category": [("Sales Orders", "channel", C)], "Y": [("Sales Orders", "Order Value", M)]}, "Orders by channel"),
        visual("s8", "tableEx", 20, 470, 1240, 230, {"Values": [("Products", "name", C), ("Products", "sku", C), ("Sales Lines", "Units Sold", M), ("Sales Lines", "Net Sales", M), ("Sales Refunds", "Returns", M)]}, "Top products")]),
    ("Inventory", [card("i1", 20, 20, "Stock Balances", "Stock On Hand"), card("i2", 260, 20, "Stock Movements", "Units In"), card("i3", 500, 20, "Stock Movements", "Units Out"),
        slicer("i4", 1000, 20, "Branches", "name", "Branch"),
        visual("i5", "clusteredBarChart", 20, 150, 620, 300, {"Category": [("Branches", "name", C)], "Y": [("Stock Balances", "Stock On Hand", M)]}, "Stock on hand by branch"),
        visual("i6", "lineChart", 660, 150, 600, 300, {"Category": [("Date", "Month", C)], "Y": [("Stock Movements", "Units In", M), ("Stock Movements", "Units Out", M)]}, "Stock movement by month"),
        visual("i7", "tableEx", 20, 470, 1240, 230, {"Values": [("Products", "name", C), ("Products", "sku", C), ("Products", "reorderAt", C), ("Stock Balances", "Stock On Hand", M)]}, "Stock by product (compare with reorder level)")]),
    ("Operations", [card("o1", 20, 20, "Work Orders", "Jobs"), card("o2", 260, 20, "Work Orders", "Jobs Completed"), card("o3", 500, 20, "Work Orders", "Average Turnaround Hours"), card("o4", 740, 20, "Workforce Hours", "Hours Worked"),
        slicer("o5", 1000, 20, "Branches", "name", "Branch"),
        visual("o6", "clusteredColumnChart", 20, 150, 620, 300, {"Category": [("Work Orders", "status", C)], "Y": [("Work Orders", "Jobs", M)]}, "Jobs by status"),
        visual("o7", "lineChart", 660, 150, 600, 300, {"Category": [("Date", "Month", C)], "Y": [("Work Orders", "Average Turnaround Hours", M)]}, "Turnaround trend (hours)"),
        visual("o8", "tableEx", 20, 470, 1240, 230, {"Values": [("Work Orders", "assignees", C), ("Work Orders", "Jobs", M), ("Work Orders", "Jobs Completed", M), ("Work Orders", "Average Turnaround Hours", M)]}, "Technician workload")]),
]
report = {"config": json.dumps({"version": "5.43", "themeCollection": {"baseTheme": {"name": "CY24SU10", "version": "5.61", "type": 2}}}), "layoutOptimization": 0,
          "sections": [{"name": f"Section{i}", "displayName": n, "displayOption": 1, "width": 1280, "height": 720, "filters": "[]", "config": "{}", "visualContainers": v, "ordinal": i} for i, (n, v) in enumerate(PAGES)],
          "filters": "[]"}
w(os.path.join(RP, "report.json"), json.dumps(report, indent=1))
w(os.path.join(RP, "definition.pbir"), json.dumps({"version": "4.0", "datasetReference": {"byPath": {"path": f"../{NAME}.SemanticModel"}}}, indent=2))
w(os.path.join(OUT, f"{NAME}.pbip"), json.dumps({"version": "1.0", "artifacts": [{"report": {"path": f"{NAME}.Report"}}], "settings": {"enableAutoRecovery": True}}, indent=2))
w(os.path.join(OUT, "README.txt"), "Inaya Starter Reports for Microsoft Power BI\n\n1. Install the Inaya connector first (Inaya.mez, see Admin > Integrations > Power BI in Inaya).\n2. Open 'Inaya Starter Reports.pbip' in Power BI Desktop.\n3. Refresh, and sign in to Inaya when asked. Pick your company and allow.\n4. Change RangeStart / RangeEnd in Transform data > Manage parameters to load more or less history.\n\nAmounts are in each record's own currency: use the Currency slicer. Datasets your Inaya role cannot read load empty.\nFull guide: https://www.inayanetwork.com/docs/products/power-bi\n")
print("starter project written:", len(DS) + 1, "tables,", sum(len(v) for v in MEASURES.values()), "measures,", len(RELATIONSHIPS) + len(DAY_COLUMNS), "relationships,", len(PAGES), "pages")
