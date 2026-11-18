# Company Data Export — Manifest

What the company ZIP contains (`src/lib/licensing/exports.js`, Billing → *Prepare a new export*). Every ZIP also carries `export-manifest.json` listing exactly what was included and not included in that export.

## Included
| Path | Content |
|---|---|
| `README.txt` | what the files are |
| `company.json` | the company record |
| `records/<collection>.json` | every record of the company, one file per kind (all modules and industry editions: CRM, finance, ledger, procurement, inventory, HR, projects, tasks, approvals, documents metadata, templates, settings, activity…), found by scanning every collection for the company's id |
| `files/<bucket>/<key>` | the actual contents of S3-compatible storage: NAS backups, S3 / Azure / GCS uploads, bookkeeping documents, support attachments, generated documents — up to 400 MB per export |
| `documents-encrypted.json` | the list of Documents-module files (name, place, size) |
| `export-manifest.json` | counts, what was included, what was not and why |

## Not included (and why)
| Item | Why | How to get it |
|---|---|---|
| Documents-module file contents | encrypted with the company passkey on the user's device; Inaya cannot read them | Billing → *Download documents* (works while suspended), decrypted in the browser |
| S3/NAS files beyond 400 MB in one export | size limit of one job | listed in the manifest; download with the S3 / Azure tools while active, or ask support |
| Passwords, sign-in tokens, API keys, encryption keys, integration credentials | secrets | never exported |
| Inaya's internal billing notes, admin names, license audit and notice rows | not company data | — |

## Process
Requested by an Owner/Admin (one at a time, up to 5 a day) → built in the background → stored encrypted with the company's server-managed key → downloadable by that company's Owners/Admins for **7 days** through an authenticated route (no public link) → then deleted. Requests, completions, failures and downloads are audited. Available while active, in grace, suspended and cancelled.

The older quick download (`/api/orgs/export-zip`, records only, synchronous) remains available as *Download records now*.
