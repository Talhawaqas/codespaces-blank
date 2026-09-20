// src/migrate.js
//
// Orchestrates one migration run: enumerate the source, skip anything the
// manifest already recorded as MIGRATED (SOW §4.8 idempotency/resume),
// stream each remaining object into Inaya with retry+backoff (§4.9
// failure handling), verify it landed with the right byte size (§4.7
// integrity), and record a full result row either way.

import { OBJECT_STATUS } from "./manifest.js";

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, { maxRetries = DEFAULT_MAX_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS, onRetry } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}

/**
 * @param {object} opts
 * @param {object} opts.source - one of the adapters in src/adapters/*.js
 * @param {object} opts.destination - createInayaDestination() result
 * @param {import('./manifest.js').Manifest} opts.manifest
 * @param {string} [opts.prefix] - restrict to this key prefix (SOW §4.6 selected prefix/folder migration)
 * @param {string[]} [opts.objectKeys] - restrict to exactly these keys (§4.6 selected object migration)
 * @param {boolean} [opts.dryRun] - inventory only, no reads or writes (§4.6 dry-run inventory mode)
 * @param {(event: object) => void} [opts.onEvent] - progress callback, called once per object plus a final "summary" event
 */
export async function runMigration({ source, destination, manifest, prefix = "", objectKeys, dryRun = false, onEvent = () => {} }) {
  if (!dryRun) await destination.ensureBucket();

  const candidates = objectKeys
    ? (async function* () {
        for (const key of objectKeys) yield { key };
      })()
    : source.listObjects({ prefix });

  let seen = 0;
  for await (const entry of candidates) {
    seen++;
    const { key } = entry;

    if (manifest.isDone(key)) {
      onEvent({ type: "skip", key, reason: "already-migrated" });
      continue;
    }

    if (dryRun) {
      onEvent({ type: "inventory", key, sizeBytes: entry.sizeBytes });
      continue;
    }

    const startedAt = new Date().toISOString();
    let retries = 0;
    try {
      const obj = await withRetry(() => source.getObject({ key }), {
        onRetry: (err, attempt, delay) => {
          retries = attempt;
          onEvent({ type: "retry", key, phase: "read", attempt, delay, error: err.message });
        },
      });

      await withRetry(() => destination.putObject({ key, body: obj.body, contentType: obj.contentType }), {
        onRetry: (err, attempt, delay) => {
          retries = attempt;
          onEvent({ type: "retry", key, phase: "write", attempt, delay, error: err.message });
        },
      });

      // Integrity check (SOW §4.7): verify the object genuinely landed
      // and its byte size matches what was read from the source. ETags
      // are recorded for reference but NOT used as the sole pass/fail
      // signal -- different providers compute ETags differently for
      // multipart-uploaded objects (they are not always a plain MD5), so
      // an ETag mismatch alone is a known false-positive risk. Size match
      // is the reliable, honest signal this check actually relies on.
      const head = await destination.headObject({ key });
      const expectedSize = obj.sizeBytes ?? entry.sizeBytes;
      const sizeMatches = head && (expectedSize == null || head.sizeBytes === expectedSize);

      if (!head) {
        throw new Error("Object was written but HEAD on the destination returned nothing.");
      }
      if (!sizeMatches) {
        throw new Error(`Size mismatch after upload: source=${expectedSize ?? "unknown"} destination=${head.sizeBytes}`);
      }

      const rec = {
        sourceKey: key,
        sourceProvider: source.kind,
        destinationKey: key,
        byteSize: head.sizeBytes,
        sourceEtag: entry.etag || null,
        destinationVerified: true,
        status: OBJECT_STATUS.MIGRATED,
        startedAt,
        completedAt: new Date().toISOString(),
        retries,
      };
      await manifest.record(rec);
      onEvent({ type: "migrated", ...rec });
    } catch (err) {
      const rec = {
        sourceKey: key,
        sourceProvider: source.kind,
        destinationKey: key,
        byteSize: entry.sizeBytes ?? null,
        sourceEtag: entry.etag || null,
        destinationVerified: false,
        status: OBJECT_STATUS.FAILED,
        startedAt,
        completedAt: new Date().toISOString(),
        retries,
        failureReason: err.message,
      };
      await manifest.record(rec);
      onEvent({ type: "failed", ...rec });
    }
  }

  const summary = { ...manifest.summary(), seen };
  onEvent({ type: "summary", ...summary });
  return summary;
}
