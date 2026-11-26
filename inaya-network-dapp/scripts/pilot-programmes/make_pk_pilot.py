import os
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

OUT = r"D:\Codespace-blank\codespaces-blank-main\codespaces-blank-main\inaya-network-dapp\public\documents\inaya-erp-pilot-programme-pakistan.pdf"
TEAL = colors.HexColor("#0B6E75"); INK = colors.HexColor("#1D2433"); MUTED = colors.HexColor("#5B6475"); LINE = colors.HexColor("#E3E6EB"); SOFT = colors.HexColor("#EEF6F6")
H1 = ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=21, leading=26, textColor=INK, spaceAfter=4)
SUB = ParagraphStyle("sub", fontName="Helvetica", fontSize=10, leading=14, textColor=MUTED, spaceAfter=12)
H2 = ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=TEAL, spaceBefore=12, spaceAfter=6)
P = ParagraphStyle("p", fontName="Helvetica", fontSize=10, leading=14.5, textColor=INK, spaceAfter=6)
B = ParagraphStyle("b", parent=P, leftIndent=12, bulletIndent=2, spaceAfter=3)
CELL = ParagraphStyle("c", fontName="Helvetica", fontSize=9, leading=12, textColor=INK)
CELLB = ParagraphStyle("cb", parent=CELL, fontName="Helvetica-Bold")
NOTE = ParagraphStyle("n", parent=P, backColor=SOFT, borderPadding=(6, 8, 6, 8), spaceBefore=6, spaceAfter=10)
W = A4[0] - 36 * mm
TITLE = "Inaya Business OS: 6-Month Pilot Programme for Pakistani Companies"

def bl(items): return [Paragraph(i, B, bulletText="•") for i in items]
def table(rows, widths):
    data = [[Paragraph(str(c), CELLB if r == 0 else CELL) for c in row] for r, row in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, LINE), ("BACKGROUND", (0, 0), (-1, 0), SOFT), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    return t

