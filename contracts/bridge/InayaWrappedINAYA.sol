// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title InayaWrappedINAYA
/// @notice Deployed once per spoke chain (Ethereum Sepolia, Polygon Amoy, Avalanche Fuji).
///
/// MAINTAINER NOTE (not end-user-facing): this token is a bridge-minted representation of
/// $INAYA, 1:1 backed by an equivalent lock of the canonical InayaToken on BSC Testnet (home
/// chain) held by InayaTokenBridgeHome. Total supply of this contract must never exceed
/// InayaTokenBridgeHome.lockedBalanceByChain(thisChainId). Minted/burned exclusively by
/// `bridge` -- there is no independent monetary policy here, and unlike the real InayaToken
/// it charges no transfer fee (adding a second fee mechanism on spoke chains would itself be
/// new tokenomics, which is out of scope). Branded identically to $INAYA in every UI -- users
/// are never shown a "wrapped"/"bridged" distinction.
contract InayaWrappedINAYA is ERC20, Ownable {
    address public bridge;

    event BridgeUpdated(address indexed newBridge);

    modifier onlyBridge() {
        require(msg.sender == bridge, "Caller is not the bridge");
        _;
    }

    constructor(address initialOwner, address initialBridge) ERC20("Project Inaya", "INAYA") Ownable(initialOwner) {
        require(initialBridge != address(0), "Zero address not allowed");
        bridge = initialBridge;
    }

    function mint(address to, uint256 amount) external onlyBridge {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyBridge {
        _burn(from, amount);
    }

    /// @notice Escape hatch only, for a redeployed bridge -- same pattern as
    ///         InayaNodeRegistry.setVerifierWallet / InayaThreatRegistry.setReporter.
    function setBridge(address newBridge) external onlyOwner {
        require(newBridge != address(0), "Zero address not allowed");
        bridge = newBridge;
        emit BridgeUpdated(newBridge);
    }
}
