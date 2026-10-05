# Secure Notes: how they are protected

Secure Notes (Competitive Expansion SOW workstream C) store only ciphertext on the server. This page says exactly what is encrypted, what is not, and what the limits are. It is behind `FEATURE_SECURE_NOTES` (default off; an owner or admin can opt an organization in under Settings, Beta features).

## Keys

| Key | Where it lives | Protected by |
|---|---|---|
| Vault key (VK), per user | Browser memory after unlock; wrapped copy on the server | The user's notes passphrase (PBKDF2-SHA256, 310,000 iterations, AES-256-GCM) |
| ECDH P-256 key pair, per user | Public key on the server; private key encrypted on the server | VK |
| Note key, per note and key version | Sealed copy per participant on the server | That participant's public key (ephemeral ECDH + HKDF-SHA256 + AES-256-GCM sealed box, shared with file requests) |
| Private index (pins, favorites, archive, tags, key pins) | Server, one blob per user | VK |

The passphrase is never sent. Inaya cannot recover it. A forgotten passphrase means the notes cannot be opened.

## Revisions

Every save is a full snapshot encrypted under the note key with AAD `noteId:rev:keyVersion`, so the server cannot present one revision as another or reorder history without detection. The newest 200 revisions are kept. Restoring an old version writes it as a new latest version; history is append-only.

## Sharing and removal

The owner seals the note key to each person's public key in their own browser. Participants hold either read or edit access (enforced by the server on writes). Removing a person rotates the note key in one transaction: a new key is sealed to everyone who remains and the next revision is encrypted under it. Someone who leaves on their own sets `rotationDue`, and the owner's browser rotates on next open. Public keys come from the server, so each person's key fingerprint is pinned on first use and a later change is refused until the owner accepts it.

## Conflicts

A save carries the revision it was based on. If the note moved on, the server refuses with `409 CONFLICT` and returns the newer revision; the editor asks which to keep (use theirs, keep mine as newest, or save mine as a separate note). Nothing is overwritten silently.

## What the server can see

Who participates, permission levels, sizes, revision counts and timestamps, and which user created or edited. It cannot see titles, bodies, note types, tags or checklist contents. Search runs in the browser over notes it has decrypted; there is no server-side plaintext search. The audit trail records actions (created, shared, unshared, key rotated, trashed, restored, deleted) with metadata only.

## Honest limits

- Someone who was a participant keeps whatever they already read or copied. Key rotation protects future revisions only.
- A person added to a note can read its whole history.
- A forgotten passphrase is unrecoverable; there is no admin reset.
- A malicious server could try to substitute a participant's public key; pinning and the displayed fingerprint are the defence, and comparing fingerprints out of band is the way to be sure.
- Rich text and Markdown from other people are sanitized or rendered without HTML. Pasting into the editor inserts plain text.
- Notes are limited to about 60 KB of text each. Attachments are not part of notes.
- Trashed notes are removed permanently after 30 days by a nightly job.
