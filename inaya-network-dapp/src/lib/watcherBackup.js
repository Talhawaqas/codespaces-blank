// src/lib/watcherBackup.js
//
// SQA-038 — a real backup for the Watcher Pioneer Program, built directly
// from this incident: MongoDB Atlas's free tier (the plan this project is
// on) has no backup/snapshot capability at all, so when this program's
// pre-existing history became unrecoverable, there was nothing to restore
// from anywhere. This closes that gap the same way every other durable
// artifact in this codebase is stored — Vercel Blob (already configured,
// BLOB_READ_WRITE_TOKEN already set in Production/Preview/Development) —
// which is a completely separate system from MongoDB Atlas. A future
// problem with the database (an accidental drop, a bad migration, a plan
// change) can't also take out its own backups, because the backups don't
// live there.
//
// Deliberately simple: a full JSON snapshot of all four watcher_* collections
// on every run, not an incremental/diff scheme. This program is capped at
// 2,500 wallets (WATCHER_MAX_WALLETS) with a handful of fields each — even
// at the cap, a full snapshot is a small file, so "just dump everything"
// is the honest, low-risk choice here, not a shortcut.

import { put, list, get } from "@vercel/blob";
import { getWatcherCollections } from "./watcherPioneer.js";

const BACKUP_PREFIX = "watcher-backups/";

/** Snapshots every watcher_* collection and uploads it to Vercel Blob as one
 *  JSON file. Returns the blob's URL and a few counts so the caller (the
 *  cron route, or a manual invocation) has something concrete to log. */
export async function runWatcherBackup() {
  const { pioneers, sessions, programCounters, compensationLog, identities, walletLinks } = await getWatcherCollections();

  const [pioneerDocs, sessionDocs, counterDoc, compensationDocs, identityDocs, walletLinkDocs] = await Promise.all([
    pioneers.find({}).toArray(),
    sessions.find({}).toArray(),
    programCounters.findOne({ _id: "global" }),
    compensationLog.find({}).toArray(),
    identities.find({}).toArray(),   // social-login additions: new keys only, the snapshot's existing keys are unchanged
    walletLinks.find({}).toArray(),
  ]);

  const snapshot = {
    takenAt: new Date().toISOString(),
    counts: {
      pioneers: pioneerDocs.length,
      sessions: sessionDocs.length,
      compensationGrants: compensationDocs.length,
      socialIdentities: identityDocs.length,
      walletLinks: walletLinkDocs.length,
    },
    programCounters: counterDoc,
    pioneers: pioneerDocs,
    sessions: sessionDocs,
    compensationLog: compensationDocs,
    identities: identityDocs,
    walletLinks: walletLinkDocs,
  };

  const filename = `${BACKUP_PREFIX}${snapshot.takenAt.replace(/[:.]/g, "-")}.json`;
  const body = JSON.stringify(snapshot, null, 2);

  // "private" — not just because that's what this project's Blob store
  // requires, but because it's the right call regardless: a backup full of
  // real wallet addresses and point totals shouldn't sit at a guessable
  // public URL.
  const blob = await put(filename, body, {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
  });

  return { url: blob.url, filename, ...snapshot.counts, takenAt: snapshot.takenAt };
}

/** Lists every backup snapshot taken so far, newest first — what an admin
 *  (or a future restore script) would look through to pick a point to
 *  restore from. */
export async function listWatcherBackups() {
  const { blobs } = await list({ prefix: BACKUP_PREFIX });
  return blobs
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .map((b) => ({ url: b.url, pathname: b.pathname, uploadedAt: b.uploadedAt, size: b.size }));
}

/** Fetches and parses one backup snapshot by its blob URL — the read half
 *  of a manual restore (this module intentionally does not write a restore-
 *  into-MongoDB function: replaying a stale snapshot over live data is a
 *  decision an admin should make deliberately, per-collection, not something
 *  automated silently). */
export async function readWatcherBackup(url) {
  // Private blobs require the SDK's own authenticated get() — a plain
  // fetch(url) is refused for a private store. get() hands back a web
  // ReadableStream, not a URL, so it's read via Response rather than a
  // second fetch.
  const result = await get(url, { access: "private" });
  if (!result) throw new Error(`Backup not found at ${url}.`);
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}
