#!/usr/bin/env node
// bin/inaya-migrate.mjs
//
// Local CLI entry point (SOW §4.3: "the local migration agent/CLI must be
// responsible for credential access" -- never the browser). Every
// credential accepted here is read from a flag or, preferably, an
// environment variable -- never logged. See §8.4's explicit test
// requirement ("secrets do not appear in logs") -- this file never
// console.logs a raw credential value, only key IDs/account names where
// that's the normal, non-secret identifier.

import { Command } from "commander";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAwsSource } from "../src/adapters/aws.js";
import { createAzureSource } from "../src/adapters/azure.js";
import { createGcsSource } from "../src/adapters/gcs.js";
import { createInayaDestination } from "../src/destination.js";
import { Manifest } from "../src/manifest.js";
import { runMigration } from "../src/migrate.js";
import { reportMigrationEvent } from "../src/report.js";

const program = new Command();
program
  .name("inaya-migrate")
  .description("Migrate data from AWS S3, Azure Blob, or Google Cloud Storage into Inaya.")
  .version("0.1.0");

program
  .command("migrate")
  .description("Run (or resume) a migration into Inaya. Re-running with the same --manifest resumes automatically -- objects already recorded MIGRATED are skipped.")
  .requiredOption("--source <aws|azure|gcs>", "source cloud provider")
  .option("--source-bucket <name>", "source bucket (AWS/GCS) or container (Azure)")
  .option("--source-prefix <prefix>", "restrict migration to this key prefix/folder", "")
  .option("--source-region <region>", "AWS region (AWS only)")
  .option("--source-endpoint <url>", "override the source endpoint (GCS only; defaults to storage.googleapis.com)")
  .option("--objects <keys>", "comma-separated list of exact object keys to migrate, instead of the whole bucket/prefix")
  .option("--dry-run", "inventory the source only -- no reads or writes", false)
  .requiredOption("--dest-endpoint <url>", "Inaya S3-compatible endpoint, e.g. http://localhost:3000/api/s3")
  .requiredOption("--dest-bucket <name>", "destination bucket on Inaya")
  .option("--manifest <path>", "resume/idempotency ledger path", "./inaya-migration-manifest.jsonl")
  .action(async (opts) => {
    const source = buildSource(opts);
    const destAccessKeyId = process.env.INAYA_ACCESS_KEY_ID;
    const destSecretAccessKey = process.env.INAYA_SECRET_ACCESS_KEY;
    if (!destAccessKeyId || !destSecretAccessKey) {
      console.error("Missing destination credential. Set INAYA_ACCESS_KEY_ID and INAYA_SECRET_ACCESS_KEY.");
      process.exit(1);
    }
    const destination = createInayaDestination({
      endpoint: opts.destEndpoint,
      accessKeyId: destAccessKeyId,
      secretAccessKey: destSecretAccessKey,
      bucket: opts.destBucket,
    });

    if (!opts.dryRun) {
      try {
        await source.assertReachable?.();
      } catch (err) {
        console.error(`Source is not reachable with the given credentials: ${err.message}`);
        process.exit(1);
      }
    }

    const manifestPath = path.resolve(opts.manifest);
    const manifest = await Manifest.load(manifestPath);
    console.log(`Manifest: ${manifestPath} (${manifest.records.size} prior record(s) loaded)`);

    const objectKeys = opts.objects ? opts.objects.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

    const jobId = randomUUID();
    const report = (event, summary) =>
      reportMigrationEvent({ endpoint: opts.destEndpoint, accessKeyId: destAccessKeyId, secretAccessKey: destSecretAccessKey, bucket: opts.destBucket, jobId, event, summary });

    if (!opts.dryRun) await report("STARTED", { source: opts.source, sourceBucket: opts.sourceBucket, destBucket: opts.destBucket });

    let migrated = 0, failed = 0, skipped = 0, inventoried = 0;
    const summary = await runMigration({
      source,
      destination,
      manifest,
      prefix: opts.sourcePrefix,
      objectKeys,
      dryRun: opts.dryRun,
      onEvent: (ev) => {
        switch (ev.type) {
          case "inventory":
            inventoried++;
            console.log(`  [dry-run] ${ev.key} (${ev.sizeBytes ?? "?"} bytes)`);
            break;
          case "skip":
            skipped++;
            console.log(`  SKIP ${ev.key} (${ev.reason})`);
            break;
          case "retry":
            console.log(`  retry ${ev.phase} ${ev.key} (attempt ${ev.attempt}, waiting ${ev.delay}ms): ${ev.error}`);
            break;
          case "migrated":
            migrated++;
            console.log(`  OK   ${ev.sourceKey} (${ev.byteSize} bytes${ev.retries ? `, ${ev.retries} retr${ev.retries === 1 ? "y" : "ies"}` : ""})`);
            break;
          case "failed":
            failed++;
            console.log(`  FAIL ${ev.sourceKey}: ${ev.failureReason}`);
            break;
        }
      },
    });

    console.log("\n--- Migration summary ---");
    if (opts.dryRun) {
      console.log(`Inventoried: ${inventoried} object(s)`);
    } else {
      console.log(`Migrated: ${migrated}  Failed: ${failed}  Skipped (already done): ${skipped}`);
      console.log(`Manifest totals -- MIGRATED: ${summary.MIGRATED}, FAILED: ${summary.FAILED}, total bytes migrated: ${summary.totalBytes}`);
      await report(failed > 0 ? "FAILED" : "COMPLETED", { migrated, failed, skipped, totalBytes: summary.totalBytes });
      if (failed > 0) {
        console.log(`\n${failed} object(s) failed. Re-run the same command to retry them -- succeeded objects are skipped automatically.`);
        process.exitCode = 1;
      }
    }
  });

function buildSource(opts) {
  if (opts.source === "aws") {
    return createAwsSource({
      region: opts.sourceRegion,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
      bucket: opts.sourceBucket,
    });
  }
  if (opts.source === "azure") {
    return createAzureSource({
      accountName: process.env.AZURE_STORAGE_ACCOUNT,
      accountKey: process.env.AZURE_STORAGE_KEY,
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
      container: opts.sourceBucket,
    });
  }
  if (opts.source === "gcs") {
    return createGcsSource({
      hmacAccessId: process.env.GCS_HMAC_ACCESS_ID,
      hmacSecret: process.env.GCS_HMAC_SECRET,
      bucket: opts.sourceBucket,
      endpoint: opts.sourceEndpoint,
    });
  }
  console.error(`Unknown --source "${opts.source}". Expected aws, azure, or gcs.`);
  process.exit(1);
}

program.parseAsync(process.argv);
