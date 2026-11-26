---
slug: inaya-connect
title: "Inaya Connect (WhatsApp Business & AI Gateway)"
description: "Connect your company's own WhatsApp Business number to Inaya Business OS: one shared inbox, a business assistant for staff, an optional customer assistant, and bills and files sent on WhatsApp landing in the right place. Included in the Business and Enterprise plans."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [business-admin, operations, finance, support]
status: live
version: current
tags: [whatsapp, whatsapp business, inbox, chat, messages, business assistant, customer assistant, bills, receipts, ai bookkeeper, documents, meta, cloud api]
lastVerifiedAt: "2026-11-26"
relatedDocs: [business-workspace, ai-bookkeeper, customer-portal]
---

## What it is

Inaya Connect plugs your company's **own WhatsApp Business number** into Inaya Business OS. It uses Meta's official WhatsApp Cloud API, so there is no WhatsApp Web automation and no shared number. Meta bills your WhatsApp Business Account directly.

It does four things:

- **Business assistant for your team**: staff link their phone once, then ask in plain words, for example "How much did we sell today?", "Stock of item X at my branch" or "Status of WO-00012". Answers come from your own data and follow each person's permissions and branches. WhatsApp is read-only: approvals, payments, refunds and price or stock changes stay inside Inaya.
- **Documents on WhatsApp**: bills, invoices and receipts go to **AI Bookkeeper** as drafts for review. They are recognised from the caption, or by AI from the image itself. Nothing is approved or paid automatically. Any other file is saved in the dated **Inaya Connect** folder, and the sender gets an email with the exact location and an "Open the file" link.
- **One team inbox**: every customer chat appears in Inaya. Your team can reply, take over from the assistant or resume it, assign, add internal notes, close, and turn a chat into a Support Desk ticket.
- **Customer assistant (optional, off by default)**: answers from your published help articles. A customer's own orders, repairs, appointments and invoices are shared only after a 6-digit code sent to the email in your customer records. Complaints, payments and disputes go to a person.

Inaya Connect is included in the **Business** and **Enterprise** plans.

## Set up (about 20–30 minutes)

You do every step in **your own** Meta account. Inaya's team can guide you on a call, but never needs your Facebook password or Meta admin access, and you should never share them. The same checklist is on **Inaya Connect › Connection**.

1. **Meta business portfolio**: at business.facebook.com, use your company's portfolio or create one.
2. **Create a Meta app**: developers.facebook.com › My Apps › Create app. Choose the use case "Connect with customers through WhatsApp" and link it to your portfolio.
3. **Copy two IDs**: in the app, open Customize › Step 1. Try it out and copy the **Phone number ID** and the **WhatsApp Business Account ID**. You can start with Meta's free test number. A number still used in the WhatsApp app must be removed from it before it can be added.
4. **Copy the App secret**: App settings › Basic › App secret.
5. **Create a never-expiring access key**: business.facebook.com › Settings › System users › Add (Admin). Assign your app and WhatsApp account with Full control, then generate a token with expiry **Never** and the permissions `whatsapp_business_messaging` and `whatsapp_business_management`. Keys from the app's API Setup page expire within a day, so don't use those.
6. **Connect in Inaya**: on Inaya Connect › Connection, paste the four values and click Connect. They are checked with Meta and stored encrypted; nobody can read them again.
7. **Point Meta to Inaya**: in the app, open Configure Webhooks. Paste the Callback URL and Verify token that Inaya shows, then Verify and save and subscribe the **messages** field.
8. **Test**: "Linked to Meta app" shows Yes. Send "Hello" from your phone; it appears in the Inbox.

Before going live with your real number at full volume, Meta asks for Business Verification with your company documents.

## Linking a staff phone

On **Inaya Connect › My WhatsApp**, click **Get my link code**. On a phone, tap **Open WhatsApp** and press Send. From a computer, scan the QR code. You'll get "Linked". If a phone is lost, an admin unlinks it in one click.

## Where files go

| You send | What happens |
|---|---|
| A bill, invoice or receipt | Sent to AI Bookkeeper as a draft for review, with a reference number on WhatsApp |
| Any other file | Saved in `Inaya Connect/<year-month>/`, with a reference on WhatsApp and an email with the path and link |
| A file from an unknown number, or one that fails the virus check | Quarantined and never opened |

Find files under **Inaya Connect › My files**. Admins see every file under **Documents**, where they can also send a file to Bookkeeper, mark it as filed, or reject it. Sending the same file twice is recognised and it's stored only once.

## Settings and costs

- **Settings** (owners and admins): switch the business assistant, customer assistant and file intake on or off. You can also set the greeting and after-hours text, business hours, approved supplier numbers, a monthly sending limit and a per-sender hourly limit.
- **Usage & activity**: messages received and sent this month, Meta-billable messages with a cost estimate, and an activity log that doesn't include message content.
- **Costs**: replies to customers within 24 hours of their last message are service messages. Meta currently includes 1,000 free service messages per number per month. Messages your business starts first (templates) are charged per message. Inaya shows an estimate; Meta's invoice is final.
- **The 24-hour rule**: after 24 hours, WhatsApp allows only pre-approved template messages until the customer writes again. Inaya tells you when this applies.

## Security

- **Every event is checked.** It must carry a valid Meta signature for your number; anything else is rejected and logged. Companies never see each other's messages.
- **Your keys stay locked away.** Meta keys are encrypted and never shown again. Disconnecting stops everything and deletes them.
- **The assistants are protected.** They run through Inaya's AI security gateway, with manipulation screening, personal-data redaction and rate limits.
- **STOP opts out.** A customer who sends STOP gets no more messages until they send START.

## Not in this release

- One-click "Connect WhatsApp" sign-up. This needs Inaya to become a Meta Tech Provider; until then, setup is guided.
- Proactive alerts sent as WhatsApp template messages.
