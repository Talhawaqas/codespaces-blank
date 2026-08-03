// lib/merkle.js
// Client-side chunking + Merkle tree helper for Inaya Proof of Storage.
// Sorted-pair hashing throughout so proofs verify against OpenZeppelin's
// MerkleProof.sol on-chain (contracts/InayaProofRegistry.sol) without modification.
//
// This is the hand-rolled version from the implementation guide. It's correct and fine
// for MVP/testnet. Before mainnet, consider swapping to `merkletreejs` + `keccak256`
// (same shape, more battle-tested edge case handling for odd leaf counts):
//   npm install merkletreejs keccak256

import { ethers } from 'ethers';

export const CHUNK_SIZE = 256 * 1024; // 256 KB

/**
 * Splits a ciphertext string into fixed-size chunks.
 * @param {string} cipherTextString - base64 AES-GCM ciphertext from encryptData()
 * @returns {string[]} array of chunks, in order (this order = leaf order = CID array order)
 */
export function chunkCipherText(cipherTextString) {
  const chunks = [];
  for (let i = 0; i < cipherTextString.length; i += CHUNK_SIZE) {
    chunks.push(cipherTextString.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

/** keccak256 hash of a single chunk -> Merkle leaf */
export function hashChunk(chunk) {
  return ethers.keccak256(ethers.toUtf8Bytes(chunk));
}

/**
 * Builds a Merkle tree from an array of leaf hashes (sorted-pair, OZ-compatible).
 * @param {string[]} leaves - array of keccak256 hex strings
 * @returns {{ root: string, layers: string[][] }}
 */
export function buildMerkleTree(leaves) {
  if (leaves.length === 0) throw new Error('Cannot build a Merkle tree with zero leaves');
  let level = leaves;
  const layers = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i]; // duplicate last if odd
      const pair = [left, right].sort();
      next.push(ethers.keccak256(ethers.concat(pair)));
    }
    layers.push(next);
    level = next;
  }
  return { root: level[0], layers };
}

/**
 * Produces a Merkle proof (sibling hashes) for a given leaf index.
 * @param {string[][]} layers - the `layers` array returned by buildMerkleTree
 * @param {number} leafIndex
 * @returns {string[]} proof - ordered array of sibling hashes
 */
export function getMerkleProof(layers, leafIndex) {
  const proof = [];
  let index = leafIndex;
  for (let i = 0; i < layers.length - 1; i++) {
    const level = layers[i];
    const pairIndex = index % 2 === 0 ? index + 1 : index - 1;
    if (pairIndex < level.length) proof.push(level[pairIndex]);
    index = Math.floor(index / 2);
  }
  return proof;
}

/**
 * Convenience: full pipeline from raw ciphertext to { root, layers, leaves, chunks }.
 * Use this in prepareShardedFile() instead of the old Alpha/Beta split.
 */
export function buildProofOfStoragePayload(cipherTextString) {
  const chunks = chunkCipherText(cipherTextString);
  const leaves = chunks.map(hashChunk);
  const { root, layers } = buildMerkleTree(leaves);
  return { chunks, leaves, root, layers, chunkCount: chunks.length };
}
