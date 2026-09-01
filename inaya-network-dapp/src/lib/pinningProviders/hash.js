// src/lib/pinningProviders/hash.js
//
// Provider-agnostic content-integrity hash used throughout the backup engine. Deliberately not
// a CID equality check across providers -- different providers/CID versions can address
// identical bytes differently (confirmed for Filebase vs. Pinata specifically: Filebase's IPFS
// CID is computed by its own backing network, not user-supplied, and there's no guarantee it
// matches Pinata's). SHA-256 of the raw content string is the one check both replicate() (at
// pin time) and the recovery workflow (after re-fetching) can agree on regardless of provider.

import { createHash } from "node:crypto";

export function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
