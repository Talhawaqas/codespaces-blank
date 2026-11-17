// test/chunked-file.test.mjs — the chunked large-file format (src/lib/chunkedFile.js) and its storage side
// (src/lib/chunkedStorage.js).
//   - In memory: round trip, wrong passkey, tampered / swapped / missing pieces, manifests that don't belong together.
//   - Real Filebase (skipped without credentials): a ~20 MB file uploaded through real signed links (no server in the
//     data path), the registration checks, signed download links, a byte-for-byte round trip, and clean-up of every object.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import {
  uploadChunkedFile, openChunkedFile, pieceCount, isChunkedManifest, CHUNKED_THRESHOLD_BYTES, PIECE_SIZE,
} from "../src/lib/chunkedFile.js";

process.env.INTEGRATION_ENCRYPTION_KEY ||= "test-only-key-for-chunked-upload-tokens";
const storage = await import("../src/lib/chunkedStorage.js");

const fileOf = (bytes, type = "application/pdf") => new Blob([bytes], { type }); // Blob has size/type/slice like File
const sha = (b) => createHash("sha256").update(b).digest("hex");

// In-memory transport standing in for signed links.
function memoryTransport(pieceSize = 1024 * 1024) {
  const store = new Map();
  let cid = 0;
  return {
    store,
    start: async () => ({ uploadId: "u".repeat(24), token: "t", pieceSize }),
    sign: async (_t, from, count) => Array.from({ length: count }, (_, k) => ({ index: from + k, alpha: { key: `a/${from + k}`, url: `a/${from + k}` }, beta: { key: `b/${from + k}`, url: `b/${from + k}` } })),
    signManifests: async () => ({ alpha: { key: "alpha.json", url: "alpha.json" }, beta: { key: "beta.json", url: "beta.json" } }),
    put: async (url, bytes) => { store.set(url, new Uint8Array(bytes)); return `cid${++cid}`; },
  };
}
const manifests = (t) => [JSON.parse(new TextDecoder().decode(t.store.get("alpha.json"))), JSON.parse(new TextDecoder().decode(t.store.get("beta.json")))];
async function readBack(t, alpha, beta, passkey) {
  const parts = [];
  const meta = await openChunkedFile(alpha, beta, passkey, { getBytes: async (p) => t.store.get(p.key), onPiece: (p) => parts.push(Buffer.from(p)) });
  return { bytes: Buffer.concat(parts), meta };
}

test("small files keep the original format; the threshold sits below the server's request limit", () => {
  assert.ok(CHUNKED_THRESHOLD_BYTES < 4 * 1024 * 1024);
  assert.equal(PIECE_SIZE, 16 * 1024 * 1024);
  assert.equal(pieceCount(1), 1);
  assert.equal(pieceCount(PIECE_SIZE * 3 + 1), 4);
});

test("round trip: 3.5 pieces encrypt, split into alpha/beta halves, and decrypt back byte-for-byte", async () => {
  const t = memoryTransport();
  const original = randomBytes(3.5 * 1024 * 1024);
  const out = await uploadChunkedFile(fileOf(original), "correct horse", t);
  assert.match(out.fileHash, /^0x[0-9a-f]{64}$/);
  assert.equal(out.sizeBytes, original.length);
  const [alpha, beta] = manifests(t);
  assert.ok(isChunkedManifest(alpha) && isChunkedManifest(beta));
  assert.equal(alpha.count, 4);
  assert.equal(beta.header, undefined, "the encrypted header lives only in the alpha manifest");
  // Neither manifest alone holds a whole piece.
  assert.ok(alpha.pieces.every((p, i) => p.bytes > 0 && beta.pieces[i].bytes > 0));
  const { bytes, meta } = await readBack(t, alpha, beta, "correct horse");
  assert.equal(sha(bytes), sha(original));
  assert.equal(meta.type, "application/pdf");
});

test("a wrong passkey is refused with a clear message", async () => {
  const t = memoryTransport();
  await uploadChunkedFile(fileOf(randomBytes(2 * 1024 * 1024)), "right", t);
  const [alpha, beta] = manifests(t);
  await assert.rejects(readBack(t, alpha, beta, "wrong"), /Check the passkey/);
});

test("tampered, swapped or mixed pieces fail the integrity check", async () => {
  const t = memoryTransport();
  await uploadChunkedFile(fileOf(randomBytes(3 * 1024 * 1024)), "pk", t);
  const [alpha, beta] = manifests(t);
  const tampered = new Uint8Array(t.store.get("a/1")); tampered[5] ^= 1;
  const t2 = { store: new Map(t.store) }; t2.store.set("a/1", tampered);
  await assert.rejects(readBack(t2, alpha, beta, "pk"), /integrity/);

  const swapped = { ...alpha, pieces: alpha.pieces.map((p, i) => (i === 0 ? alpha.pieces[2] : i === 2 ? alpha.pieces[0] : p)) };
  const betaSwapped = { ...beta, pieces: beta.pieces.map((p, i) => (i === 0 ? beta.pieces[2] : i === 2 ? beta.pieces[0] : p)) };
  await assert.rejects(readBack(t, swapped, betaSwapped, "pk"), /integrity/, "pieces can't be reordered");

  const other = memoryTransport();
  await uploadChunkedFile(fileOf(randomBytes(3 * 1024 * 1024)), "pk", other);
  const [alpha2, beta2] = manifests(other);
  await assert.rejects(openChunkedFile(alpha, beta2, "pk", { getBytes: async () => new Uint8Array(), onPiece: () => {} }), /do not match/, "manifests of different files are refused");
  await assert.rejects(openChunkedFile({ ...alpha, pieces: alpha.pieces.slice(1) }, beta, "pk", { getBytes: async () => new Uint8Array(), onPiece: () => {} }), /incomplete/);
  assert.ok(alpha2.uploadId);
});

