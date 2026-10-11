// src/lib/infrastructure/nodeCerts.js
//
// Sovereign Infrastructure Fabric SOW §41-43: cluster CA + node certificate
// issuance. The CA private key is the one piece of key material in this
// whole SOW the Next.js control plane itself must hold (every other key --
// node identity keys, volume encryption keys -- is generated and kept on
// the node or the client, never the server). It is therefore encrypted at
// rest using the SAME reversible-secret pattern every other server-held
// credential in this codebase already uses (src/lib/integrationCrypto.js,
// AES-256-GCM, its own dedicated INTEGRATION_ENCRYPTION_KEY) -- not a new
// encryption scheme invented for this one case.
//
// Uses @peculiar/x509 (built on Node's native WebCrypto) for CA/CSR/
// certificate operations, ECDSA P-256 throughout -- matching the Rust node
// runtime's own rcgen-generated keys exactly, confirmed by an end-to-end
// smoke test (CA -> CSR -> signed cert -> chain verify -> auth-token
// signature verify) before this was adopted. node-forge was tried first
// and dropped: its RSA support is solid but its elliptic-curve path is
// immature, and RSA keygen isn't natively available on the Rust side
// without extra crates -- ECDSA end-to-end avoids that mismatch entirely.
// See docs/infrastructure/DEPENDENCY-LICENSE-AUDIT.md.

import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { getOrgCollections } from "../orgs.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";

x509.cryptoProvider.set(globalThis.crypto);

const SIGNING_ALGORITHM = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const CA_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000; // 10 years
const NODE_CERT_VALIDITY_MS = 397 * 24 * 60 * 60 * 1000; // under the ~398-day ceiling most TLS clients enforce for leaf certs

let indexed = false;
async function col() {
  const c = await getOrgCollections();
  const cas = c.db.collection("infra_cluster_cas");
  if (!indexed) {
    await cas.createIndex({ clusterId: 1 }, { unique: true });
    indexed = true;
  }
  return { c, cas };
}

function randomSerial() {
  // An even-length, high-bit-clear hex serial (avoids being read as a
  // negative ASN.1 INTEGER) -- 16 random bytes is ample entropy.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[0] &= 0x7f;
  return Buffer.from(bytes).toString("hex");
}

async function exportPrivateKeyPem(privateKey) {
  const pkcs8 = await globalThis.crypto.subtle.exportKey("pkcs8", privateKey);
  return x509.PemConverter.encode(pkcs8, "PRIVATE KEY");
}

async function importPrivateKeyPem(pem) {
  const der = x509.PemConverter.decode(pem)[0];
  return globalThis.crypto.subtle.importKey("pkcs8", der, SIGNING_ALGORITHM, true, ["sign"]);
}

/** Idempotently creates the cluster's root CA the first time it's needed —
 *  never regenerated once it exists (that would invalidate every node
 *  certificate already issued under it). */
export async function getOrCreateClusterCa({ clusterId, orgId }) {
  if (!isIntegrationCryptoConfigured()) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured — the cluster CA's private key cannot be stored until it's set.");
  }
  const { cas } = await col();
  const existing = await cas.findOne({ clusterId });
  if (existing) return existing;

  const keys = await globalThis.crypto.subtle.generateKey(SIGNING_ALGORITHM, true, ["sign", "verify"]);
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + CA_VALIDITY_MS);
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: `CN=Inaya Sovereign Infrastructure Fabric CA (${clusterId}), O=Inaya Network`,
    notBefore,
    notAfter,
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });

  const doc = {
    clusterId,
    orgId,
    caCertificatePem: caCert.toString("pem"),
    caPrivateKeyEncrypted: encryptIntegrationSecret(await exportPrivateKeyPem(keys.privateKey)),
    createdAt: new Date(),
  };
  // Race-safe: the unique index on clusterId makes a concurrent first
  // enrollment's loser insert fail, and it re-reads the winner's CA rather
  // than ever having two CAs for one cluster.
  try {
    await cas.insertOne(doc);
    return doc;
  } catch (err) {
    if (err?.code === 11000) {
      const winner = await cas.findOne({ clusterId });
      if (winner) return winner;
    }
    throw err;
  }
}

/** Signs a node's CSR under the cluster CA. The node's private key is
 *  never seen by the server — only the public CSR crosses the wire, exactly
 *  as SOW §42 requires ("node proves possession" of a key it generated
 *  itself; the server only ever certifies the matching public key). */
export async function signNodeCsr({ clusterId, orgId, nodeId, csrPem }) {
  const ca = await getOrCreateClusterCa({ clusterId, orgId });
  const caCert = new x509.X509Certificate(ca.caCertificatePem);
  const caPrivateKey = await importPrivateKeyPem(decryptIntegrationSecret(ca.caPrivateKeyEncrypted));

  let csr;
  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch {
    throw new Error("Malformed CSR.");
  }
  const csrValid = await csr.verify();
  if (!csrValid) {
    throw new Error("CSR signature verification failed — the CSR does not prove possession of the claimed private key.");
  }

  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + NODE_CERT_VALIDITY_MS);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: `CN=${nodeId}, O=Inaya Network`,
    issuer: caCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: SIGNING_ALGORITHM,
    publicKey: csr.publicKey,
    signingKey: caPrivateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.2", "1.3.6.1.5.5.7.3.1"]), // clientAuth, serverAuth
    ],
  });

  return {
    certificatePem: cert.toString("pem"),
    caCertificatePem: ca.caCertificatePem,
    certificateSerial: cert.serialNumber,
    issuedAt: notBefore,
    expiresAt: notAfter,
  };
}

export { SIGNING_ALGORITHM };
