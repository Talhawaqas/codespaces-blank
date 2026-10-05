# Secure viewer and Data Room 2.0: what is and is not protected

The secure viewer (`src/components/viewer/SecureViewer.js`) and Data Room 2.0 (`src/lib/dataroom/vdr2.js`) are behind `FEATURE_DRM_VIEWER` and `FEATURE_DATA_ROOM_V2` (default off; an owner or admin opts an organization in under Settings, Beta features).

## The honest guarantee

A web page cannot stop a photograph of the screen, an operating-system screenshot or screen recording, or a person who holds the decryption passkey from saving what they decrypted. The viewer says this on screen. What it actually enforces:

| Control | What it does | What it does not do |
|---|---|---|
| View-only mode | No download control, Ctrl+S and Ctrl+P suppressed, printing hidden by CSS, context menu blocked | Cannot stop someone who has the passkey from decrypting the file elsewhere |
| Restricted mode | Everything above, plus no selection, copy or cut, and the content is blurred while the window is not in focus | Cannot stop a camera or OS-level capture |
| Watermark | Viewer email, organization and time tiled over the content; restored if the element is removed or hidden | A cropped or re-typed copy defeats it |
| Session expiry | The document is cleared from the page when the access session ends; the server stops serving ciphertext when the short per-open view expires | Cannot recall what was already seen |
| Capture signals | Print attempts, the PrintScreen key, window blur, copy and download clicks are reported and logged | Signals are best effort and can be bypassed; they are not proof |
| Revocation | A revoked visitor or link stops working immediately, including open views | Cannot recall downloaded or already decrypted content |

## No plaintext on the server

Documents are decrypted only in the viewer's browser with the document passkey, which is never sent to Inaya. The server relays encrypted shards through a short per-open view (30 minutes at most, never beyond the session) and never returns a storage address to a visitor. There is no server-side plaintext copy, thumbnail or preview cache.

## Viewer formats

PDF (pdf.js, canvas rendering), images (PNG, JPEG, GIF, WebP, BMP, AVIF), plain text and code, Markdown (rendered to elements, no HTML), CSV, Word `.docx` (mammoth, sanitized with an allowlist), Excel `.xlsx` (first 1000 rows per sheet), and DICOM with uncompressed little-endian pixel data (window and level controls; patient name hidden until requested). Compressed DICOM transfer syntaxes, legacy `.doc` and `.xls`, and other formats show "cannot be previewed". The DICOM view is a viewing aid and is not a clinically validated viewer.

## Data Room 2.0

Per-section visitor access (an invitation carries the sections the person may see), viewer or downloader role, per-document view-only or download, document locks and final-version pinning (a final or locked document cannot be moved, replaced or removed), version replacement by explicit action, network restriction by room and by invitation, first-device binding, an NDA gate with custom text, batch and group invitations capped by the room's maximum access time, private questions and answers, room health with warnings, an activity timeline, revocation, and an evidence package that extends the existing export with the v2 settings, document controls and visitor scopes (no question text, no content). DLP rules apply when a visitor opens a document (action `preview` or `share_download`, share type `room`).

Rooms that never opt in behave exactly as before; the older visitor routes are unchanged.

## Honest limits

- The visitor must be given the document passkey separately. Anyone with it can keep a decrypted copy.
- The IPFS gateways are third-party infrastructure; a shard can be briefly unavailable and the viewer then says to try again.
- Excel and Word rendering is a reading aid, not a layout-faithful reproduction; macros are never executed.
