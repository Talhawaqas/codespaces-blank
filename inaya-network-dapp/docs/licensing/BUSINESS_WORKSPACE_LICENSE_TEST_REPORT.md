# Business Workspace License Manager — Test Report (17 Nov 2026)

All tests ran against the **test database** (`TEST_MONGODB_URI`), never the live one. Run the license suites with:

```
npm run test:one -- --test-concurrency=1 test/license-dates.test.mjs test/license-lifecycle.test.mjs test/license-grace-edges.test.mjs test/license-migration.test.mjs test/license-route-coverage.test.mjs
```

## License suites (24 tests, all pass)
| Suite | Tests | Covers |
|---|---|---|
| `test/license-dates.test.mjs` | 6 / 6 | billing-day anchors and month-end clamping, 29 Feb yearly renewals, due at end of day PKT, grace ends 14 days later, countdown, state at every boundary, state machine refuses illegal moves |
| `test/license-lifecycle.test.mjs` | 9 / 9 | assignment and bad input; payments (pending, confirm, idempotent, reused reference refused); yearly renewal; grace with a daily e-mail + in-app reminder and no duplicates, suspension at the deadline; the gate while suspended; recovery without a free period; reversal, plan/cycle change, extension, manual suspension, override, cancellation; company data export; admin list and a four-sheet workbook with formula injection neutralised |
| `test/license-grace-edges.test.mjs` | 4 / 4 | payment just before the suspension run, grace extension (reason required, max 30 days), dry run with automatic suspension off, failed notices retried once |
| `test/license-migration.test.mjs` | 2 / 2 | adopting a pre-license paid subscription (no payment inferred), bulk assignment preview and per-row idempotent assigning |
| `test/license-route-coverage.test.mjs` | 3 / 3 | no ungated route to company data (946 routes: 634 member-gated, 74 license-gated, 13 justified exemptions, 0 to review); shared helpers really call the gate; only Billing, license, export, document download and session stay open |

## Browser walkthrough
All 12 SOW steps were exercised in a production build against the test database (`scripts/sqa/start-testdb-walkthrough.mjs`): assignment, payment recording and confirmation, grace banner countdown, suspension, the restricted workspace, data export while suspended, API blocking (including AI routes), reactivation, the admin dashboard filters and the Excel export (opened and checked).

## Full regression
2,426 tests: 2,398 passed on the first run. The 14 failures and 2 cancellations were all re-run on their own:

| File | Isolated result | Cause of the first failure |
|---|---|---|
| performance | 3 / 3 | timing under full-suite load |
| file-requests | 13 / 13 | rate limit (429) under full-suite load |
| rag-retrieval | 5 / 5 | full-suite load |
| ml-studio-execution | 5 / 5 | sandbox token (`VERCEL_OIDC_TOKEN`) expired; passes with a fresh token |
| nas-protection | 45 / 45 | needs the NAS appliance VM (run on the fresh WSL VM) |
| protection-defaults (new) | 3 / 3 | new file, run on the NAS appliance VM |

No failure was caused by the license changes.

## Production build
`NEXT_DIST_DIR=.next-prod npx next build` passed after all license, hero and protection-default changes: 477 pages generated, exit code 0.

## Not covered automatically
- Real email delivery of license notices (tests use a recording sender; production uses Resend).
- Automatic suspension is **on** in production (`LICENSE_AUTO_SUSPEND=on`, founder approved 17 Nov 2026). Companies without a license are not affected.
