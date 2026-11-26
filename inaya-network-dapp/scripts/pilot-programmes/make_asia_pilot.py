import os
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

OUT = r"D:\Codespace-blank\codespaces-blank-main\codespaces-blank-main\inaya-network-dapp\public\documents\inaya-pilot-programme-asia.pdf"
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
TITLE = "Inaya Business OS: 6-Month Pilot Programme for Companies in Asia"

def bl(items): return [Paragraph(i, B, bulletText="•") for i in items]
def table(rows, widths):
    data = [[Paragraph(str(c), CELLB if r == 0 else CELL) for c in row] for r, row in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, LINE), ("BACKGROUND", (0, 0), (-1, 0), SOFT), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    return t

s = [Paragraph(TITLE, H1), Paragraph("India · Bangladesh · Sri Lanka · UAE · Saudi Arabia · Malaysia · Indonesia · Singapore · Philippines — November 2026 · Talha Waqas, Founder", SUB)]
s.append(Paragraph("Summary", H2))
s.append(Paragraph("We invite your company to a 6-month pilot of Inaya Business OS at 30% off, from <b>$5.59 a month</b>, to run your HR, operations, accounting, sales, purchasing and inventory in one secure system.", P))
s += bl([
    "<b>Priced in US dollars</b>, so the price doesn't move with exchange rates, and paid by bank transfer against our invoice.",
    "<b>Set up for you:</b> we create your workspace, import your staff, customers and products, and train your team, for a one-time setup fee from $29 for pilot companies.",
    "<b>Low risk:</b> 30% off for the full 6 months, cancel with 14 days' notice, and take all your data with you at any time.",
    "<b>Shaped by you:</b> pilot companies help decide what we build next. One pilot company's suggestion became our classic ERP layout.",
])
s.append(Paragraph("Why it matters", H2))
s.append(table([
    ["Today", "With Inaya"],
    ["Staff records and leave in spreadsheets or on paper", "Employee records, leave requests and approvals in one place"],
    ["Customer follow-ups lost in chat apps", "Customers, leads and deals tracked, with a full history"],
    ["Invoices typed by hand, payments chased by phone", "Numbered invoices in minutes, overdue invoices flagged automatically"],
    ["Stock counted by hand, shortages found too late", "Live stock levels with low-stock alerts and batch tracking"],
    ["Important files on personal laptops", "Encrypted company documents, shared securely and backed up"],
    ["The owner asks five people to know where things stand", "One dashboard showing what needs attention today"],
], [W * 0.48, W * 0.52]))
s.append(Paragraph("What's included", H2))
s.append(Paragraph("Every package includes the modules below, on Windows, Linux, Android and in the browser, laid out like a classic desktop ERP.", P))
s.append(table([
    ["Area", "What your team can do"],
    ["People (HR)", "Employee records, leave requests and approvals, department managers, onboarding checklists"],
    ["Operations", "Tasks, projects, approvals, automations, secure chat and video meetings"],
    ["Accounting", "Invoices, expenses, payments, general ledger, financial statements, AI bookkeeping assistant"],
    ["Sales and CRM", "Customers and leads, deals and pipeline, customer support desk"],
    ["Purchasing and inventory", "Suppliers, purchase orders, stock levels, warehouses, batches and expiry dates, production"],
    ["Documents", "Encrypted files, secure sharing, e-signatures, generated invoices in English and Arabic"],
    ["Appointments and email (Business and Enterprise)", "Online booking page, team calendars, reminders, email campaigns to your customers"],
    ["WhatsApp with Inaya Connect (Business and Enterprise)", "Your own WhatsApp Business number in one team inbox; ask \"how much did we sell today?\" on WhatsApp; bills sent on WhatsApp go to AI Bookkeeper"],
    ["Inaya Commerce (optional add-on)", "Point of sale, stock across branches, loyalty and gift cards, your own web store with Shopify and WooCommerce sync: Commerce Starter on Professional ($49 a month), the Commerce add-on on Business ($79), included in Enterprise"],
], [W * 0.30, W * 0.70]))
s.append(Paragraph("Made for your industry", H2))
s.append(table([
    ["Industry", "What's built for you"],
    ["Schools and colleges", "Education edition: student and guardian records with personal data encrypted, admissions, attendance, exams and report cards, fees in INR, BDT or AED with receipts, and read-only parent links"],
    ["Clinics and healthcare", "Health edition: patient records with care-team access, consent, appointments with online booking and reminders, and billing"],
    ["Manufacturers and pharma", "Batch and expiry tracking, earliest-expiry-first picking, recall tracing, bills of materials and production runs, purchasing"],
    ["Traders and distributors", "Sales orders against live stock, delivery, invoicing, customer credit follow-up, purchase orders and supplier records"],
], [W * 0.26, W * 0.74]))
s.append(Paragraph("Packages and pilot prices", H2))
s.append(Paragraph("The pilot is open to 10 companies in each country. Pilot companies pay 30% less for all 6 months. All prices are per company, per month, in US dollars.", P))
s.append(table([
    ["Package", "Users", "Standard price ($/month)", "Pilot price ($/month, 6 months)", "Pilot total ($, 6 months)"],
    ["Starter", "up to 2", "7.99", "5.59", "33.54"],
    ["Professional", "up to 5", "39.00", "27.30", "163.80"],
    ["Business", "up to 10", "99.00", "69.30", "415.80"],
    ["Enterprise", "up to 25", "799.00", "559.30", "3,355.80"],
], [W * 0.18, W * 0.14, W * 0.22, W * 0.26, W * 0.20]))
s += bl([
    "<b>Extra users:</b> $3 per user per month ($2.10 during the pilot), up to 3 extra on Starter, 10 on Professional, 15 on Business and 20 on Enterprise. For more users, move up a package. One package per company; you can upgrade at any time.",
    "<b>Setup, data import and training (one time):</b> pilot companies pay $29 (Starter) or $49 (other packages); the standard fee is $39 or $89.",
    "<b>After the pilot:</b> the standard price applies from month 7. Pilot companies keep that price for their first 12 months after the pilot, and an annual contract costs 10 months for 12.",
    "<b>Larger companies:</b> for more than 45 users, we prepare a custom quote.",
])
s.append(Paragraph("How the pilot runs", H2))
s.append(Paragraph("Your team works in Inaya from week 2. We review together at month 3, and at month 6 you decide whether to continue. We start with people and day-to-day work, then move invoicing, purchasing and stock once your team is comfortable. Keep your accountant involved and run your current books in parallel until the figures match.", P))
s.append(Paragraph("Data, security, support and payment", H2))
s += bl([
    "<b>Encryption:</b> documents are encrypted on your own computer before they are uploaded, and every file is kept in two independent storage locations.",
    "<b>Backups:</b> your company's records are backed up daily, and the system is monitored around the clock.",
    "<b>Ownership:</b> you own your data and can export all of it at any time. When you leave, we delete it within 30 days of your request.",
    "<b>Support:</b> email and video call, Monday to Saturday, 10:00 to 19:00 Pakistan time (10:30–19:30 in India, 09:00–18:00 in the UAE, 13:00–22:00 in Singapore). Urgent issues within 2 hours; everything else by the next working day.",
    "<b>Payment:</b> monthly in advance by international bank transfer, against our invoice, in US dollars. Prices exclude any local taxes.",
    "<b>Pilot status:</b> some features still carry a \"Beta\" label, and we don't promise a fixed uptime percentage during the pilot. We tell you at least 7 days before any change that affects how you work.",
])
s.append(Paragraph("How to join", H2))
s.append(Paragraph("Pilot places are limited so that every company gets proper attention. Reply to our email, or write to contact@inayanetwork.com, with your package choice and we start within a week. Watch the 4-minute demo first at inayanetwork.com/business/demo.", NOTE))

def deco(c, d):
    c.saveState(); c.setFillColor(TEAL); c.rect(0, A4[1] - 6 * mm, A4[0], 6 * mm, fill=1, stroke=0)
    c.setFont("Helvetica", 8); c.setFillColor(MUTED)
    c.drawString(18 * mm, 10 * mm, TITLE); c.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Page {d.page}"); c.restoreState()
SimpleDocTemplate(OUT, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm, bottomMargin=18 * mm, title=TITLE, author="Inaya Network").build(s, onFirstPage=deco, onLaterPages=deco)
print(OUT)
