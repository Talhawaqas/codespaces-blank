# Microsoft 365, Office and Outlook

Code: `src/lib/integrations/office.js`, routes `src/app/api/orgs/office/` and `src/app/api/office/sessions/`, screen `OfficeIntegrationView.js`, add-in `public/outlook/`. Edit sessions and Outlook links sit behind `FEATURE_ADVANCED_SHARING`.

## Principle: sovereign by default

Documents are encrypted in the person's browser or desktop app, so the server holds no plaintext and cannot give any to Microsoft. This integration therefore **never sends file content to Microsoft**, and does not offer editing in Office on the web (which would need plaintext on Microsoft's servers).

## Edit in Word, Excel and PowerPoint

1. The person needs **Edit** access. A **session** takes the existing file lock (a lease) and returns a short-lived **edit token**, shown once; only its hash is stored. The file must be the latest version and an Office type (docx, doc, xlsx, xls, pptx, ppt).
2. The desktop client fetches the encrypted pointers (`GET .../content`, recorded), decrypts locally, and opens the file with the Office launch URI (`ms-word:ofe|u|...`).
3. On save the client re-encrypts and writes a **new version** through the existing versions route.
4. The client calls `finish` with that version's id. Inaya accepts it only if the version exists, was written by the same person during the session, is in the same document group and is **directly after** the base version. Then the lock is released and the audit chain records the edit.
5. `renew` extends the lease (up to eight hours); `abort` releases the lock and writes nothing. Expired sessions are marked expired.

The token authorizes one session and nothing else. A different session's token, a wrong token and a missing token are refused.

## Outlook

* The add-in (`manifest.xml`, `taskpane.html`, `taskpane.js`) lets a person find an Inaya file, set expiry, an optional password and optional domains, and insert a block into the message.
* The link is made by the existing sharing engine, so every sharing policy and data-loss rule applies, and **Manage** access is required.
* The block states the expiry and reminders, and says that a password is shared separately. **The password is never written into the message or the audit trail.** All text is escaped.
* People can list the links they inserted, revoke them, and inspect any pasted link. Inspection never reveals the token or the file name.
* Attachments are **not** converted automatically: a conversion would need the file encrypted and uploaded from inside Outlook, which the add-in does not do. Upload the file to Inaya first.
* The task pane is allowed to be framed only by Microsoft's Office hosts (see `next.config.mjs`).

## Microsoft Graph

The existing Microsoft connection (Entra ID, Microsoft 365, Outlook, SharePoint) is read for its real state. Graph is for identity and metadata only. If the platform has no Microsoft app registration, those capabilities show **NOT CONFIGURED** rather than being claimed.

## Verification status

Tested against the real database, locking, versioning and sharing engines, and the real HTTP handlers. **Not exercised against a live Microsoft 365 tenant, a real Outlook client, or a desktop client that decrypts and launches Office** (the desktop app has not been updated to use edit sessions).
