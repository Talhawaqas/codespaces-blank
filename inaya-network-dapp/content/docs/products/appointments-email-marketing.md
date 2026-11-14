---
slug: appointments-email-marketing
title: "Appointments & Email Marketing"
description: "A public booking page, team calendars, reminders and Google/Outlook sync, plus approved email campaigns and follow-up sequences to your CRM contacts. Included in the Business and Enterprise packages."
product: Business Workspace
category: guide
contentType: Product Guide
audience: [business-admin, sales, marketing, operations]
status: live
version: current
tags: [appointments, booking, calendar, scheduling, reminders, google calendar, outlook, ics, email marketing, campaigns, newsletter, segments, unsubscribe, crm]
lastVerifiedAt: "2026-11-14"
relatedDocs: [business-workspace, ai-business-operations-manager, customer-portal]
---

## What it is

Two connected modules in the Business Workspace, both built on the CRM:

- **Appointments**: customers book time with your team on your own booking page; your team runs its day from one calendar.
- **Email Campaigns**: newsletters, offers, re-engagement and event invitations to CRM contacts, with approvals, scheduling and reports, plus automatic follow-up sequences.

Together they cover the whole journey: an enquiry becomes a CRM lead and gets a welcome email, the customer books, the team member is notified, a reminder goes out, the meeting outcome is written to the CRM record, and a follow-up sequence starts.

Both are included in the **Business** and **Enterprise** packages. Business includes 50,000 marketing emails a month and Enterprise 250,000.

## Appointments

### Set up

1. **My availability**: choose your time zone, add working hours for each weekday, and add any time off. Everyone keeps their own calendar.
2. **Setup → Appointment types → New type**: start from a use case (patient visit, legal consultation, financial advisory, parent meeting, sales meeting) and set the length, the gaps before and after, minimum notice, how far ahead people can book, a daily limit, the location (Inaya Meet, another video link, phone or in person), who takes it, and any questions for the customer.
3. **Setup → Booking pages → New page**: choose the address (`/book/your-name`), the types to offer, whether to show an enquiry form, and whether customers may pick who they meet.
4. **Setup → Reminders & settings**: reminder times (default 24 hours and 1 hour before), the welcome email for enquiries, and an optional follow-up sequence after completed meetings.

### What customers see

Customers pick a service and a time shown in their own time zone, enter their details, and get a confirmation email with a calendar invite and a private link to **reschedule or cancel** without an account. The link changes whenever the appointment moves, so an old email can't change it. Two customers can never book the same slot.

### Running your day

- **Overview**: total appointments, completed, upcoming today and customers engaged (each compared with the previous period), the upcoming list with **Join** buttons, calendar-sync status and the booking completion rate.
- **Calendar**: day, week and month views for yourself, the whole team (calendar managers) or a department.
- **Appointment details**: confirm, reschedule, cancel, mark completed or no-show, add private notes (encrypted) and attach files from Documents. Marking it **completed** writes the meeting and its outcome to the customer's CRM record.

### Google Calendar and Outlook

No paid API or app approval is needed.

- **Your appointments in your calendar app**: *My availability → Create calendar address*, then add it in Google Calendar (*Other calendars → From URL*) or Outlook (*Add calendar → Subscribe from web*). Keep the address private. Calendar apps refresh subscribed calendars on their own schedule, so a new booking can take a few hours to appear.
- **Block times you're busy elsewhere**: paste your calendar's secret iCal address (Google: *Settings → your calendar → Integrate calendar → Secret address in iCal format*; Outlook: *Settings → Calendar → Shared calendars → Publish a calendar → ICS link*). Inaya reads only busy times, never titles or guests, every 15 minutes.

## Email Campaigns

### Roles

Owners and admins are marketing managers. They can make other people **editors** (build and submit), **approvers** (approve or send back) or **managers** (both, plus settings). By default a second person must approve every campaign and sequence.

### Building a campaign

1. **Design**: start from a starter template (newsletter, promotional, re-engagement, product update, event invitation) or your own, and edit the blocks: heading, text, button, image, two columns, divider. Personalise with fields such as `{{first_name|there}}` (the text after the bar is the fallback).
2. **Audience**: choose a saved segment or build one from the CRM: leads or customers, department, company, email domain, recently added, inactive for a number of days, booked or never booked, opted in only.
3. **Review**: a checklist, a preview as a real recipient would see it, and test sends to colleagues.
4. **Send**: as soon as it's approved, at a set time, or repeating daily, weekly or monthly. Optionally add recipients to a follow-up sequence afterwards.

Any change after submission sends the campaign back for approval, so what goes out is exactly what was approved.

### Follow-up sequences

A series of emails sent on a delay after someone is added, by a workflow, after a completed meeting, after a campaign, or by hand. People leave automatically when they unsubscribe, bounce, report spam, or (optionally) book an appointment.

### Unsubscribes and deliverability

Every marketing email carries a one-click unsubscribe (understood by Gmail and Outlook), an unsubscribe link and your postal address. Unsubscribes, hard bounces and spam complaints go on the do-not-email list automatically and are never emailed again; staff can't undo an unsubscribe. Marketing email goes out from a separate sending domain, so it can't affect sign-in or booking email.

### Reports

Delivered, opened, clicked, bounced, unsubscribed and spam reports per campaign, top links, and opens by hour. The overview compares results with the targets of a 25% open rate and a 5% click-through rate. Opens are measured with a tracking image that some mail apps load automatically or block, so clicks are the more exact signal.

## Automations, API and AI

- **Automations**: the *Add to follow-up email sequence* step, and two templates: *Enquiry → Nurture Emails* and *After-Meeting Follow-up Campaign*.
- **API**: appointments, appointment types and free slots, campaigns and reports, sequence enrolment, enquiries and the do-not-email list. See the [API reference](/docs/api).
- **AI Assistant**: ask "what's on my calendar tomorrow", "any new enquiries" or "how did the newsletter do".
- **Mobile**: the Appointments screen (overview, agenda, confirm, complete, cancel) and Email campaigns (results and approvals).

## Current limits

- Campaign sending starts once the marketing sending domain is connected.
- SMS reminders are built but switched off until an SMS provider is connected; reminders go by email.
- Booking pages are in English.
