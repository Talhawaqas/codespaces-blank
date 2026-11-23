// scripts/fundraising-docs/content/combined-business-model.js
//
// Combined business model, revised 15 Nov 2026 (INAYA-COMBINED-BM-REVISION-SOW-v1). Generated from
// Downloads/Inaya-Combined-Financial-Model.xlsx (Excel-calculated); regenerate both together.

export const combinedBusinessModel = {
  "cover": {
    "company": "INAYA NETWORK",
    "classification": "CONFIDENTIAL",
    "kicker": "COMBINED BUSINESS MODEL",
    "title": "How Inaya Makes Money",
    "subtitle": "One consolidated model for the DePIN storage network and Inaya Business OS, revised for the planned international sales team and the Pakistan-based team, with five-year projections in three scenarios.",
    "docLine": "Document INAYA-COMBINED-BM-2026-V2 · Classification Confidential · November 2026 (revised 17 Nov: Workspace price book and extra-storage add-on)"
  },
  "docId": "INAYA-COMBINED-BM-2026-V2",
  "sections": [
    {
      "number": "01",
      "title": "Executive Overview",
      "blocks": [
        {
          "type": "paragraphs",
          "text": [
            "Inaya earns money from two products on one encrypted storage foundation, reported as one company. The DePIN storage network charges by the terabyte and through yearly Corporate Reserve contracts. Inaya Business OS sells monthly or yearly subscriptions, in US dollars internationally and in rupees in Pakistan.",
            "This revision replaces the old $2K placeholder for international Workspace revenue with a month-by-month customer forecast driven by two dedicated salespeople, adds the planned ten-person Pakistan team with founder salaries, and sets team and office at $200K in Year 1. DePIN storage revenue, node-operator payouts, the $400K–$800K storage infrastructure and the $300K of one-time Year 1 costs are unchanged.",
            "In the Base scenario the company loses $534K in Year 1, which the $2M pre-seed covers, is profitable from Year 2, and never has less than $1.47M in cash. Profit comes overwhelmingly from Corporate Reserve storage after mainnet; the Workspace is the revenue that can start before mainnet."
          ]
        },
        {
          "type": "note",
          "label": "What kind of figure is what.",
          "text": "Prices and product capabilities are current (November 2026 price book). Salaries, office costs, churn, sales headcount and costs marked 'founder' are the founder's operating assumptions. $20K / $40K / $80K are management planning targets. Everything in Sections 05–09 is a model-generated projection. Inaya has no customers or revenue today, and the storage network runs on BNB Chain testnet."
        }
      ]
    },
    {
      "number": "02",
      "title": "Revenue Streams and Price Book",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Stream",
            "Who pays",
            "Price (Nov 2026)",
            "Status"
          ],
          "rows": [
            [
              "Pay-as-you-go storage",
              "Individuals, developers",
              "6.49 USDT per TB per month",
              "Testnet; billable from mainnet"
            ],
            [
              "Upload fee",
              "Pay-as-you-go users",
              "One month of storage on new data",
              "Testnet; billable from mainnet"
            ],
            [
              "Account fee",
              "Every storage account",
              "12 USDT per year",
              "Testnet; billable from mainnet"
            ],
            [
              "Corporate Reserve",
              "Companies storing in bulk",
              "17,970 / 34,740 / 65,880 USDT a year for 250 / 500 / 1,000 TB",
              "Testnet; card checkout built"
            ],
            [
              "Business OS (international)",
              "Companies",
              "$7.99 / $39 / $99 / $799 a month",
              "Live on the website"
            ],
            [
              "Business OS (Pakistan)",
              "Companies in Pakistan",
              "PKR 8,000 / 20,000 / 30,000 / 60,000 a month",
              "Live; pilot programme open"
            ],
            [
              "Extra users",
              "Growing companies",
              "$3 or PKR 2,500 per user per month",
              "Live"
            ],
            [
              "Extra storage",
              "Companies needing more space",
              "$19.99 per TB per month (international)",
              "Live on the website"
            ],
            [
              "Setup and installation",
              "New companies",
              "PKR 10,000–25,000 (Pakistan); international not yet set",
              "Live in Pakistan"
            ]
          ]
        },
        {
          "type": "paragraphs",
          "text": [
            "Yearly billing costs about 17% less than twelve months. Business and Enterprise include appointments and email marketing (50,000 and 250,000 marketing emails a month). Retrieval beyond the included amount (10 INAYA per 0.5 TB) starts at mainnet and is not in the model."
          ]
        }
      ]
    },
    {
      "number": "03",
      "title": "DePIN Storage Unit Economics",
      "blocks": [
        {
          "type": "lead",
          "text": "Every storage invoice is split on-chain: 35% to the node operators who store the data, 55% to the company treasury and 10% to team and platform operations. Inaya keeps 65%."
        },
        {
          "type": "table",
          "headers": [
            "Per TB per month",
            "Customer pays",
            "Node operators (35%)",
            "Inaya keeps (65%)"
          ],
          "rows": [
            [
              "Pay-as-you-go",
              "6.49 USDT",
              "2.27 USDT",
              "4.22 USDT"
            ],
            [
              "Corporate Reserve 250 TB",
              "5.99 USDT",
              "2.10 USDT",
              "3.89 USDT"
            ],
            [
              "Corporate Reserve 1,000 TB",
              "5.49 USDT",
              "1.92 USDT",
              "3.57 USDT"
            ]
          ]
        },
        {
          "type": "paragraphs",
          "text": [
            "Node operators are paid out of each invoice, so payouts grow only with storage revenue. Inaya's own file storage infrastructure ($400K in Year 1, rising to $800K) is a separate operating cost that the protocol needs and that stays in this model in full."
          ]
        }
      ]
    },
    {
      "number": "04",
      "title": "Business OS Unit Economics",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Package",
            "International",
            "Pakistan",
            "Users included",
            "Storage"
          ],
          "rows": [
            [
              "Starter",
              "$7.99 a month",
              "PKR 8,000 a month",
              "2",
              "250 GB"
            ],
            [
              "Professional",
              "$39 a month",
              "PKR 20,000 a month",
              "5",
              "1 TB"
            ],
            [
              "Business",
              "$99 a month",
              "PKR 30,000 a month",
              "10",
              "5 TB"
            ],
            [
              "Enterprise",
              "$799 a month",
              "PKR 60,000 a month",
              "Up to 25",
              "10 TB"
            ]
          ]
        },
        {
          "type": "paragraphs",
          "text": [
            "Revenue per paying international customer comes from the package mix, not a single price: in the Base mix it is $149.43 a month including one extra user, of which Enterprise contributes most. 30% of customers are assumed to pay yearly, at the yearly price, recognised evenly over twelve months.",
            "Cost of revenue on the Workspace is $3 of hosting per company a month, 3% payment processing, and the shared platform cost ($3K rising to $40K a year). Gross margin excludes the customer-service team, salespeople and office, which are operating costs in Section 07, so a high gross margin does not mean the Workspace is profitable on its own."
          ]
        }
      ]
    },
    {
      "number": "05",
      "title": "International Sales and Customer Acquisition",
      "blocks": [
        {
          "type": "lead",
          "text": "Two full-time salespeople are dedicated to international Business OS sales: research, outbound prospecting, demos, proposals, closing and onboarding. The co-founder leads marketing for both products; paid marketing is optional, $0 in Year 1 and never more than $10K a year."
        },
        {
          "type": "table",
          "headers": [
            "Year 1 plan",
            "Conservative",
            "Base",
            "Optimistic"
          ],
          "rows": [
            [
              "New customers in Year 1 (both salespeople)",
              "30",
              "60",
              "85"
            ],
            [
              "Ramp: month 1 → month 12",
              "1 → 4",
              "1 → 10",
              "2 → 12"
            ],
            [
              "Starter",
              "40%",
              "35%",
              "28%"
            ],
            [
              "Professional",
              "30%",
              "30%",
              "30%"
            ],
            [
              "Business",
              "17%",
              "20%",
              "20%"
            ],
            [
              "Enterprise",
              "13%",
              "15%",
              "22%"
            ],
            [
              "Revenue per paying customer a month (incl. 1 extra user)",
              "$131.81",
              "$149.43",
              "$202.03"
            ]
          ]
        },
        {
          "type": "table",
          "headers": [
            "Year 1 target reconciliation",
            "Conservative",
            "Base",
            "Optimistic"
          ],
          "rows": [
            [
              "Year 1 revenue planning target (management target)",
              "$20K",
              "$40K",
              "$80K"
            ],
            [
              "Modelled Year 1 cohort revenue",
              "$21K",
              "$42K",
              "$84K"
            ],
            [
              "Difference from target",
              "$699",
              "$2.0K",
              "$3.8K"
            ],
            [
              "New customers signed in Year 1",
              "30",
              "60",
              "85"
            ],
            [
              "Paying customers at year-end",
              "29",
              "58",
              "82"
            ],
            [
              "Year-end MRR",
              "$3.8K",
              "$8.6K",
              "$17K"
            ],
            [
              "Year-end ARR (run rate, not earned)",
              "$45K",
              "$104K",
              "$198K"
            ]
          ]
        },
        {
          "type": "note",
          "label": "Targets are not forced.",
          "text": "Revenue is counted only for months in which a customer pays, so a customer won in month 10 adds three months, not twelve. Each scenario falls slightly short of its target, and the gap is shown rather than hidden. Reaching the targets depends on 13–22% of new customers choosing Enterprise ($799 a month); that share is a founder assumption, not observed demand."
        },
        {
          "type": "table",
          "headers": [
            "Base, international",
            "Year 1",
            "Year 2",
            "Year 3",
            "Year 4",
            "Year 5"
          ],
          "rows": [
            [
              "New customers signed",
              "60",
              "113",
              "169",
              "177",
              "225"
            ],
            [
              "Customers cancelled (1% a month)",
              "2",
              "13",
              "27",
              "44",
              "61"
            ],
            [
              "Paying customers at year-end",
              "58",
              "158",
              "300",
              "434",
              "598"
            ],
            [
              "Recognised revenue (subscriptions, extra users, extra storage)",
              "$42K",
              "$204K",
              "$426K",
              "$675K",
              "$946K"
            ],
            [
              "MRR at year-end",
              "$8.6K",
              "$24K",
              "$45K",
              "$65K",
              "$89K"
            ],
            [
              "ARR at year-end (run rate)",
              "$104K",
              "$283K",
              "$538K",
              "$778K",
              "$1.07M"
            ],
            [
              "International salespeople",
              "2",
              "2",
              "3",
              "3",
              "4"
            ],
            [
              "Paid marketing budget",
              "-",
              "$5.0K",
              "$7.5K",
              "$10K",
              "$10K"
            ]
          ]
        },
        {
          "type": "paragraphs",
          "text": [
            "Years 2–5 are not a growth multiplier on Year 1: new customers come from the number of salespeople (2, 2, 3, 3, 4) times new customers each one closes a month (Base 4), plus paid marketing at an assumed cost per customer, less 1% monthly churn.",
            "A sales funnel (50 contacts a day, 4% response, 60% qualified, 70% demo booked, 80% attended, 70% proposal, 35% close) gives about 3.5 new customers per salesperson a month. That supports the Conservative and Base Year 1 plans; the Optimistic plan (85) needs more than two salespeople can deliver on these placeholder rates, and Base needs each salesperson to beat the funnel from Year 2. The funnel rates should be replaced with real pipeline data after the first quarter."
          ]
        }
      ]
    },
    {
      "number": "06",
      "title": "Employee Structure and Payroll",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Role",
            "Headcount",
            "Monthly salary",
            "≈ USD",
            "Allowance"
          ],
          "rows": [
            [
              "Junior developer 1",
              "1",
              "PKR 200,000",
              "$714",
              "10%"
            ],
            [
              "Junior developer 2",
              "1",
              "PKR 150,000",
              "$536",
              "10%"
            ],
            [
              "Finance and accounting analyst",
              "1",
              "PKR 120,000",
              "$429",
              "10%"
            ],
            [
              "Administration and operations",
              "1",
              "PKR 80,000",
              "$286",
              "15%"
            ],
            [
              "Customer service representative",
              "3",
              "PKR 90,000",
              "$321",
              "15%"
            ],
            [
              "Receptionist",
              "1",
              "PKR 40,000",
              "$143",
              "15%"
            ],
            [
              "International Business OS salesperson",
              "2",
              "PKR 150,000",
              "$536",
              "10%"
            ],
            [
              "Total employees (excluding co-founders)",
              "10",
              "",
              "",
              ""
            ]
          ]
        },
        {
          "type": "bullets",
          "items": [
            "The listed roles add up to ten employees, not eight; the founder confirmed ten.",
            "Fuel and entertainment allowance: 10% of salary at PKR 100,000 or more, 15% below, paid after a four-month probation.",
            "No pay rises in Years 1–2. From Year 3 the rise is Pakistan inflation (10% assumed) plus a performance increment (3% for an average rating of 3).",
            "Salespeople earn 5% of the first-year subscription value of new customers once paid, and a quarterly bonus ($100 at 100% of target, $200 at 125%, $350 at 150%; the model assumes $100).",
            "Office: rent PKR 110,000, electricity 150,000, internet 70,000, cleaning 20,000, supplies 15,000 and a buffer of 85,000 a month; tea, coffee and first aid $150 a month; one-time setup of PKR 1,000,000 (laptops, printers, server room, coffee machine).",
            "Not yet decided, so $0 in the model: co-founder pay (after consulting the company's financial adviser) and employer contributions (in Year 2). Extra salespeople join in Years 3 and 5; extra customer-service staff join when paying companies exceed 200 per person."
          ]
        },
        {
          "type": "table",
          "headers": [
            "Base, USD",
            "Year 1",
            "Year 2",
            "Year 3",
            "Year 4",
            "Year 5"
          ],
          "rows": [
            [
              "Salaries",
              "$50K",
              "$50K",
              "$63K",
              "$77K",
              "$101K"
            ],
            [
              "Allowances (after probation)",
              "$3.9K",
              "$5.8K",
              "$7.0K",
              "$8.7K",
              "$11K"
            ],
            [
              "Sales commission and bonuses",
              "$6.1K",
              "$11K",
              "$16K",
              "$17K",
              "$21K"
            ],
            [
              "Employer costs; co-founder pay",
              "$0",
              "$0",
              "$0",
              "$0",
              "$0"
            ],
            [
              "Office running costs, tea, coffee and first aid",
              "$21K",
              "$23K",
              "$25K",
              "$27K",
              "$30K"
            ],
            [
              "Office setup (one-time)",
              "$3.6K",
              "-",
              "-",
              "-",
              "-"
            ],
            [
              "Detailed build-up",
              "$84K",
              "$89K",
              "$112K",
              "$130K",
              "$164K"
            ],
            [
              "Founder planning figure (used in the P&L)",
              "$200K",
              "$250K",
              "$300K",
              "$350K",
              "$400K"
            ],
            [
              "Headroom inside the planning figure",
              "$116K",
              "$161K",
              "$188K",
              "$220K",
              "$236K"
            ],
            [
              "Employees at year-end",
              "10",
              "10",
              "11",
              "12",
              "14"
            ]
          ]
        },
        {
          "type": "note",
          "label": "Within the $200K figure.",
          "text": "The detailed Year 1 build-up is $84K against the founder's $200K planning figure. The P&L uses whichever is higher, so it carries $200K in Year 1; the $116K of headroom covers co-founder pay, employer contributions and hires still to be decided. Salaries are converted at a placeholder PKR 280 per US dollar."
        }
      ]
    },
    {
      "number": "07",
      "title": "Consolidated Operating Costs",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Base, USD",
            "Year 1",
            "Year 2",
            "Year 3",
            "Year 4",
            "Year 5"
          ],
          "rows": [
            [
              "Team and office",
              "-$200K",
              "-$250K",
              "-$300K",
              "-$350K",
              "-$400K"
            ],
            [
              "File storage infrastructure (DePIN)",
              "-$400K",
              "-$500K",
              "-$600K",
              "-$700K",
              "-$800K"
            ],
            [
              "One-time: legal, security audits, launch marketing",
              "-$300K",
              "-",
              "-",
              "-",
              "-"
            ],
            [
              "Paid marketing (Business OS)",
              "-",
              "-$5.0K",
              "-$7.5K",
              "-$10K",
              "-$10K"
            ],
            [
              "Total operating costs",
              "-$900K",
              "-$755K",
              "-$908K",
              "-$1.06M",
              "-$1.21M"
            ]
          ]
        },
        {
          "type": "paragraphs",
          "text": [
            "Team and office rises from $200K by $50K a year (founder planning figure). Storage infrastructure and the one-time Year 1 costs ($40K legal and compliance, $80K security audits, $180K infrastructure and launch marketing) are unchanged. Recurring Workspace paid marketing is a separate line that starts at $0 in Year 1, so it does not overlap the launch budget."
          ]
        }
      ]
    },
    {
      "number": "08",
      "title": "Five-Year Consolidated Projection (Base)",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "USD",
            "Year 1",
            "Year 2",
            "Year 3",
            "Year 4",
            "Year 5"
          ],
          "rows": [
            [
              "DePIN storage revenue",
              "$499K",
              "$2.50M",
              "$8.65M",
              "$28.2M",
              "$71.3M"
            ],
            [
              "Business OS — international",
              "$42K",
              "$204K",
              "$426K",
              "$675K",
              "$946K"
            ],
            [
              "Business OS — Pakistan (not revised)",
              "$4.4K",
              "$22K",
              "$62K",
              "$129K",
              "$225K"
            ],
            [
              "Total revenue",
              "$546K",
              "$2.72M",
              "$9.13M",
              "$29.0M",
              "$72.4M"
            ],
            [
              "Node-operator share (35% of storage)",
              "-$175K",
              "-$874K",
              "-$3.03M",
              "-$9.87M",
              "-$24.9M"
            ],
            [
              "Payment, hosting and platform costs",
              "-$5.4K",
              "-$18K",
              "-$38K",
              "-$67K",
              "-$103K"
            ],
            [
              "Gross profit",
              "$366K",
              "$1.83M",
              "$6.07M",
              "$19.1M",
              "$47.4M"
            ],
            [
              "Gross margin",
              "67%",
              "67%",
              "66%",
              "66%",
              "65%"
            ],
            [
              "Total operating costs",
              "-$900K",
              "-$755K",
              "-$908K",
              "-$1.06M",
              "-$1.21M"
            ],
            [
              "Net income",
              "-$534K",
              "$1.08M",
              "$5.16M",
              "$18.0M",
              "$46.2M"
            ],
            [
              "Funding received",
              "$2.00M",
              "-",
              "-",
              "-",
              "-"
            ],
            [
              "Cash at year-end",
              "$1.47M",
              "$2.54M",
              "$7.71M",
              "$25.7M",
              "$71.9M"
            ]
          ]
        },
        {
          "type": "note",
          "label": "Reading the table.",
          "text": "Profitability is measured for the whole company, after DePIN infrastructure, team, office, legal, security and marketing. Inaya is profitable from Year 2; the Year 1 loss is covered by the pre-seed, which is funding, not income. DePIN storage is 91% of revenue in Year 1 and 98% in Year 5."
        },
        {
          "type": "table",
          "headers": [
            "Year 1, Base",
            "Previous model",
            "Revised model"
          ],
          "rows": [
            [
              "International Workspace revenue",
              "$2.1K",
              "$42K"
            ],
            [
              "Team and office",
              "$300K",
              "$200K"
            ],
            [
              "File storage infrastructure",
              "$400K",
              "$400K (unchanged)"
            ],
            [
              "One-time Year 1 costs",
              "$300K",
              "$300K (unchanged)"
            ],
            [
              "DePIN storage revenue",
              "$499K",
              "$499K (unchanged)"
            ],
            [
              "Pakistan Workspace revenue",
              "$4.4K",
              "$4.4K (not revised)"
            ],
            [
              "Total revenue",
              "$506K",
              "$546K"
            ],
            [
              "Gross profit",
              "$327K",
              "$366K"
            ],
            [
              "Net income",
              "-$673K",
              "-$534K"
            ],
            [
              "Cash at year-end",
              "$1.33M",
              "$1.47M"
            ]
          ]
        },
        {
          "type": "table",
          "headers": [
            "Year 1 net income bridge",
            "USD"
          ],
          "rows": [
            [
              "Previous Year 1 net income",
              "-$673K"
            ],
            [
              "1. Higher international Workspace revenue",
              "+$40K"
            ],
            [
              "2. Lower team-and-office expense ($300K → $200K)",
              "+$100K"
            ],
            [
              "3. Payment processing and hosting on the new revenue",
              "-$1.7K"
            ],
            [
              "4. Paid marketing (new line; $0 in Year 1)",
              "$0"
            ],
            [
              "5. DePIN storage infrastructure and one-time costs",
              "$0 (unchanged)"
            ],
            [
              "Revised Year 1 net income",
              "-$534K"
            ]
          ]
        },
        {
          "type": "note",
          "label": "Where the improvement comes from.",
          "text": "Higher international Workspace revenue and the lower team-and-office figure, less the extra payment and hosting costs. None of it comes from reducing DePIN storage infrastructure or the one-time costs."
        }
      ]
    },
    {
      "number": "09",
      "title": "Scenarios and Sensitivity",
      "blocks": [
        {
          "type": "lead",
          "text": "Conservative stores a quarter of the Base storage volume and follows the slower sales plan; Optimistic stores 1.5× and follows the faster plan. Operating costs are the same in every scenario: the extra staff and commission that faster sales need still fit inside the team-and-office figure. The Optimistic case is not the expected outcome."
        },
        {
          "type": "table",
          "headers": [
            "USD",
            "Year 1",
            "Year 2",
            "Year 3",
            "Year 4",
            "Year 5"
          ],
          "rows": [
            [
              "Conservative — international customers at year-end",
              "29",
              "83",
              "159",
              "233",
              "321"
            ],
            [
              "Conservative — international Workspace revenue",
              "$21K",
              "$93K",
              "$199K",
              "$318K",
              "$449K"
            ],
            [
              "Conservative — total revenue",
              "$148K",
              "$728K",
              "$2.39M",
              "$7.44M",
              "$18.4M"
            ],
            [
              "Conservative — gross margin",
              "68%",
              "68%",
              "67%",
              "66%",
              "66%"
            ],
            [
              "Conservative — net income",
              "-$800K",
              "-$257K",
              "$703K",
              "$3.86M",
              "$10.9M"
            ],
            [
              "Conservative — cash at year-end",
              "$1.20M",
              "$943K",
              "$1.65M",
              "$5.51M",
              "$16.4M"
            ],
            [
              "Base — international customers at year-end",
              "58",
              "158",
              "300",
              "434",
              "598"
            ],
            [
              "Base — international Workspace revenue",
              "$42K",
              "$204K",
              "$426K",
              "$675K",
              "$946K"
            ],
            [
              "Base — total revenue",
              "$546K",
              "$2.72M",
              "$9.13M",
              "$29.0M",
              "$72.4M"
            ],
            [
              "Base — gross margin",
              "67%",
              "67%",
              "66%",
              "66%",
              "65%"
            ],
            [
              "Base — net income",
              "-$534K",
              "$1.08M",
              "$5.16M",
              "$18.0M",
              "$46.2M"
            ],
            [
              "Base — cash at year-end",
              "$1.47M",
              "$2.54M",
              "$7.71M",
              "$25.7M",
              "$71.9M"
            ],
            [
              "Optimistic — international customers at year-end",
              "82",
              "205",
              "380",
              "546",
              "749"
            ],
            [
              "Optimistic — international Workspace revenue",
              "$84K",
              "$365K",
              "$735K",
              "$1.15M",
              "$1.60M"
            ],
            [
              "Optimistic — total revenue",
              "$840K",
              "$4.14M",
              "$13.8M",
              "$43.7M",
              "$108.9M"
            ],
            [
              "Optimistic — gross margin",
              "68%",
              "68%",
              "67%",
              "66%",
              "65%"
            ],
            [
              "Optimistic — net income",
              "-$330K",
              "$2.05M",
              "$8.30M",
              "$27.7M",
              "$70.1M"
            ],
            [
              "Optimistic — cash at year-end",
              "$1.67M",
              "$3.72M",
              "$12.0M",
              "$39.7M",
              "$109.8M"
            ]
          ]
        },
        {
          "type": "note",
          "label": "What the scenarios say.",
          "text": "All three scenarios stay cash-positive on the $2M pre-seed alone. Base and Optimistic are profitable from Year 2; Conservative from Year 3, with cash never below $943K."
        },
        {
          "type": "table",
          "headers": [
            "Base case, one change at a time",
            "Y1 intl revenue",
            "Y1 net income",
            "Y5 intl revenue",
            "Y5 net income",
            "Lowest cash"
          ],
          "rows": [
            [
              "Plan (Base, no levers)",
              "$42K",
              "-$534K",
              "$946K",
              "$46.2M",
              "$1.47M"
            ],
            [
              "25% fewer new international customers",
              "$32K",
              "-$544K",
              "$710K",
              "$46.0M",
              "$1.46M"
            ],
            [
              "Slower ramp: half the new customers in months 1-6",
              "$31K",
              "-$545K",
              "$937K",
              "$46.2M",
              "$1.45M"
            ],
            [
              "Longer sales cycle: customers start paying 2 months later",
              "$26K",
              "-$549K",
              "$897K",
              "$46.1M",
              "$1.45M"
            ],
            [
              "Lower average subscription value: prices 20% lower",
              "$34K",
              "-$542K",
              "$761K",
              "$46.0M",
              "$1.46M"
            ],
            [
              "Half the Enterprise share (moves to Business)",
              "$28K",
              "-$548K",
              "$634K",
              "$45.9M",
              "$1.45M"
            ],
            [
              "Higher churn: 2% a month instead of 1%",
              "$41K",
              "-$535K",
              "$788K",
              "$46.0M",
              "$1.46M"
            ],
            [
              "No paid marketing",
              "$42K",
              "-$534K",
              "$805K",
              "$46.1M",
              "$1.47M"
            ],
            [
              "Payroll and office 20% higher",
              "$42K",
              "-$574K",
              "$946K",
              "$46.1M",
              "$1.43M"
            ],
            [
              "Hosting and platform costs 50% higher",
              "$42K",
              "-$536K",
              "$946K",
              "$46.2M",
              "$1.46M"
            ],
            [
              "Combined downside: 25% fewer customers, half Enterprise, 2% churn",
              "$21K",
              "-$555K",
              "$395K",
              "$45.7M",
              "$1.45M"
            ]
          ]
        },
        {
          "type": "note",
          "label": "25% fewer customers.",
          "text": "Cutting new international customers by 25% lowers Year 1 international revenue from $42K to $32K and Year 5 from $946K to $710K. Company cash barely moves, because consolidated results are driven by Corporate Reserve storage: the storage volume and the mainnet date matter far more to the company than any Workspace assumption."
        }
      ]
    },
    {
      "number": "10",
      "title": "Assumptions, Risks and Items to Validate",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Assumption",
            "Value",
            "Type"
          ],
          "rows": [
            [
              "Storage, Corporate Reserve and Workspace prices",
              "November 2026 price book",
              "Current price book"
            ],
            [
              "Corporate Reserve volume",
              "15 / 60 / 200 / 650 / 1,500 PB",
              "Founder figure (Investment Memorandum)"
            ],
            [
              "Year 1 revenue targets",
              "$20K / $40K / $80K",
              "Management target"
            ],
            [
              "New-customer ramp and Enterprise share",
              "30 / 60 / 85; 13% / 15% / 22%",
              "Management target (founder)"
            ],
            [
              "Salaries, allowances, pay rises, office; team-and-office figure",
              "Section 06; $200K rising $50K a year",
              "Founder figures"
            ],
            [
              "Churn; yearly billing; extra users",
              "1% a month; 30%; 1 per company",
              "Founder figures"
            ],
            [
              "Extra storage add-on uptake",
              "10% of Professional and Business customers buy 1 TB at $19.99 a month",
              "Placeholder to validate"
            ],
            [
              "Years 2–5 productivity, cost per customer, funnel rates",
              "Section 05",
              "Placeholders to validate"
            ],
            [
              "Pakistan customers, pay-as-you-go volume, accounts",
              "Unchanged",
              "Placeholders, not revised"
            ],
            [
              "Exchange rate; hosting, platform and payment costs",
              "PKR 280; $3 per company a month, $3K–40K a year, 3%",
              "Placeholders"
            ]
          ]
        },
        {
          "type": "bullets",
          "items": [
            "Storage revenue depends on the mainnet launch, which depends on independent security audits.",
            "The Workspace targets depend on Enterprise adoption; with half the assumed Enterprise share, Base Year 1 international revenue falls to about $28K.",
            "Not included: INAYA retrieval and maintenance fees, token sales, Sovereign Infrastructure fees, taxes, interest, depreciation, working-capital timing and later funding rounds.",
            "Every figure reconciles to Inaya-Combined-Financial-Model.xlsx, whose Checks sheet shows all formula and reconciliation checks passing."
          ]
        },
        {
          "type": "note",
          "label": "Status.",
          "text": "Projections only. Inaya has no customers or revenue to date, is not yet incorporated (registration planned by the end of February 2027), and runs on BNB Chain testnet; no storage revenue is being collected."
        }
      ]
    }
  ]
};
