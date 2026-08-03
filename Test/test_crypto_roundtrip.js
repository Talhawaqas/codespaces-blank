import { generateSecureSalt, deriveVaultKey, reconstructAndDecrypt } from './src/crypto.js';

// Emulates disperseAndSlice's encryption step directly (skipping FileReader,
// which is browser-only) to test the real encrypt -> shard -> reconstruct -> decrypt round trip.
async function testRoundTrip() {
  const passkey = "test_passkey_12345";
  const salt = generateSecureSalt(16);
  const vaultKey = await deriveVaultKey({ passkey, salt });

  const originalText = "data:text/plain;base64,SGVsbG8gSW5heWEgTmV0d29yayE="; // fake "data URL"
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, vaultKey.key, enc.encode(originalText));

  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encrypted), salt.length + iv.length);

  let binary = ''; for (let i = 0; i < combined.byteLength; i++) binary += String.fromCharCode(combined[i]);
  const cipherTextString = Buffer.from(binary, 'binary').toString('base64');

  const midpoint = Math.ceil(cipherTextString.length / 2);
  const shardAlpha = cipherTextString.slice(0, midpoint);
  const shardBeta = cipherTextString.slice(midpoint);

  console.log("Shard Alpha length:", shardAlpha.length, "| Shard Beta length:", shardBeta.length);
  console.log("Neither shard alone is valid base64 of the full payload:", shardAlpha !== cipherTextString);

  const restored = await reconstructAndDecrypt({ shardAlpha, shardBeta, passkey });
  console.log("Restored matches original:", restored === originalText);
  if (restored !== originalText) {
    console.log("MISMATCH! Got:", restored);
    process.exit(1);
  }
  console.log("✅ Full round trip (encrypt -> shard -> reconstruct -> decrypt) verified working.");
}

testRoundTrip().catch(e => { console.error("❌ FAILED:", e); process.exit(1); });
