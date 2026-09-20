// Inaya Migration Agent — Enterprise Pilot Onboarding Guide.
// Plain-language, step-by-step instructions for a pilot client's IT/ops
// team to move existing data from AWS S3, Azure Blob, or Google Cloud
// Storage into Inaya using the real inaya-migrate CLI. Every flag,
// env var, and command here matches the real, shipped tool
// (inaya-migration-agent/bin/inaya-migrate.mjs) as of this SOW.

export const migrationAgentGuide = {
  cover: {
    company: "INAYA NETWORK",
    classification: "ENTERPRISE PILOT ONBOARDING GUIDE",
    kicker: "DATA MIGRATION",
    title: "Migrate Your Existing Cloud Data to Inaya",
    subtitle: "A step-by-step guide for pilot IT/ops teams: move data from AWS S3, Azure Blob Storage, or Google Cloud Storage into Inaya using the Inaya Migration Agent — a local command-line tool that keeps every credential on your own machine.",
    docLine: "Pilot Guide · Data Migration · September 2026",
  },
  docId: "INAYA-PILOT-MIGRATION-2026",
  sections: [
    {
      number: "01",
      title: "What This Gives You",
      blocks: [
        {
          type: "lead",
          text: "The Inaya Migration Agent is a small command-line tool that runs on your own machine (or a server you control) and copies objects from an existing AWS S3, Azure Blob, or Google Cloud Storage source directly into Inaya. It streams each object through — nothing is written to a third party, and nothing is uploaded to Inaya's web application first. Source and destination credentials both stay local to the tool's own process; Business Workspace and Inaya's browser UI never see them.",
        },
        {
          type: "table",
          headers: ["Property", "Behavior"],
          rows: [
            ["Resumable", "If the tool is interrupted (network drop, closed terminal, power loss), running the exact same command again picks up where it left off — already-migrated objects are skipped automatically, never re-copied or duplicated."],
            ["Verified", "Every object is checked against the destination immediately after upload; a mismatch is recorded as a real failure, never silently ignored."],
            ["Selective", "Migrate an entire bucket, one folder/prefix, or a specific list of object keys — your choice."],
            ["Safe to preview", "A dry-run mode lists exactly what would be migrated without moving or changing anything."],
          ],
        },
        {
          type: "note",
          label: "Where to get the tool.",
          text: "The Migration Agent is not (yet) published to a public package registry — your Inaya technical contact will provide you with the tool's folder directly. It requires Node.js 18 or newer, which you can confirm with `node --version` in a terminal.",
        },
      ],
    },
    {
      number: "02",
      title: "Step 1 — Install the Tool",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "1. Get the inaya-migration-agent folder from your Inaya contact.", body: "Place it anywhere on the machine that will run the migration." },
            { heading: "2. Open a terminal in that folder and install its dependencies.", body: "" },
            { heading: "3. Confirm it runs.", body: "" },
          ],
        },
        {
          type: "code",
          label: "Terminal",
          text: "cd inaya-migration-agent\nnpm install\nnode bin/inaya-migrate.mjs --help",
        },
      ],
    },
    {
      number: "03",
      title: "Step 2 — Get Your Inaya Destination Credentials",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "1. Sign in to Business Workspace.", body: "Open the \"S3-Compatible Storage\" panel from the left navigation." },
            { heading: "2. Click \"+ New S3 credential.\"", body: "Give it a label such as \"migration-agent\" so you can identify it later." },
            { heading: "3. Save the Access Key ID and Secret Access Key immediately.", body: "The secret is shown exactly once and can never be retrieved again — only reissued." },
          ],
        },
        {
          type: "code",
          label: "Terminal — set these once per session",
          text: "export INAYA_ACCESS_KEY_ID=\"<your Inaya Access Key ID>\"\nexport INAYA_SECRET_ACCESS_KEY=\"<your Inaya Secret Access Key>\"",
        },
        {
          type: "note",
          text: "The migration agent always reads your Inaya credential from these two environment variables — never from a command-line flag — so it never appears in your shell history or a process list.",
        },
      ],
    },
    {
      number: "04",
      title: "Step 3A — Migrate from AWS S3",
      blocks: [
        {
          type: "lead",
          text: "Uses your existing AWS credentials — nothing AWS-specific to install beyond what you likely already have.",
        },
        {
          type: "code",
          label: "Terminal",
          text: "export AWS_ACCESS_KEY_ID=\"<your AWS access key>\"\nexport AWS_SECRET_ACCESS_KEY=\"<your AWS secret key>\"\n\nnode bin/inaya-migrate.mjs migrate \\\n  --source aws \\\n  --source-bucket my-existing-bucket \\\n  --source-region us-east-1 \\\n  --dest-endpoint https://<your-inaya-host>/api/s3 \\\n  --dest-bucket my-inaya-bucket",
        },
      ],
    },
    {
      number: "05",
      title: "Step 3B — Migrate from Azure Blob Storage",
      blocks: [
        {
          type: "lead",
          text: "Uses either a storage account name/key pair or a full connection string — whichever you already have on hand.",
        },
        {
          type: "code",
          label: "Terminal — using an account name and key",
          text: "export AZURE_STORAGE_ACCOUNT=\"myaccount\"\nexport AZURE_STORAGE_KEY=\"<your Azure storage account key>\"\n\nnode bin/inaya-migrate.mjs migrate \\\n  --source azure \\\n  --source-bucket my-existing-container \\\n  --dest-endpoint https://<your-inaya-host>/api/s3 \\\n  --dest-bucket my-inaya-bucket",
        },
        {
          type: "note",
          text: "To use a connection string instead, set AZURE_STORAGE_CONNECTION_STRING and omit AZURE_STORAGE_ACCOUNT/AZURE_STORAGE_KEY.",
        },
      ],
    },
    {
      number: "06",
      title: "Step 3C — Migrate from Google Cloud Storage",
      blocks: [
        {
          type: "lead",
          text: "Uses a Google Cloud Storage HMAC key pair (Cloud Console → Cloud Storage → Settings → Interoperability → Create a key for a service account), via Google's own documented S3-compatible XML API path — the same interoperability mode Inaya's own GCS compatibility layer already speaks natively.",
        },
        {
          type: "code",
          label: "Terminal",
          text: "export GCS_HMAC_ACCESS_ID=\"<your GCS HMAC access ID>\"\nexport GCS_HMAC_SECRET=\"<your GCS HMAC secret>\"\n\nnode bin/inaya-migrate.mjs migrate \\\n  --source gcs \\\n  --source-bucket my-existing-gcs-bucket \\\n  --dest-endpoint https://<your-inaya-host>/api/s3 \\\n  --dest-bucket my-inaya-bucket",
        },
      ],
    },
    {
      number: "07",
      title: "Migration Options",
      blocks: [
        {
          type: "bullets",
          items: [
            "<b>Preview first, migrate nothing:</b> add `--dry-run` to any command above to list exactly what would be migrated, with no reads or writes actually performed.",
            "<b>Migrate one folder only:</b> add `--source-prefix documents/2026/` to restrict the migration to that path.",
            "<b>Migrate specific files only:</b> add `--objects file1.txt,folder/file2.pdf` (comma-separated, exact keys) instead of an entire bucket.",
            "<b>Resume after an interruption:</b> simply run the exact same command again. Objects already recorded as migrated are skipped automatically — nothing is re-copied or duplicated.",
          ],
        },
        {
          type: "note",
          label: "What the manifest file is.",
          text: "Each run writes progress to a local file named inaya-migration-manifest.jsonl (in the folder you ran the command from, unless you set --manifest <path>) — this is how resume works, and it's a real, readable record of every object's outcome. Keep it until you've confirmed the migration is complete; deleting it before then would cause a re-run to start over.",
        },
      ],
    },
    {
      number: "08",
      title: "Step 4 — Verify the Migration",
      blocks: [
        {
          type: "numbered",
          items: [
            { heading: "1. Check the terminal summary.", body: "Every run ends with a count of objects migrated, failed, and skipped. Zero failures is the goal — any failure is named individually above the summary." },
            { heading: "2. Re-run the exact same command if anything failed.", body: "Already-succeeded objects are skipped; only the real failures are retried." },
            { heading: "3. Confirm in Business Workspace.", body: "Open the S3-Compatible Storage panel and browse the destination bucket — your migrated objects should be visible there, confirming Inaya's own storage/encryption/redundancy pipeline actually received them, not just a local acknowledgment." },
            { heading: "4. Spot-check a few files.", body: "Download a handful of migrated objects and confirm they open correctly and match the originals." },
          ],
        },
      ],
    },
    {
      number: "09",
      title: "Getting Help",
      blocks: [
        {
          type: "lead",
          text: "During the pilot, route migration questions, unexpected failures, or requests for a different migration mode to your assigned Inaya technical contact rather than general support — pilot feedback is what shapes the general-availability release.",
        },
      ],
    },
  ],
};
