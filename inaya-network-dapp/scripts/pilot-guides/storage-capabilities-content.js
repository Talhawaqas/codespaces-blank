// Advanced Enterprise Storage Capabilities — Enterprise Pilot Onboarding
// Guide. Plain-language, step-by-step instructions for a pilot client's
// admin team: scoped credentials, versioning, locked/compliant retention,
// legal hold, lifecycle policies, storage health, and the Windows drive
// mount. Every button label and behavior named here matches the real,
// shipped Business Workspace UI as of this SOW.

export const storageCapabilitiesGuide = {
  cover: {
    company: "INAYA NETWORK",
    classification: "ENTERPRISE PILOT ONBOARDING GUIDE",
    kicker: "ADVANCED ENTERPRISE STORAGE CAPABILITIES",
    title: "Govern Your Storage Like an Enterprise",
    subtitle: "A step-by-step guide for pilot admins: scoped access credentials, version history, compliance-grade locked retention, legal hold, automated lifecycle policies, and a native desktop drive.",
    docLine: "Pilot Guide · Advanced Enterprise Storage Capabilities · September 2026",
  },
  docId: "INAYA-PILOT-STORAGE-GOV-2026",
  sections: [
    {
      number: "01",
      title: "What This Gives You",
      blocks: [
        {
          type: "lead",
          text: "Beyond basic upload/download, Inaya's storage layer includes the controls enterprise IT and compliance teams expect: who can access what and for how long, the ability to recover an overwritten file, storage that genuinely cannot be deleted during a retention period, legal holds for litigation/investigation, automatic cleanup policies, and a real drive-letter view of your storage on Windows. This guide walks through each one, in Business Workspace, step by step.",
        },
        {
          type: "table",
          headers: ["Capability", "Where to find it"],
          rows: [
            ["Scoped access credentials", "Business Workspace → S3-Compatible Storage"],
            ["Versioning, locked retention, legal hold, lifecycle, health", "Business Workspace → S3-Compatible Storage → Buckets, Versions & Object Protection"],
            ["Desktop drive mount", "Inaya Business Workspace desktop app (Windows)"],
          ],
        },
      ],
    },
    {
      number: "02",
      title: "Scoped Access Credentials",
      blocks: [
        {
          type: "lead",
          text: "Instead of every integration or team member holding a full-access credential, issue one scoped to exactly what it needs.",
        },
        {
          type: "numbered",
          items: [
            { heading: "1. Go to S3-Compatible Storage → \"Restrict scope.\"", body: "Click this before creating a new credential." },
            { heading: "2. Set a bucket.", body: "Confines the credential to one bucket only, e.g. \"finance.\"" },
            { heading: "3. (Optional) Set a prefix.", body: "Further confines it to a folder path within that bucket, e.g. \"invoices/2026/.\" Requires a bucket to already be set." },
            { heading: "4. Choose operations.", body: "Toggle any combination of READ, WRITE, DELETE, LIST. A credential with only READ selected can never write or delete, even if the raw credential is compromised." },
            { heading: "5. Set an expiry date.", body: "The credential automatically stops working after this date — no manual revocation needed for time-boxed engagements (a contractor, a fixed-term integration)." },
          ],
        },
        {
          type: "note",
          label: "Example.",
          text: "\"Give the accounts-payable system read-only access to finance/invoices/2026/ for the next 90 days\" is one credential, configured with all four fields above — enforced by Inaya's server on every request, not just hidden by the UI.",
        },
      ],
    },
    {
      number: "03",
      title: "Version History & Restore",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "1. Open \"Buckets, Versions & Object Protection.\"", body: "Find the bucket you want version history for." },
            { heading: "2. Click \"Enable versioning.\"", body: "From this point forward, overwriting a file keeps the previous version instead of discarding it. Files uploaded before this point are not retroactively versioned." },
            { heading: "3. Click an object to see its version history.", body: "Every version is listed with its date, and whether it's the current (\"latest\") one." },
            { heading: "4. Click \"Restore\" on any older version.", body: "This makes that version's content the new current version — the file reverts, and the restore itself becomes a new entry in the version history." },
          ],
        },
        {
          type: "note",
          text: "Versioning can be suspended later (new overwrites stop keeping history), but every version already kept remains retrievable — nothing already protected is ever silently lost by suspending.",
        },
      ],
    },
    {
      number: "04",
      title: "Locked Retention (Compliance Hold)",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "1. Enable versioning on the bucket first.", body: "Locked retention requires versioning to already be on — this is enforced, not just recommended." },
            { heading: "2. Click \"Enable Object Lock.\"", body: "Turns on locked-retention support for this bucket." },
            { heading: "3. Open the object's version list, click \"Lock.\"", body: "Enter how many days to retain it for. The object cannot be deleted or overwritten until that date, by anyone — including through a direct API call, not just the Business Workspace interface." },
          ],
        },
        {
          type: "note",
          label: "Important.",
          text: "A retention period can be extended later but never shortened — this is deliberate: a lock a compliance team is relying on can't be quietly weakened by anyone with UI access.",
        },
      ],
    },
    {
      number: "05",
      title: "Legal Hold",
      blocks: [
        {
          type: "lead",
          text: "Separate from locked retention — a legal hold blocks deletion indefinitely, with no expiry date, until someone explicitly releases it. Use this for litigation holds and active investigations.",
        },
        {
          type: "numbered",
          items: [
            { heading: "1. Open the object's version list.", body: "Click \"Legal hold.\"" },
            { heading: "2. The object is now protected.", body: "Deletion and overwrite are both blocked — again enforced server-side, not just in the interface." },
            { heading: "3. Click \"Release hold\" when the hold is no longer needed.", body: "The object becomes deletable again (subject to any separate locked-retention period still in effect)." },
          ],
        },
      ],
    },
    {
      number: "06",
      title: "Automatic Lifecycle Policies",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "1. Open a bucket's section in \"Buckets, Versions & Object Protection.\"", body: "Find the \"Lifecycle: expire after ___ days\" field." },
            { heading: "2. Enter a number of days.", body: "Objects in this bucket older than that are automatically cleaned up. Leave it blank to disable the policy." },
            { heading: "3. Click \"Run lifecycle enforcement now\" to apply it immediately.", body: "Otherwise it runs on Inaya's own regular schedule." },
          ],
        },
        {
          type: "note",
          label: "Safety guarantee.",
          text: "A locked (retention) or legal-held object is never auto-deleted by a lifecycle policy, even past its expiration day — protection always wins over automatic cleanup.",
        },
      ],
    },
    {
      number: "07",
      title: "Storage Health",
      blocks: [
        {
          type: "lead",
          text: "Click any object in \"Buckets, Versions & Object Protection\" to see its real redundancy status — how many independent copies of each half of the encrypted, sharded file currently exist, and its overall health state. This is live telemetry, not a static label.",
        },
      ],
    },
    {
      number: "08",
      title: "Inaya Drive — A Real Drive Letter (Windows)",
      blocks: [
        {
          type: "lead",
          text: "Inside the Inaya Business Workspace desktop app, mount your storage as an ordinary Windows drive letter — browse, open, and save files directly, the same way you would with any local or network drive.",
        },
        {
          type: "numbered",
          items: [
            { heading: "1. Issue (or reuse) an S3-compatible credential.", body: "See Section 02 — a scoped credential works here too, e.g. a read-only drive limited to one bucket." },
            { heading: "2. Open the \"Inaya Drive\" panel in the desktop app.", body: "Enter the Access Key ID, Secret Access Key, and a drive letter (e.g. \"I:\")." },
            { heading: "3. Click \"Mount.\"", body: "The drive appears in File Explorer within a few seconds." },
            { heading: "4. Use it like any other drive.", body: "Open, edit and save files directly, drag-and-drop uploads, delete files — every change is written straight through to Inaya's real storage." },
            { heading: "5. Click \"Unmount\" when finished.", body: "Or simply close the desktop app." },
          ],
        },
        {
          type: "note",
          label: "Known limitation.",
          text: "Creating a brand-new empty folder isn't supported yet — a folder appears automatically as soon as you save a file inside that path, the same behavior as other cloud-drive tools. Available on Windows for this pilot; macOS/Linux support is planned.",
        },
      ],
    },
    {
      number: "09",
      title: "Everything Is Audited",
      blocks: [
        {
          type: "bullets",
          items: [
            "Credential creation and revocation",
            "Every object upload, download, and delete",
            "Version restores",
            "Locked-retention and legal-hold changes",
            "Lifecycle policy changes and every automatic expiration",
          ],
        },
        {
          type: "note",
          text: "All of the above write to your organization's own audit trail, visible to your admins — not just asserted, independently checkable.",
        },
      ],
    },
    {
      number: "10",
      title: "Getting Help",
      blocks: [
        {
          type: "lead",
          text: "During the pilot, route questions about scope configuration, retention/legal-hold behavior, or the desktop drive to your assigned Inaya technical contact — pilot feedback directly shapes the general-availability release.",
        },
      ],
    },
  ],
};
