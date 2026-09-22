# @inaya-network/migration-agent

A local command-line tool that migrates existing data from AWS S3, Azure Blob Storage, or
Google Cloud Storage into Inaya. It streams each object through directly — nothing is written
to a third party, and nothing passes through Inaya's browser/web control plane first. Source
and destination credentials both stay local to this process's own environment.

## 1. Installation

```bash
npm install -g @inaya-network/migration-agent
inaya-migrate --help
```

Requires Node.js 18 or newer.

## 2. Get Your Inaya Destination Credentials

1. Sign in to Business Workspace and open the "S3-Compatible Storage" panel.
2. Click "+ New S3 credential" and give it a label such as `migration-agent`.
3. Save the Access Key ID and Secret Access Key immediately — the secret is shown exactly once.

```bash
export INAYA_ACCESS_KEY_ID="<your Inaya Access Key ID>"
export INAYA_SECRET_ACCESS_KEY="<your Inaya Secret Access Key>"
```

The destination credential is always read from these two environment variables — never from a
command-line flag — so it never appears in shell history or a process list.

## 3. Migrate from AWS S3

```bash
export AWS_ACCESS_KEY_ID="<your AWS access key>"
export AWS_SECRET_ACCESS_KEY="<your AWS secret key>"

inaya-migrate migrate \
  --source aws \
  --source-bucket my-existing-bucket \
  --source-region us-east-1 \
  --dest-endpoint https://<your-inaya-host>/api/s3 \
  --dest-bucket my-inaya-bucket
```

## 4. Migrate from Azure Blob Storage

```bash
export AZURE_STORAGE_ACCOUNT="myaccount"
export AZURE_STORAGE_KEY="<your Azure storage account key>"
# Or, instead of the two lines above: export AZURE_STORAGE_CONNECTION_STRING="..."

inaya-migrate migrate \
  --source azure \
  --source-bucket my-existing-container \
  --dest-endpoint https://<your-inaya-host>/api/s3 \
  --dest-bucket my-inaya-bucket
```

## 5. Migrate from Google Cloud Storage

Uses a GCS HMAC key pair (Cloud Console → Cloud Storage → Settings → Interoperability →
Create a key for a service account).

```bash
export GCS_HMAC_ACCESS_ID="<your GCS HMAC access ID>"
export GCS_HMAC_SECRET="<your GCS HMAC secret>"

inaya-migrate migrate \
  --source gcs \
  --source-bucket my-existing-gcs-bucket \
  --dest-endpoint https://<your-inaya-host>/api/s3 \
  --dest-bucket my-inaya-bucket
```

## 6. Options

| Flag | Effect |
|---|---|
| `--dry-run` | Inventory the source only — no reads or writes. |
| `--source-prefix <prefix>` | Restrict the migration to one folder/prefix. |
| `--objects <keys>` | Comma-separated list of exact object keys, instead of the whole bucket/prefix. |
| `--manifest <path>` | Resume/idempotency ledger path (default `./inaya-migration-manifest.jsonl`). |

Re-running the exact same command resumes automatically — objects already recorded as
migrated in the manifest are skipped, never re-copied or duplicated. Keep the manifest file
until you've confirmed a migration is complete; deleting it before then causes a re-run to
start over.

## 7. Verifying a Migration

Every run ends with a count of objects migrated, failed, and skipped — any failure is named
individually above the summary, never silently swallowed. Re-run the same command to retry
only the real failures. Then open Business Workspace's S3-Compatible Storage panel and browse
the destination bucket to confirm the objects actually landed in Inaya's own storage/
encryption/redundancy pipeline, not just a local acknowledgment.

## 8. Known Limitations

- Not (yet) a resumable *interruption-safe* transfer at the byte level — resumability is at the
  per-object granularity (an in-flight object that's interrupted is retried whole on the next
  run, not resumed mid-upload).
- No progress bar / ETA — output is a real-time per-object log plus a final summary.
