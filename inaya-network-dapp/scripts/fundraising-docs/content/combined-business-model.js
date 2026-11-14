// scripts/fundraising-docs/content/combined-business-model.js
//
// Combined business model (Dapp storage + Business Workspace) at the 13 Nov 2026 price book. Figures come from
// Downloads/Inaya-Combined-Financial-Model.xlsx (Excel-calculated, three scenarios); regenerate both together.

export const combinedBusinessModel = {
  "cover": {
    "company": "INAYA NETWORK",
    "classification": "CONFIDENTIAL",
    "kicker": "COMBINED BUSINESS MODEL",
    "title": "How Inaya Makes Money",
    "subtitle": "One model for both products — the Dapp storage network and the Business Workspace — at the November 2026 price book, with a five-year projection in three scenarios.",
    "docLine": "Document INAYA-COMBINED-BM-2026-V1 · Classification Confidential · November 2026"
  },
  "docId": "INAYA-COMBINED-BM-2026-V1",
  "sections": [
    {
      "number": "01",
      "title": "Executive Overview",
      "blocks": [
        {
          "type": "paragraphs",
          "text": [
            "Inaya earns money from two products built on one encrypted storage foundation. The Dapp storage network charges for storing data — by the terabyte for individuals and developers, and by yearly Corporate Reserve contracts for companies. The Business Workspace sells monthly or yearly subscriptions to companies, in US dollars internationally and in rupees in Pakistan.",
            "Storage is the volume engine: each terabyte keeps 65% for Inaya after the node operators who store it are paid. The Business Workspace is the high-margin engine: once hosting and payment costs are covered, almost every subscription dollar is gross profit, and it can earn revenue before the storage network reaches mainnet.",
            "Everything in Sections 06 and 07 is a projection. Inaya has no revenue today and the storage network runs on BNB Chain testnet. The full workbook (Inaya-Combined-Financial-Model.xlsx) has every assumption in its own editable cell."
          ]
        }
      ]
    },
    {
      "number": "02",
      "title": "Revenue Streams",
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
              "Retrieval beyond the included amount",
              "Heavy downloaders",
              "10 INAYA per 0.5 TB",
              "From mainnet; not in the model"
            ],
            [
              "Business Workspace (international)",
              "Companies",
              "$7.99 / $28 / $49.99 / $799 a month",
              "Live on the website"
            ],
            [
              "Business Workspace (Pakistan)",
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
              "Setup and installation",
              "New companies",
              "PKR 10,000–25,000 (Pakistan); international to be set",
              "Live in Pakistan"
            ]
          ]
        }
      ]
    },
    {
      "number": "03",
      "title": "Storage Unit Economics",
      "blocks": [
        {
          "type": "lead",
          "text": "Every storage invoice is split automatically on-chain: 35% to the node operators who store the data, 55% to the company treasury and 10% to team and platform operations. Inaya keeps 65%."
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
            "The price is below every major provider's list price (Backblaze B2 6.95, Storj 7.00, Wasabi 7.99, Cloudflare R2 15, Amazon S3 about 23 USD per TB per month), and downloads up to the amount stored are included, so customers' bills are predictable.",
            "Node operators are paid out of each invoice, so storage costs grow only with storage revenue: the network never pays for capacity nobody is buying."
          ]
        }
      ]
    },
    {
      "number": "04",
      "title": "Business Workspace Unit Economics",
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
              "$28 a month",
              "PKR 20,000 a month",
              "5",
              "1 TB"
            ],
            [
              "Business",
              "$49.99 a month",
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
            "Yearly billing costs about 17% less than twelve months. Business and Enterprise include appointments and email marketing (50,000 and 250,000 marketing emails a month), which competing suites sell as separate subscriptions.",
            "The model allows $3 a month of hosting per company, card or bank fees of 3%, and a yearly platform cost (servers, database, email and storage gateways) that grows from $3,000 to $40,000. On those figures a Business package earns over 90% gross margin. Setup and installation fees pay for onboarding and for paid service tiers, such as a larger email sending plan, as companies join."
          ]
        }
      ]
    },
    {
      "number": "05",
      "title": "Where the Money Goes",
      "blocks": [
        {
          "type": "bullets",
          "items": [
            "Cost of revenue: node-operator payouts (35% of storage revenue), payment processing, per-company hosting and platform services.",
            "Operating costs: the team, product development, security audits, marketing and overheads — the yearly burn from the Investment Memorandum ($1.5M rising to $4.5M by Year 5).",
            "Funding: the $2M pre-seed round. Later rounds are not modelled, so the cash line shows plainly when more funding would be needed."
          ]
        }
      ]
    },
    {
      "number": "06",
      "title": "Five-Year Projection (Base Scenario)",
      "blocks": [
        {
          "type": "lead",
          "text": "Base uses the Investment Memorandum's Corporate Reserve volumes (15 PB in Year 1 to 1,500 PB in Year 5) and its burn rates, plus conservative placeholders for everything else."
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
              "Dapp storage revenue",
              "$0.50M",
              "$2.50M",
              "$8.65M",
              "$28.2M",
              "$71.3M"
            ],
            [
              "Business Workspace — international",
              "$2K",
              "$17K",
              "$56K",
              "$0.14M",
              "$0.28M"
            ],
            [
              "Business Workspace — Pakistan",
              "$4K",
              "$22K",
              "$62K",
              "$0.13M",
              "$0.23M"
            ],
            [
              "Total revenue",
              "$0.51M",
              "$2.54M",
              "$8.76M",
              "$28.5M",
              "$71.8M"
            ],
            [
              "Node-operator share (35% of storage)",
              "($0.17M)",
              "($0.87M)",
              "($3.03M)",
              "($9.87M)",
              "($24.9M)"
            ],
            [
              "Payment, hosting and platform costs",
              "($4K)",
              "($10K)",
              "($23K)",
              "($49K)",
              "($86K)"
            ],
            [
              "Gross profit",
              "$0.33M",
              "$1.65M",
              "$5.72M",
              "$18.6M",
              "$46.7M"
            ],
            [
              "Gross margin",
              "65%",
              "65%",
              "65%",
              "65%",
              "65%"
            ],
            [
              "Operating burn",
              "($1.50M)",
              "($2.00M)",
              "($2.50M)",
              "($3.50M)",
              "($4.50M)"
            ],
            [
              "Net income",
              "($1.17M)",
              "($0.35M)",
              "$3.22M",
              "$15.1M",
              "$42.2M"
            ],
            [
              "Cash at year-end (after the $2M pre-seed)",
              "$0.83M",
              "$0.48M",
              "$3.69M",
              "$18.8M",
              "$61.0M"
            ]
          ]
        },
        {
          "type": "note",
          "label": "Reading the table.",
          "text": "Revenue is billed on the average amount stored during each year, so Year 1 storage revenue is about half of the year-end run rate the Investment Memorandum shows. Inaya breaks even in Year 3. Business Workspace is 1.3% of revenue in Year 1 and 0.7% in Year 5, because the customer counts are deliberately cautious placeholders (27 paying companies at the end of Year 1, 1,095 by Year 5); every 100 extra Business-package companies adds about $57,000 a year."
        }
      ]
    },
    {
      "number": "07",
      "title": "Scenarios",
      "blocks": [
        {
          "type": "lead",
          "text": "Conservative stores a quarter of the Base volume and wins half the companies; Optimistic stores 1.5× and wins 1.5× the companies. Costs other than per-company hosting stay the same."
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
              "Conservative — revenue",
              "$0.13M",
              "$0.64M",
              "$2.22M",
              "$7.19M",
              "$18.1M"
            ],
            [
              "Conservative — net income",
              "($1.42M)",
              "($1.58M)",
              "($1.05M)",
              "$1.18M",
              "$7.27M"
            ],
            [
              "Conservative — cash at year-end",
              "$0.58M",
              "($1.00M)",
              "($2.06M)",
              "($0.87M)",
              "$6.40M"
            ],
            [
              "Base — revenue",
              "$0.51M",
              "$2.54M",
              "$8.76M",
              "$28.5M",
              "$71.8M"
            ],
            [
              "Base — net income",
              "($1.17M)",
              "($0.35M)",
              "$3.22M",
              "$15.1M",
              "$42.2M"
            ],
            [
              "Base — cash at year-end",
              "$0.83M",
              "$0.48M",
              "$3.69M",
              "$18.8M",
              "$61.0M"
            ],
            [
              "Optimistic — revenue",
              "$0.76M",
              "$3.80M",
              "$13.1M",
              "$42.7M",
              "$107.7M"
            ],
            [
              "Optimistic — net income",
              "($1.01M)",
              "$0.48M",
              "$6.08M",
              "$24.3M",
              "$65.6M"
            ],
            [
              "Optimistic — cash at year-end",
              "$0.99M",
              "$1.47M",
              "$7.55M",
              "$31.9M",
              "$97.5M"
            ]
          ]
        },
        {
          "type": "note",
          "label": "What the scenarios say.",
          "text": "Base and Optimistic stay cash-positive on the $2M pre-seed (Optimistic breaks even in Year 2, Base in Year 3). Conservative breaks even in Year 4 and needs roughly $2.06M more funding by Year 3, so the next raise should be planned for the end of Year 1 unless storage volume tracks Base."
        }
      ]
    },
    {
      "number": "08",
      "title": "Assumptions and Sources",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Assumption",
            "Value",
            "Source"
          ],
          "rows": [
            [
              "Storage and Corporate Reserve prices",
              "6.49 USDT/TB/month; 5.49 at 1,000 TB",
              "Price book, src/lib/dappPricing.js (13 Nov 2026)"
            ],
            [
              "Revenue split",
              "35% nodes, 55% treasury, 10% team",
              "Price book; RevenueRouter contract"
            ],
            [
              "Corporate Reserve volume",
              "15 / 60 / 200 / 650 / 1,500 PB",
              "Investment Memorandum (founder figures)"
            ],
            [
              "Operating burn",
              "$1.5M / 2.0M / 2.5M / 3.5M / 4.5M",
              "Investment Memorandum (founder figures)"
            ],
            [
              "Business Workspace prices",
              "USD and PKR packages above",
              "src/lib/orgPlans.js, src/lib/pkPricing.js"
            ],
            [
              "Companies, pay-as-you-go volume, accounts",
              "Conservative placeholders",
              "To be replaced with founder estimates"
            ],
            [
              "Exchange rate",
              "PKR 280 per USD",
              "Placeholder; update to the current rate"
            ],
            [
              "Hosting, platform and payment costs",
              "$3 per company a month; $3K–40K a year; 3%",
              "Placeholders"
            ]
          ]
        }
      ]
    },
    {
      "number": "09",
      "title": "Not Included, and What to Watch",
      "blocks": [
        {
          "type": "bullets",
          "items": [
            "Not included: INAYA retrieval fees and Corporate Reserve maintenance paid in INAYA, token sales or treasury gains, Sovereign Infrastructure (customer-hardware) fees, taxes, and any later funding round.",
            "Storage revenue depends on the mainnet launch, which itself depends on independent security audits.",
            "More than 95% of projected revenue comes from Corporate Reserve storage in every scenario, so winning the first enterprise storage contracts matters more than any other number in the model.",
            "Business Workspace can earn revenue now, on testnet, and is the fastest way to show real recurring revenue before mainnet."
          ]
        },
        {
          "type": "note",
          "label": "Status.",
          "text": "Projections only. Inaya has no revenue to date, is not yet incorporated (registration planned by the end of February 2027), and runs on BNB Chain testnet."
        }
      ]
    }
  ]
};
