// scripts/fundraising-docs/content/hospitality-summary.js
//
// Summary of the Hospitality & Food Service Workspace SOW as built and deployed (commit 183db93, 15 Nov 2026).
// Written to the founder's Downloads folder only. Facts match docs/hospitality/*.md; keep them in step.

export const hospitalitySummary = {
  cover: {
    company: "INAYA NETWORK",
    classification: "INTERNAL",
    kicker: "DELIVERY SUMMARY",
    title: "Hospitality OS",
    subtitle: "What was built and deployed for the Hospitality & Food Service Workspace SOW: reservations, tables, guests, menu, stock and daily operations for restaurants, cafes and caterers.",
    docLine: "Document INAYA-HOSPITALITY-SUMMARY-2026-V1 · Classification Internal · November 2026",
  },
  docId: "INAYA-HOSPITALITY-SUMMARY-2026-V1",
  sections: [
    {
      number: "01",
      title: "At a Glance",
      blocks: [
        { type: "lead", text: "Hospitality OS is the eighth industry edition of the Inaya Business OS. It is live on inayanetwork.com and connects a restaurant's daily work to the modules a company already has, instead of being a separate restaurant app." },
        {
          type: "table",
          headers: ["Item", "Status"],
          rows: [
            ["Deployed", "15 November 2026, commit 183db93, live on www.inayanetwork.com"],
            ["Automated tests", "39 of 39 pass against the real database; 181 related existing tests still pass"],
            ["Browser check", "Setup, a staff booking and a guest booking on the public page, every tab with no errors"],
            ["How a company turns it on", "Business type \"Restaurant / cafe / catering (Hospitality OS)\" at signup or in Settings"],
            ["New database collections", "None (the database is at its collection limit); records share the existing calendar collection"],
          ],
        },
      ],
    },
    {
      number: "02",
      title: "What Restaurants Get",
      blocks: [
        {
          type: "table",
          headers: ["Area", "What it does"],
          rows: [
            ["Locations", "Opening hours, closed dates, time zone, currency, reservation policy (notice, booking window, guest limit, turn times, reminders); one company can run many locations"],
            ["Tables", "Seating areas, tables with party sizes, tables that can be pushed together, temporary closures"],
            ["Reservations", "Day, week and month views; phone, staff, walk-in and online bookings; automatic table choice; confirmed, arrived, seated, completed, cancelled, no-show"],
            ["Floor view", "Every table as free, reserved or seated, with who is next; refreshes every minute"],
            ["Waitlist", "Walk-ins waiting, the next party that fits a free table, invite and seat in one step"],
            ["Online booking page", "Per location, at /reserve/<name>; guests pick a time and get a link to view or cancel"],
            ["Guests", "CRM contacts with visit history, preferences and feedback; marketing opt-in kept separate from the booking"],
            ["Menu and recipes", "Menus, categories, items, options, dietary labels and allergens reviewed by a manager; recipes from Inventory ingredients with versions"],
            ["Stock", "Stock at the location, low-stock flags, wastage with approval, stock counts, draft purchase requests, delivery checks"],
            ["Operations", "Weekly roster, publishing, shift swaps; opening and closing checklists; guest complaints and incidents"],
            ["Reports", "Bookings, guests served, no-show and cancellation rates, waitlist, wastage, stock differences, purchase orders, checklists, incidents"],
          ],
        },
      ],
    },
    {
      number: "03",
      title: "Built on What Already Exists",
      blocks: [
        { type: "lead", text: "The SOW asked for reuse before rebuilding. Every shared business record stays in its existing module." },
        {
          type: "table",
          headers: ["Need", "Existing module used"],
          rows: [
            ["Guests", "CRM: a booking links to the contact or creates one; visits are written to the contact"],
            ["Ingredients and stock", "Inventory: every stock change goes through the existing stock movements"],
            ["Reordering", "Procurement: a draft purchase request that follows the existing approval flow"],
            ["Staff", "HR employees and approved leave"],
            ["Guest campaigns", "Campaigns: one sender, one unsubscribe list, approval; new \"guest visits\" audience"],
            ["Automations", "Workflows: 22 restaurant events and four ready-made templates"],
            ["Assistant", "Eight read-only questions, such as reservations in the next two hours or low ingredients"],
            ["Audit", "The existing tamper-evident audit chain"],
          ],
        },
      ],
    },
    {
      number: "04",
      title: "Safety and Security",
      blocks: [
        {
          type: "bullets",
          items: [
            "No double bookings: a table can be held by only one booking at a time, even when two people book the same table at the same moment. Tested with four simultaneous attempts.",
            "Guest limit: the most guests per time slot is enforced under simultaneous requests; staff can knowingly override it.",
            "Roles: manager, host, service, kitchen and stock, each with only what it needs. Service staff never see guest contact details or staff notes.",
            "Locations: once a company has two or more locations, each person only reaches the locations they are given.",
            "Other companies get \"not found\" for every record, even with a valid id.",
            "Four-eyes: nobody approves their own wastage or stock count; menu prices and allergen information on published items are manager-only.",
            "Public page: shows only name, address, hours and free times; rate-limited; bot trap; a repeated submit is the same booking; guest links are stored as a hash and expire a week after the visit; card details are never taken.",
            "Audit entries for 23 critical actions, including bookings, table changes, price and allergen changes, wastage, stock counts, roster publishing and data exports.",
          ],
        },
      ],
    },
    {
      number: "05",
      title: "Defects Found and Fixed Before Release",
      blocks: [
        {
          type: "bullets",
          items: [
            "Simultaneous bookings could wrongly be told \"fully booked\".",
            "Changing a party's size kept a table that no longer fitted.",
            "Guest profiles, export and erase could reach any CRM contact, not only guests.",
            "A wrong currency such as \"rupees\" was cut to \"RUP\" and accepted.",
            "The Overview kept counts from when the page was opened.",
            "The booking page said a confirmation email was sent even when it was not.",
          ],
        },
      ],
    },
    {
      number: "06",
      title: "Deliberately Not Built",
      blocks: [
        { type: "lead", text: "The SOW listed these as outside the first release. Restaurants keep their existing systems for them." },
        {
          type: "table",
          headers: ["Not built", "What it means today"],
          rows: [
            ["Point-of-sale (till) and sales figures", "No sales or food-cost figures; stock is not reduced when dishes are sold. Stock counts and wastage keep stock accurate"],
            ["Payments and deposits", "No card details are taken anywhere"],
            ["Kitchen display, payroll, loyalty points, delivery apps", "Out of scope"],
            ["Two-way Google or Outlook calendar sync", "Planned"],
          ],
        },
        { type: "note", label: "Sales, later.", text: "After the pilots show which till restaurants use, the cheapest path is a daily sales file upload or a read-only till connection. Either one would switch on food cost and automatic stock reduction." },
      ],
    },
    {
      number: "07",
      title: "Still Open",
      blocks: [
        {
          type: "table",
          headers: ["Item", "Owner"],
          rows: [
            ["Pilot with two or three restaurants (SOW section 28) and adjust defaults from their feedback", "Founder"],
            ["Resend campaign sending domain, webhook and secret, so guest-campaign delivery can be confirmed", "Founder"],
            ["Mobile screens for hosts (today's bookings, floor, waitlist), shipped by over-the-air update", "Later"],
            ["Choose a till system for a read-only connection, after the pilots", "Later"],
            ["Remove or fix the second Vercel project \"inaya-network\", which fails every build (not the live site)", "Founder"],
          ],
        },
        { type: "note", label: "Full detail.", text: "The repository has eight documents in docs/hospitality: audit, architecture, implementation plan, API, permissions, integrations, test report and known limitations, plus the product guide at /docs/products/hospitality-os." },
      ],
    },
  ],
};
