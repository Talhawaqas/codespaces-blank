---
slug: payroll
title: "Payroll"
description: "Run monthly payroll in Inaya Business OS: pay profiles, allowances and deductions, overtime from clock-ins, unpaid leave, loans, country tax and contribution rules, a second-person approval, payslips employees view and download, password-locked PDFs by email and WhatsApp, bank files and the ledger entry. Included in Business and Enterprise; an add-on for Professional."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [business-admin, hr, finance]
status: live
version: current
tags: [payroll, payslip, salary, wages, tax, eobi, provident fund, gratuity, wps, sif, withholding, fica, kazakhstan, uzbekistan, azerbaijan, uae, pakistan, united states, bank file, loans, advances]
lastVerifiedAt: "2026-11-27"
relatedDocs: [business-workspace, inaya-connect, sign-in-and-package-features]
---

## What it is

Payroll turns the people, attendance and leave you already keep in Inaya into a monthly payroll: everyone's pay, tax and contributions, an approval by a second person, payslips, a bank transfer file and the accounting entry. It is included in **Business** and **Enterprise**, and Professional companies can add it for **$35 a month (PKR 7,500 in Pakistan)** under **Billing › Add-ons**.

Inaya calculates pay from the rules you confirm. **It does not file tax returns or pay tax authorities for you.**

## Countries

| Country | What is calculated |
|---|---|
| Pakistan | Salaried income tax (tax year 2027 slabs, spread over the July–June tax year), EOBI on the minimum wage, provident fund, provincial social security |
| United Arab Emirates | No income tax; end-of-service gratuity accrual and estimate; GPSSA pension for UAE/GCC nationals; WPS salary file (SIF) |
| United States | Federal income tax withholding (IRS Publication 15-T 2026, Form W-4 2020 or later), social security to $184,500, Medicare and Additional Medicare, FUTA; state/local tax at the rate you enter per employee |
| Kazakhstan | IIT 10%/15% (cumulative), standard deduction, OPV, VOSMS; employer OPVR, social contributions, OOSMS and social tax (2026) |
| Uzbekistan | Income tax 12% and employer social tax 12%; IT Park residents 7.5% and no social tax |
| Azerbaijan | Private non-oil sector 2026 income tax bands, social, unemployment and health insurance |
| Any other country | Your own income tax percentage and contributions |

Each set of rules names its source and the date it was checked. **Before the first payroll, an HR manager or owner reviews the rules and confirms them** (Payroll › Settings). If you change country or the rules are updated, they must be confirmed again.

## Set up (once)

1. **Payroll › Settings**: choose the country and currency, and adjust overtime, monthly hours, EOBI/provident fund (Pakistan), establishment ID and routing code (UAE WPS), and so on. Then confirm the rules.
2. **Payroll › Employees' pay**: for each employee, enter the basic salary, allowances (taxable or not), fixed deductions, bank details and the country's tax fields (for example, the W-4 in the US).
3. **Payroll › Loans & advances**: record any advance with its monthly instalment.

Salary, bank and tax details are stored encrypted.

## Each month

1. **Prepare payroll** for the month. Inaya uses each employee's pay, **approved unpaid leave** (leave types containing "unpaid"), **overtime** from clock-ins above the weekly overtime threshold, loan instalments and the confirmed rules.
2. Check the totals and each person's lines; **Recalculate** after changes.
3. **Submit for approval**. An owner/admin or finance manager **who did not prepare it** approves it.
4. Download the **bank file** (CSV, or the WPS SIF file in the UAE) and pay.
5. **Mark as paid**. Payslips are published to employees, loan balances go down, and the ledger entry is posted (Salaries & Wages, Employer Payroll Contributions, Payroll Taxes & Deductions Payable, Cash).
6. Optionally **Email payslips** and **Send on WhatsApp**.

## Payslips for employees

Every employee has **My payslips** (People › Payroll › My payslips) on the web, desktop and Android apps, with **Download PDF**. There they also choose:

- a **payslip password** (6 or more characters). Payslips sent by email or WhatsApp are PDFs that open only with it. HR never sees it.
- their **WhatsApp number**.

Without a payslip password, the email only says the payslip is in Inaya, and WhatsApp is skipped.

## Payslips on WhatsApp

This uses Inaya Connect (Business and Enterprise). Create a **Utility** template in Meta with a **Document** header and two body variables (name and month), wait for approval, then enter its name in Payroll › Settings. See [Inaya Connect](/docs/products/inaya-connect).

## Honest limits

- Inaya does not file returns (FBR, IRS forms, WPS submission) or deposit taxes.
- US state and local income tax is a rate you enter, not calculated from state tables. When the Form W-4 Step 2 box is ticked, withholding is an approximation.
- Pakistan tax assumes regular monthly salary; one-off bonuses are taxed in the month paid. Tax credits, exemptions and multiple employers are not handled automatically: adjust with a deduction or one-off line.
- Gratuity in the UAE is an estimate under Decree-Law 33 of 2021; check unpaid leave and contract terms before paying.
