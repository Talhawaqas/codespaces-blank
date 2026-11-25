# Manage Orders — live acceptance report (SOW §22.9, deliverable 16)

Run on **25 Nov 2026** against **production** (www.inayanetwork.com, commits 656b0e2 → d300ec6 → 680bf87) in the founder company "Inaya Network", the only company with Manage Orders switched on. Driven through the owner's signed-in browser session against the live API, plus a second real account (SNT Solutions, finance manager) for the cheque approval. Test records are labelled "E2E".

## Results

| # | Check (SOW ref) | Result |
|---|---|---|
| 1 | Not signed in → ops API refused; cron without secret refused (19) | ✅ 401 / 401 |
| 2 | WO create → submit → approve → assign (22.1) | ✅ WO-00001 DRAFT → AWAITING_APPROVAL → READY → ASSIGNED |
| 3 | Parts reserve then consume 2; same request retried (22.1, 19) | ✅ consumed once, retry reported duplicate, reservation released |
| 4 | Job START retried with the same key (22.4) | ✅ recorded once |
| 5 | SUBMIT without checklist / without required photo (6.3) | ✅ refused with the missing steps listed; review item raised |
| 6 | Photo evidence upload + download (10.4) | ✅ after fix #A below (200, image/png) |
| 7 | Overlapping labour (start a second job while one is active) (9.2) | ✅ refused: "Pause WO-00001 first" |
| 8 | Inspection fail → rework → resubmit → pass → close (6.3) | ✅ ASSIGNED → … → CLOSED; labour from events; LABOUR_VARIANCE review item |
| 9 | RO intake, diagnosis, scheduling before approval (7.2–7.3) | ✅ refused until the customer approved |
| 10 | Customer decision without name/method (7.3) | ✅ refused |
| 11 | Change order blocks RESUME until the customer approves (7.3) | ✅ "can't be worked on while it is awaiting approval" |
| 12 | QC pass → completion sign-off → complete → invoice once (7.5) | ✅ PKR 1,700 invoice; second attempt "already has an invoice" (after fix #B) |
| 13 | Asset service history (7.5) | ✅ RO-00001 listed on the asset |
| 14 | Scheduler lane state, dashboard counts (8.4, 17) | ✅ WO-00001 shown PAUSED; open/completed counts correct |
| 15 | Cheque from approved bill; amount in words; one live cheque per bill (11) | ✅ 900001 "Rupees One Hundred Only"; second cheque refused |
| 16 | Writer approves own cheque (11.4) | ✅ refused (segregation) |
| 17 | Approval by a different finance manager (11.2) | ✅ approved by sntsolutionspk@gmail.com |
| 18 | Payee/amount change after approval (11.4) | ✅ approval dropped, back to PENDING_APPROVAL |
| 19 | Alignment test print (11.3) | ✅ layout returned, cheque untouched |
| 20 | Void before issue (11.4) | ✅ VOIDED; no payment recorded |

## Defects found live and fixed

- **#A Photo upload returned 500.** Cause: `S3_COMPAT_ENCRYPTION_KEY` was not set in any Vercel environment (it existed only locally), so the encrypted object store refused every write. This also affected customer-portal attachments and the S3-compatible storage feature in production. Fixed by adding the same key to Vercel production (owner-approved); re-tested live: upload 200, download 200, and an object stored earlier with the local key decrypts.
- **#B Misleading message on a second RO invoice.** Refused correctly but said "Complete the repair…". Fixed in 680bf87 ("This repair order already has an invoice."); re-tested live.

## Phone (device) test — 25 Nov 2026, app v1.3.1 (runtime 1.3.0), Android, technician = SNT Solutions account

| # | Check (SOW ref) | Result |
|---|---|---|
| 21 | Phone registers for notifications on My jobs (10.5) | ✅ registered 21:34 |
| 22 | Manager assigns WO-00003 from the web → lock-screen notification (10.5) | ✅ "New job WO-00003", no customer details |
| 23 | Tap notification opens the job (10.5) | ✅ |
| 24 | Start job from the phone (10.4) | ✅ |
| 25 | Camera photo attached to the photo step (10.4) | ✅ after fix #C |
| 26 | Airplane mode → Pause saved on phone → sent automatically when back online with the phone's time (10.6) | ✅ PAUSE recorded at the tap time |
| 27 | Submit from phone → manager inspection pass → close (6.3) | ✅ WO-00003 CLOSED |
| 28 | Business OS / Inaya Network chooser: Business OS mode shows only Business OS (co-founder request) | ✅ |

### Defects found on the device and fixed
- **#C Camera opened, then the app locked.** The biometric app lock treated the camera as leaving the app. Camera, gallery, file picker and permission dialogs now pause the lock (OTA 3b6c7e85).
- **#D App lost its options after a restart.** The 1.3 build still reported version 1.0.0, so an older 1.0.0 OTA replaced its code. App is now version 1.3.0 with its own update channel (release v1.3.1).
- **#E "Finish these checklist steps" after attaching the photo.** A photo step is now marked done when its photo is attached (103e3f7).
- CI: the APK workflow had been failing (retired Android SDK package; files never committed). Fixed; public download (SDK section) now follows the latest release.

## Test data left in "Inaya Network"

Branch "E2E Test Workshop", product "E2E test part" (8 in stock), WO-00001 (closed), WO-00002 (cancelled), WO-00003 (closed, phone test), RO-00001 (invoiced, PKR 1,700 DRAFT invoice), asset "E2E · Test · E2E-001", expense "E2E test supplier" PKR 100 (approved, unpaid), cheque book Test 900001–900003, cheque 900001 (voided), review items. All labelled E2E; can be archived on request.
