# Government security profile

Code: `src/lib/compliance/governmentProfile.js`, `collectors.js`, screen `ComplianceReadinessView.js` (Government profile tab), route `GET/PUT /api/orgs/compliance/government`. Behind `FEATURE_GOVERNMENT_SECURITY_PROFILE` (default off).

## What it is

A **technical readiness profile**. It is not a certification or an authorization, and no state in it implies one. The screen says so at the top, every label says so, and a test checks that no state label claims certification.

| State | Meaning |
|---|---|
| General | the default |
| Government-ready (technical profile) | a declared target; the screen shows how many technical checks are currently met |
| Government high-readiness (technical profile) | a stricter declared target, same rule |
| Customer-specific authorization (recorded by the customer) | the customer records the agency, reference, date and boundary of an authorization they hold or are pursuing. **Inaya stores it and does not verify it** (`verifiedByInaya: false`) |

Only an owner or admin can change the state. Choosing a state is a declaration; it does not turn red checks green.

## Technical checks (computed live)

Government-ready: audit trail verifies; every active member has a second factor; a data residency policy is recorded; governance or data-loss policies are published; backups run and succeed; a recent recovery test passed; the enhanced audit profile is on.

High-readiness adds: customer-managed encryption keys; the runtime in FIPS mode **with a recorded validation reference**; a secondary site in sync with no failover blockers; device control on; ransomware signals on with no open items; no expired compliance exception; evidence present for every control marked implemented.

A check reports `met`, `not met` or `unknown` (when the facts could not be read), with the detail it looked at. A fresh organization meets few of them; that is the correct answer.

## Enhanced audit (P5)

Under any state other than General, **every document read** through the retrieve route writes an enhanced record into the organization's hash-chained audit trail: user, role, department, object, action, time, device, client address (per policy), result, policy decision, authorization basis, and a reference to the chain. It never contains file content. The write is non-blocking: it can never fail the read it describes. The address policy is `masked` (default, last octet zeroed), `full` or `none`.

## Data labels (P6)

One action adds the labels the organization is missing: Sensitive, Controlled class A (customer-defined), Export-controlled class (customer-defined), Legal Hold, Mission Critical, next to Public, Internal, Confidential and Restricted. Existing labels are never changed. The two customer-defined classes carry neutral names on purpose: the customer defines what they cover, and a label does not by itself mean any legal marking regime is being applied.

## Not provided

FedRAMP, FISMA or ATO authorization, FIPS 140-3 validated cryptography, a government-cloud deployment, or verification of any authorization the customer records.
