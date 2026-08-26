# Business Operations — Phase 2: CRM

**Built:** August 26, 2026. Phase 2 of the "Inaya Business Operations" SOW — Contacts (unified Lead/Customer records) and Deals (sales pipeline), on top of Phase 1's Tasks foundation.

## Where it lives

- **Schema + indexes:** `src/lib/orgs.js` (`crmContacts`, `crmDeals`)
- **Deal pipeline state machine:** `src/lib/deal-workflow.js` — `DEAL_STAGES`, `transitionDeal()`
- **API:** `src/app/api/orgs/crm/contacts/route.js` + `[contactId]/route.js`, `src/app/api/orgs/crm/deals/route.js` + `[dealId]/route.js` + `[dealId]/transition/route.js` + `[dealId]/activity/route.js`
- **Dashboard:** `crmSummary` field in `src/app/api/orgs/dashboard/route.js`
- **AI tools:** `list_contacts`, `list_deals` in `src/lib/ai-business-tools.js`
- **Web UI:** `src/components/business/CRMView.js` (Contacts / Deals tabs, deals rendered as a 6-column pipeline board), wired into the sidebar
- **Mobile UI:** `inaya-mobile/src/screens/business/CRMScreen.js` + `DealDetailScreen.js`
- **Tests:** `test/crm-workflow.test.mjs`

## Data model

A contact **is** the unified Lead/Customer record — `type` flips from `LEAD` to `CUSTOMER` in place (a single PATCH) rather than the record being recreated, so notes, history, and any deals attached to it survive the conversion:

```
crm_contacts
  _id, orgId, departmentId, type: LEAD|CUSTOMER, name, email, phone, company, notes,
  createdByEmail, createdAt, updatedAt, deletedAt
```

A deal links to a contact and, optionally, an existing `projects` record — that `projectId` field is what completes the SOW's Customer → Deal → Project → Task → Document chain without any new join table:

```
crm_deals
  _id, orgId, departmentId, contactId, projectId (nullable), title, value (nullable),
  status (the pipeline stage), createdByEmail, createdAt, updatedAt, closedAt (nullable), deletedAt
```

## Permission model

Department-level access (`canAccessDepartment`) — the same model Tasks uses, and the option the approved plan flagged as "not blocking Phase 1" but needing a real decision before Phase 2 shipped. No record-level deal-permission grant table in this pass; if sales-data sensitivity beyond department scope becomes a real requirement later, add one mirroring `document_permissions` rather than retrofitting this file.

## Pipeline state machine

```
NEW -> QUALIFIED -> PROPOSAL -> NEGOTIATION   (advance / regress, one step at a time)
Any of the above -> WON | LOST                 (win / lose, from any open stage — a deal can close
                                                 immediately, it doesn't have to reach NEGOTIATION first)
WON | LOST -> NEW                              (reopen — clears closedAt)
```

Every transition is the same atomic `findOneAndUpdate` pattern as every other workflow in this app — a mismatched current stage yields a 409, not a silent double-apply.

## AI integration

`list_contacts` and `list_deals` follow the same structural-enforcement pattern as every other business tool: they only ever read from `ctx.scope.visibleContacts` / `ctx.scope.visibleDeals`, themselves resolved once per chat request from the caller's real department access. "Which leads are in negotiation" and similar SOW-example questions are answerable on day one.

## Verified, not just written

- `node --env-file=.env.local --test test/crm-workflow.test.mjs` — 11/11 tests pass against the real database: every stage transition (including win/lose from an early stage, not only NEGOTIATION), invalid transitions rejected, department-permission enforcement, `org_activity` correctness, and the contact type-flip updating the same record rather than creating a new one.
- `npm run build` — the new routes and `CRMView` compile cleanly in a real production build.
- `npx expo export --platform android` — the new mobile screens bundle cleanly (2024 modules, no errors).

## Explicitly out of scope (this pass)

- No lead-scoring, email integration, or calendar sync.
- No record-level deal permissions beyond department access.
- Deal "value" is a plain number the user enters — no currency conversion, no rollup forecasting beyond the dashboard's simple open-deals-value sum.
