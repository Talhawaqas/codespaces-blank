// snapshot-strategy/inaya-stake-weight/multicall.js
//
// Minimal batched multicall via the canonical Multicall3 contract
// (0xcA11bde05977b3631167028862bE2a173976CA11), deployed at that same
// address on effectively every EVM chain via a deterministic CREATE2
// factory -- confirmed deployed on BSC testnet (chainId 97) when this was
// written. Real snapshot-strategies (the published package) use
// @snapshot-labs/snapshot.js's own Multicaller class internally; this is a
// small self-contained equivalent so this strategy has no dependency on
// that package's exact internal API, which is not designed to be imported
// standalone outside the monorepo it ships in.

import { Interface } from 'ethers';

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
];

/**
 * @param {string} network unused here (kept for parity with the real
 *   snapshot-strategies Multicaller signature, which some callers expect)
 * @param {import('ethers').Provider} provider
 * @param {string[]} abi
 * @param {[address: string, method: string, params: any[]][]} calls
 * @param {{ blockTag?: string | number }} options
 * @returns {Promise<any[][]>} one decoded result array per call, in order
 */
export async function multicall(network, provider, abi, calls, { blockTag = 'latest' } = {}) {
  const iface = new Interface(abi);
  const { Contract } = await import('ethers');
  const multi = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

  const encodedCalls = calls.map(([target, method, params]) => ({
    target,
    allowFailure: true,
    callData: iface.encodeFunctionData(method, params),
  }));

  const results = await multi.aggregate3.staticCall(encodedCalls, { blockTag });

  return results.map((result, i) => {
    const [, method] = calls[i];
    if (!result.success) {
      throw new Error(`multicall failed for ${calls[i][0]}.${method}(${calls[i][2].join(',')})`);
    }
    return iface.decodeFunctionResult(method, result.returnData);
  });
}
