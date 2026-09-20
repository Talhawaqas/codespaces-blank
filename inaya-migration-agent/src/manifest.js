// src/manifest.js
//
// The migration engine's own persistence for resume/retry/idempotency
// (SOW §4.8: "must not create uncontrolled duplicate objects when
// restarted... a deterministic migration identity/manifest must allow the
// agent to determine whether an object has already been successfully
// migrated"). Deliberately a plain, human-readable JSON Lines file next to
// wherever the operator runs the CLI -- an enterprise migration is a
// one-time, operator-supervised event, not a service with its own
// database; a file that survives a killed process and can be inspected
// with `cat`/`grep` is the right amount of infrastructure for that job.
//
// One line per source object key, written append-only as work completes
// (never rewritten in place), so a crash mid-run loses at most the one
// in-flight write, never the whole ledger. On load, later lines for the
// same key win (last-write-wins over the append log).

import { createReadStream, existsSync } from "node:fs";
import { appendFile, writeFile, rename } from "node:fs/promises";
import { createInterface } from "node:readline";

export const OBJECT_STATUS = {
  MIGRATED: "MIGRATED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
};

export class Manifest {
  constructor(path) {
    this.path = path;
    this.records = new Map(); // sourceKey -> record
  }

  static async load(path) {
    const m = new Manifest(path);
    if (!existsSync(path)) return m;
    const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed);
        if (rec && rec.sourceKey) m.records.set(rec.sourceKey, rec);
      } catch {
        // A truncated final line from a killed process is expected and
        // must not crash a resume -- it's simply not counted as recorded.
      }
    }
    return m;
  }

  /** A key counts as already-done only on a real, verified MIGRATED
   *  record -- a prior FAILED or SKIPPED attempt is deliberately NOT
   *  treated as done, so retry/resume actually retries it. */
  isDone(sourceKey) {
    const rec = this.records.get(sourceKey);
    return !!rec && rec.status === OBJECT_STATUS.MIGRATED;
  }

  async record(rec) {
    this.records.set(rec.sourceKey, rec);
    await appendFile(this.path, JSON.stringify(rec) + "\n", "utf8");
  }

  summary() {
    const counts = { [OBJECT_STATUS.MIGRATED]: 0, [OBJECT_STATUS.FAILED]: 0, [OBJECT_STATUS.SKIPPED]: 0 };
    let totalBytes = 0;
    for (const rec of this.records.values()) {
      counts[rec.status] = (counts[rec.status] || 0) + 1;
      if (rec.status === OBJECT_STATUS.MIGRATED) totalBytes += rec.byteSize || 0;
    }
    return { ...counts, totalObjects: this.records.size, totalBytes };
  }

  /** Rewrites the manifest file compacted to one line per key (last write
   *  wins) -- an explicit operator action between runs, never automatic,
   *  since the append-only log during a run is what makes a mid-run crash
   *  safe to resume from. */
  async compact() {
    const tmp = this.path + ".compact.tmp";
    const lines = [...this.records.values()].map((r) => JSON.stringify(r)).join("\n") + (this.records.size ? "\n" : "");
    await writeFile(tmp, lines, "utf8");
    await rename(tmp, this.path);
  }
}
