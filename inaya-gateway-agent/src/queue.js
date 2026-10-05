// src/queue.js -- the offline queue. Work that must reach Inaya (inventory pages, permission snapshots, audit batches) is written to disk FIRST and removed only
// after Inaya acknowledged it, so a network drop, a crash or a restart loses nothing. Files are rewritten atomically (write a temp file, rename).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function openQueue(dir, name = "queue") {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const file = path.join(dir, `${name}.jsonl`);
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
  const write = (items) => { const tmp = file + ".tmp"; fs.writeFileSync(tmp, items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""), { mode: 0o600 }); fs.renameSync(tmp, file); };
  return {
    file, depth: () => read().length, peek: () => read(),
    push(type, payload, key = null) { const items = read(); if (key) { const i = items.findIndex((x) => x.key === key); if (i >= 0) { items[i] = { ...items[i], payload }; write(items); return items[i].id; } } const it = { id: randomBytes(6).toString("hex"), type, key, payload, at: new Date().toISOString(), attempts: 0 }; items.push(it); write(items); return it.id; },
    ack(id) { write(read().filter((x) => x.id !== id)); },
    fail(id) { write(read().map((x) => (x.id === id ? { ...x, attempts: x.attempts + 1, lastAttemptAt: new Date().toISOString() } : x))); },
    /** Sends each item in order with `send`; stops at the first network failure (the rest stay queued). Items Inaya rejects with a 4xx are dropped after 5 attempts. */
    async flush(send) {
      let sent = 0; for (const it of read()) {
        try { await send(it); this.ack(it.id); sent++; }
        catch (e) { if (e.network || e.status >= 500 || e.status === 429) { this.fail(it.id); break; } this.fail(it.id); if (it.attempts + 1 >= 5) this.ack(it.id); else break; }
      } return { sent, remaining: this.depth() };
    },
  };
}
