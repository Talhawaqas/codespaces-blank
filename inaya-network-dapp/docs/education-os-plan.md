# Education OS: analysis and plan (2026-10-28)

**Who it's for:** small and mid-sized schools, colleges and academies in Pakistan, India, Bangladesh and the UAE.

**Promise:** keep student and guardian personal data, fee payments and documents safe, in one workspace that runs in ERP mode.

## 1. What already exists and is reused

| Need | Existing piece reused | Where |
|---|---|---|
| Lock a module to one business type | `requireVertical()` and `ORG_VERTICALS` | `src/lib/industry-config.js` |
| Org-wide role gates on the member document | Same pattern as `governmentRole` and `legalRole` | `src/lib/orgGates.js` |
| Need-to-know access to one person's record | The `isCitizenRecordAssignee` / `isCareTeamMember` pattern, here by class teacher assignment | `orgGates.js`, `citizen-records.js` |
| Tamper-evident audit | `appendAuditEntry` (hash chain) | `src/lib/auditChain.js` |
| Encrypted document storage | The Documents module: files are encrypted on the device (AES-256-GCM) before upload | `src/lib/orgs.js` `orgDocuments` |
| Server-side field encryption | The AES-256-GCM pattern | `src/lib/integrationCrypto.js` |
| Staff records, leave, payroll inputs | HR module (unchanged) | `hr` |
| General accounting, expenses | Finance module (unchanged) | `finance` |
| ERP layout, launcher, command palette | `erpModules.js` industry tile, `launcher.js`, `navItems.js` | `src/lib/navigation/` |
| AI assistant | `ai-os-router.js` with read-only, prefixed tool sets | `src/lib/ai-*-tools.js` |

**What's missing for schools today:**
- a student and guardian register;
- classes and sections;
- admissions;
- attendance;
- exams and report cards;
- fee structures, fee invoices (challans), concessions, receipts and defaulters;
- a student document checklist;
- read-only links for parents.

## 2. Design decisions

### Vertical and roles
- **Vertical:** `education`. Every API route goes through `requireVertical(orgId, "education")`.
- **Roles:** an `educationRole` on the member, in addition to owner and admin:

| Role | What it covers |
|---|---|
| `principal` | Manages everything in Education OS |
| `admissions` | Office staff: admissions and the student register |
| `accounts` | Fees and payments |
| `teacher` | Attendance and marks for assigned classes only |

  Owners and admins set these roles in the Education OS > Staff roles tab. Earlier verticals had no screen for this.

### Personal data
- **Encrypted fields:** guardian phone, email and address; national identifiers; medical notes. They're encrypted with AES-256-GCM before they reach the database, using `EDUCATION_DATA_KEY`. If that variable isn't set, the key is derived by HKDF from `INTEGRATION_ENCRYPTION_KEY`, under its own label.
- **Not encrypted:** the student's name, date of birth, admission number and class. These stay plain so the register can be searched and duplicates found.

**Who sees what:**

| Role | Access |
|---|---|
| principal, admissions, owner, admin | The full record |
| teacher | Only students in the classes they're assigned to, with identifiers masked and no guardian address |
| accounts | Name, class, guardian name and phone (for fee follow-up), and no medical notes |

**Identifier handling:**
- An Aadhaar number is never stored in full. Only the last 4 digits are kept, in line with Aadhaar masking practice.
- Other identifiers are masked to their last 4 digits in every view except principal and admissions:
  - B-Form and CNIC (Pakistan)
  - Birth Registration Number and NID (Bangladesh)
  - Emirates ID (UAE)
  - Passport

**Audit and data rights:**
- Every opening of a full record is written to the audit chain.
- The principal can export a student's data as JSON.
- The principal can erase a student's personal data. Personal fields are removed, and the fee ledger is kept under an anonymised name, because financial records have to be retained.

### Fees
- **Money format:** amounts are stored as integers in minor units, in the school's currency (PKR, INR, BDT or AED).
- **Generating fee invoices:** the run is idempotent per student, period and fee structure.
- **Concessions:** accounts staff request them and the principal approves. Nobody can approve their own request.
- **Payments:** a payment can't be deleted, only reversed with a recorded reason.
- **Receipts:** each payment gets a sequential receipt number, per school and year.
- **Defaulters:** the list shows the outstanding balance and days overdue.

### Exams
- **Entering marks:** teachers enter marks for their own classes.
- **Publishing:** the principal publishes the results, and published marks are locked.
- **Changing published marks:** the principal amends them with a reason, and the old value is kept.

### Parent links
- **Creating a link:** the principal or accounts staff create a read-only, expiring link for one student. It lasts 30 days by default and 90 days at most.
- **Storage:** only a SHA-256 hash of the token is stored.
- **What the parent sees:** the fee statement, the attendance rate and published results. No identifiers, no medical notes, no address.
- **Logging and revoking:** every view is logged, and a link can be revoked.

### Claims
- **What we don't claim:** compliance with DPDP (India), PDPL (UAE), or Pakistani or Bangladeshi data laws. The copy says "helps you" and lists the features.
- **What isn't built:** online fee collection through a payment gateway. Fees are recorded, not collected online. Gateways can be added later.

## 3. Implementation (all in this round)

1. `industry-config.js`: add `education`.
2. `orgGates.js`: add the education role gates.
3. `orgs.js`: add the collections and indexes.
4. `src/lib/education/*.js`:
   - `crypto`, `access`, `structure`, `students`, `admissions`, `attendance`, `exams`, `fees`, `guardianLinks`, `dashboard`, `audit`, `settings`.
5. API:
   - `src/app/api/orgs/education/[[...path]]/route.js`, a single catch-all locked to the vertical.
   - `src/app/api/education-guardian/[token]/route.js`, public and token-based.
   - The page `src/app/guardian/[token]/page.js`.
6. UI and navigation:
   - `EducationView.js` with ERP sections.
   - Entries in navItems, the ERP module tile, the launcher, the business-type pickers, an icon, and the view title.
7. AI: `ai-education-tools.js`, read-only, wired into `ai-os-router.js`.
8. Tests:
   - access rules, encryption, masking, fees and receipts, concessions;
   - publish lock, parent links;
   - the vertical-lock wiring test.
9. Docs:
   - `saasRoadmap.js` gets Stage 13.
   - The ecosystem PDFs and the complete feature guide are regenerated into `public/documents`.