test("upload tokens: bound to org and member, tamper-proof, and expiring", () => {
  const s = storage.startUpload({ orgId: "org1", email: "A@Example.com", sizeBytes: 50 * 1024 * 1024 });
  assert.equal(s.count, 4);
  const claims = storage.readUploadToken(s.token, { orgId: "org1", email: "a@example.com" });
  assert.equal(claims.uploadId, s.uploadId);
  assert.throws(() => storage.readUploadToken(s.token, { orgId: "org2", email: "a@example.com" }), /another company/);
  assert.throws(() => storage.readUploadToken(s.token, { orgId: "org1", email: "b@example.com" }), /someone else/);
  const [body, mac] = s.token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...claims, size: 1 })).toString("base64url");
  assert.throws(() => storage.readUploadToken(`${forged}.${mac}`, { orgId: "org1" }), /not valid/);
  const expired = storage.issueUploadToken({ ...claims, exp: Date.now() - 1 });
  assert.throws(() => storage.readUploadToken(expired, { orgId: "org1" }), /expired/);
  assert.ok(storage.readUploadToken(expired, { orgId: "org1", allowExpired: true }));
  assert.ok(body);
});

test("clean-up refuses anything that is not exactly one upload's prefix", async () => {
  await assert.rejects(storage.deletePrefix("ws/"), /Refusing/);
  await assert.rejects(storage.deletePrefix("ws/org/"), /Refusing/);
  await assert.rejects(storage.deletePrefix(""), /Refusing/);
});

const live = process.env.FILEBASE_ACCESS_KEY && process.env.FILEBASE_SECRET_KEY && process.env.FILEBASE_BUCKET;
test("real Filebase: ~20 MB uploaded through signed links, registered, read back through signed links, cleaned up", { skip: !live && "Filebase is not configured", timeout: 600_000 }, async () => {
  const orgId = `testorg${Date.now()}`;
  const email = "chunked-test@example.com";
  const original = randomBytes(20 * 1024 * 1024 + 12345);
  const s = storage.startUpload({ orgId, email, sizeBytes: original.length });
  const prefix = storage.prefixFor(orgId, s.uploadId);
  try {
    const out = await uploadChunkedFile(fileOf(original, "video/mp4"), "live passkey", {
      start: async () => s,
      sign: async (token, from, count) => storage.signPieces(storage.readUploadToken(token, { orgId, email }), from, count),
      signManifests: async (token) => storage.signManifests(storage.readUploadToken(token, { orgId, email })),
      put: async (url, bytes, type) => {
        const res = await fetch(url, { method: "PUT", body: bytes, headers: { "Content-Type": type } });
        assert.equal(res.status, 200, `signed PUT failed: ${res.status}`);
        const cid = res.headers.get("x-amz-meta-cid");
        assert.ok(cid, "Filebase returns the piece's IPFS CID");
        return cid;
      },
    });
    assert.equal(s.count, 2);

    // Registration: the stored manifests must carry exactly the CIDs being registered.
    const reg = await storage.verifyChunkedRegistration({ token: out.chunkedUploadToken, orgId, email, cidAlpha: out.cidAlpha, cidBeta: out.cidBeta, sizeBytes: original.length });
    assert.equal(reg.prefix, prefix);
    await assert.rejects(storage.verifyChunkedRegistration({ token: out.chunkedUploadToken, orgId, email, cidAlpha: out.cidBeta, cidBeta: out.cidAlpha, sizeBytes: original.length }), /does not match/);
    await assert.rejects(storage.verifyChunkedRegistration({ token: out.chunkedUploadToken, orgId, email, cidAlpha: out.cidAlpha, cidBeta: out.cidBeta, sizeBytes: 5 }), /size does not match/);

    // Reading: fresh signed GET links per piece.
    const doc = { storage: reg, cidAlpha: out.cidAlpha, cidBeta: out.cidBeta };
    const { alpha, beta } = await storage.chunkedForReader(doc);
    assert.ok(alpha.pieces.every((p) => /^https:\/\//.test(p.url)));
    const parts = [];
    const meta = await openChunkedFile(alpha, beta, "live passkey", {
      getBytes: async (p) => { const r = await fetch(p.url); assert.equal(r.status, 200); return new Uint8Array(await r.arrayBuffer()); },
      onPiece: (p) => parts.push(Buffer.from(p)),
    });
    assert.equal(sha(Buffer.concat(parts)), sha(original), "the file comes back byte-for-byte");
    assert.equal(meta.type, "video/mp4");
  } finally {
    const { deleted } = await storage.deletePrefix(prefix);
    assert.ok(deleted >= 6, `every object removed (2 pieces x 2 halves + 2 manifests), removed ${deleted}`);
    const again = await storage.deletePrefix(prefix);
    assert.equal(again.deleted, 0, "nothing left behind");
  }
});
