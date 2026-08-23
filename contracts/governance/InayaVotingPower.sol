// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

// ============================================================
// INAYA VOTING POWER
//
// SCOPE NOTE: this is a voting-power MIRROR, not an asset. It has no
// price, can't be transferred, and mints/burns nothing except in
// lockstep with real state already living in InayaStaking.
//
// $INAYA voting weight is meant to be "staked balance x lock-tier
// multiplier" (Flexible/30-day/90-day), matching the same formula
// InayaStaking.earned() already uses for rewards. Plain $INAYA is a
// normal transferable ERC20 with no vote checkpoints, so it can't be
// handed to OpenZeppelin's Governor directly -- Governor needs an
// IVotes-compatible token with historical checkpoints (so voting power
// at a proposal's snapshot block can't be inflated by staking more
// AFTER seeing the proposal).
//
// sync(account) is intentionally permissionless: it does not let the
// caller choose a weight, it only recomputes the truth from
// InayaStaking's own public state and mints/burns the checkpoint delta
// to match. Anyone (the account itself, a keeper bot, or the
// InayaGovernor's own propose/castVote flow) can call it for anyone;
// it can never be used to grant more voting power than InayaStaking
// says an account actually has.
// ============================================================
interface IInayaStakingView {
    function userStakedBalance(address account) external view returns (uint256);
    function lockMultiplierBps(address account) external view returns (uint256);
    function FLEXIBLE_MULTIPLIER_BPS() external view returns (uint256);
}

contract InayaVotingPower is ERC20, ERC20Votes {
    IInayaStakingView public immutable staking;
    uint256 private constant BPS_DENOMINATOR = 10000;

    constructor(address _staking)
        ERC20("Inaya Voting Power", "veINAYA")
        EIP712("Inaya Voting Power", "1")
    {
        require(_staking != address(0), "Zero address not allowed");
        staking = IInayaStakingView(_staking);
    }

    /// @notice What `account`'s voting weight SHOULD be right now, per InayaStaking.
    /// Same formula as InayaStaking.earned()'s multiplier: staked balance x tier
    /// multiplier (defaulting to the 1.00x flexible tier if no lock was ever set).
    function currentWeight(address account) public view returns (uint256) {
        uint256 staked = staking.userStakedBalance(account);
        if (staked == 0) return 0;
        uint256 multiplier = staking.lockMultiplierBps(account);
        if (multiplier == 0) multiplier = staking.FLEXIBLE_MULTIPLIER_BPS();
        return (staked * multiplier) / BPS_DENOMINATOR;
    }

    /// @notice Recomputes `account`'s checkpointed weight to match InayaStaking right
    /// now. Call this before voting if your stake changed since the last sync -- the
    /// Governor only sees weight as of the last sync before a proposal's snapshot block.
    function sync(address account) public {
        uint256 target = currentWeight(account);
        uint256 existing = balanceOf(account);
        if (target > existing) {
            _mint(account, target - existing);
        } else if (existing > target) {
            _burn(account, existing - target);
        }
        // No-op emitted-events-only path when target == existing -- cheap to call often.
    }

    /// @notice Batch convenience for a keeper/backend syncing several stakers at once
    /// (e.g. right before a new proposal's snapshot block) so their weight is fresh.
    function syncMany(address[] calldata accounts) external {
        for (uint256 i = 0; i < accounts.length; i++) {
            sync(accounts[i]);
        }
    }

    // Non-transferable: this token is a read-only mirror of stake weight, not a
    // tradeable asset. Delegation (via Votes.delegate/delegateBySig) still works
    // normally -- that's how a staker assigns their synced weight to a representative.
    function transfer(address, uint256) public pure override(ERC20) returns (bool) {
        revert("InayaVotingPower: non-transferable, call sync() to update your weight");
    }

    function transferFrom(address, address, uint256) public pure override(ERC20) returns (bool) {
        revert("InayaVotingPower: non-transferable, call sync() to update your weight");
    }

    // ---- Required overrides where ERC20 and ERC20Votes both define the same hook ----
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }
}