s = [Paragraph(TITLE, H1), Paragraph("Pakistan — November 2026 · Talha Waqas, Founder", SUB)]
s.append(Paragraph("Summary", H2))
s.append(Paragraph("We invite your company to a 6-month pilot of Inaya Business OS at 30% off, from <b>PKR 5,600 per month</b>, to run your HR, operations, accounting, sales, purchasing and inventory in one secure system.", P))
s += bl([
    "<b>Built for Pakistani businesses:</b> priced in rupees, paid by bank transfer, supported on WhatsApp in Pakistan business hours.",
    "<b>Set up for you:</b> we create your workspace, import your staff, customers and products, and train your team. Setup is free for the first 5 pilot companies.",
    "<b>Low risk:</b> 30% off for the full 6 months, cancel with 14 days' notice, and take all your data with you at any time.",
    "<b>Shaped by you:</b> pilot companies help decide what we build next. One pilot company's suggestion became our classic ERP layout.",
])
s.append(Paragraph("Why Pakistani companies need it", H2))
s.append(Paragraph("Most small and medium companies in Pakistan run on a mix of Excel sheets, WhatsApp groups, paper registers and a separate accounting tool, so nobody sees the whole business in one place.", P))
s.append(table([
    ["Today", "With Inaya"],
    ["Staff records and leave in Excel or on paper", "Employee records, leave requests and approvals in one place"],
    ["Customer follow-ups lost in WhatsApp chats", "Customers, leads and deals tracked, with a full history"],
    ["Invoices typed by hand, payments chased by phone", "Numbered invoices in minutes, overdue invoices flagged automatically"],
    ["Stock counted by hand, shortages found too late", "Live stock levels with low-stock alerts across warehouses"],
    ["Important files on personal laptops and USB drives", "Encrypted company documents, shared securely and backed up"],
    ["The owner asks five people to know where things stand", "One dashboard showing what needs attention today"],
], [W * 0.48, W * 0.52]))
s.append(Paragraph("What's included", H2))
s.append(Paragraph("Every package includes all of the modules below, on Windows, Linux, Android and in the browser, laid out like a classic desktop ERP.", P))
s.append(table([
    ["Area", "What your team can do"],
    ["People (HR)", "Employee records, leave requests and approvals, department managers, org chart, onboarding checklists"],
    ["Operations", "Tasks, projects, departments, approvals, automations, secure chat and video meetings"],
    ["Accounting", "Invoices, expenses, payments, general ledger, financial statements, AI bookkeeping assistant"],
    ["Sales and CRM", "Customers and leads, deals and pipeline, customer support desk"],
    ["Purchasing", "Suppliers, purchase requests, purchase orders, purchasing reports"],
    ["Inventory", "Products, stock levels and low-stock alerts, stock movements, warehouses"],
    ["Documents", "Encrypted files, secure sharing, e-signatures, generated invoices and documents"],
    ["Admin", "Users and roles, company settings, account security, audit trail, activity log"],
    ["WhatsApp with Inaya Connect (Business and Enterprise)", "Your own WhatsApp Business number in one team inbox; ask \"how much did we sell today?\" on WhatsApp; bills sent on WhatsApp go to AI Bookkeeper"],
    ["Inaya Commerce (optional add-on)", "Point of sale, stock across branches, loyalty and gift cards, your own web store with Shopify and WooCommerce sync: Commerce Starter on Professional (PKR 8,000 a month), the Commerce add-on on Business (PKR 12,000), included in Enterprise"],
], [W * 0.30, W * 0.70]))
s.append(Paragraph("Packages and pilot prices", H2))
s.append(Paragraph("The pilot is open to 10 companies. Pilot companies pay 30% less for all 6 months, and the first 5 also get setup free. All prices are per company, per month, in Pakistani rupees.", P))
s.append(table([
    ["Package", "Users", "Standard price (PKR/month)", "Pilot price (PKR/month, 6 months)", "Pilot total (PKR, 6 months)"],
    ["Starter", "up to 2", "8,000", "5,600", "33,600"],
    ["Professional", "up to 5", "20,000", "14,000", "84,000"],
    ["Business", "up to 10", "30,000", "21,000", "126,000"],
    ["Enterprise", "up to 25", "60,000", "42,000", "252,000"],
], [W * 0.18, W * 0.14, W * 0.22, W * 0.26, W * 0.20]))
s += bl([
    "<b>One package per company, with extra users:</b> you can add users on top of your package at PKR 2,500 per user per month (PKR 1,750 during the pilot), up to 3 extra on Starter (5 users in total), 10 on Professional (15), 15 on Business (25) and 20 on Enterprise (45). For more users, move up to the next package. You can upgrade at any time; the same package can't be bought twice.",
    "<b>Setup, data import and training (one time):</b> normally PKR 10,000 (Starter) or 25,000 (other packages). Free for the first 5 pilot companies; pilot companies 6 to 10 pay PKR 7,500 (Starter) or 12,500 (other packages).",
    "<b>After the pilot:</b> the standard price applies from month 7. Pilot companies keep that price for their first 12 months after the pilot, and an annual contract costs 10 months for 12.",
    "<b>Larger companies:</b> for more than 45 users, we prepare a custom quote.",
])
s.append(Paragraph("How the pilot runs", H2))
s.append(Paragraph("Your team works in Inaya from week 2. We review together at month 3, and at month 6 you decide whether to continue. We start with people and day-to-day work, then move invoicing, purchasing and stock once your team is comfortable. Your accountant compares the figures with your current books before you rely on them.", P))
s.append(Paragraph("Data, security, support and payment", H2))
s += bl([
    "<b>Encryption:</b> documents are encrypted on your own computer before they are uploaded, and every file is kept in two independent storage locations.",
    "<b>Backups:</b> your company's records are backed up daily, and the system is monitored around the clock.",
    "<b>Ownership and export:</b> you own your data and can export all of it at any time. When you leave, we delete it within 30 days of your request.",
    "<b>Support:</b> WhatsApp and email, Monday to Saturday, 10:00 to 19:00 PKT. Urgent issues (the system is down or you can't work) within 2 hours; everything else by the next working day.",
    "<b>Payment:</b> monthly in advance by bank transfer, against our invoice. Prices exclude any applicable sales tax on services.",
    "<b>Pilot status:</b> some features still carry a \"Beta\" label, and we don't promise a fixed uptime percentage during the pilot. We tell you at least 7 days before any change that affects how you work.",
    "<b>Your accountant:</b> keep your accountant involved for the first months, and run your current books in parallel until the figures in Inaya match.",
])
s.append(Paragraph("How to join", H2))
s.append(Paragraph("Pilot places are limited so that every company gets proper attention. To join, reply with your package choice and we start within a week.", P))
s.append(Paragraph("What we ask from pilot companies", H2))
s += bl([
    "A named contact who decides on setup questions and gathers your team's feedback.",
    "Your current data in any format: employees, customers, suppliers, products and opening stock.",
    "A 30-minute feedback call every two weeks.",
    "Permission to name your company as an Inaya customer once you are happy, for example in a short case study.",
])
s.append(Paragraph("Next steps", H2))
s += bl([
    "1. Tell us your package and how many people will use Inaya.",
    "2. We send the pilot agreement and the first invoice.",
    "3. You pay the first month by bank transfer.",
    "4. We book your setup session and your team starts within a week.",
])
s.append(Paragraph("Contact: contact@inayanetwork.com · inayanetwork.com/business", NOTE))

def deco(c, d):
    c.saveState(); c.setFillColor(TEAL); c.rect(0, A4[1] - 6 * mm, A4[0], 6 * mm, fill=1, stroke=0)
    c.setFont("Helvetica", 8); c.setFillColor(MUTED)
    c.drawString(18 * mm, 10 * mm, TITLE); c.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Page {d.page}"); c.restoreState()
SimpleDocTemplate(OUT, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm, bottomMargin=18 * mm, title=TITLE, author="Inaya Network").build(s, onFirstPage=deco, onLaterPages=deco)
print(OUT)
