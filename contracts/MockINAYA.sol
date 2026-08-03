// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Test-only mock standing in for the real $INAYA token, which already
// exists on testnet — this just lets the unit test suite mint arbitrary
// balances without touching your real deployed token or its faucet.
contract MockINAYA is ERC20 {
    constructor() ERC20("Mock INAYA", "mINAYA") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
