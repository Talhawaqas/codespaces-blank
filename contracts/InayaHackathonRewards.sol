// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title InayaHackathonRewards
/// @notice Holds and distributes a fixed 100,000 $INAYA hackathon prize pool. Deliberately
///         isolated from every other Inaya contract — it only knows about the $INAYA token
///         itself, never InayaStaking, the referral system, node registry, or any reserve.
///         There is no on-chain "Node Swarm Reserve" contract to pull from (it's a tokenomics
///         allocation line item, not a deployed contract), so this contract is funded directly
///         by the owner transferring tokens in once real mainnet $INAYA exists.
///
/// @dev Claims are gated behind `mainnetActive`, a one-way switch that can only be flipped on
///      BSC Mainnet itself (chain id 56) — `activateMainnet()` reverts on every other chain,
///      including BSC Testnet (97) and the local Hardhat network, so there is no operational
///      mistake that can unlock claims anywhere but real mainnet.
contract InayaHackathonRewards is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable inayaToken;

    uint256 public constant MAX_TOTAL_ALLOCATION = 100_000 * 1e18;
    uint256 public constant MAINNET_CHAIN_ID = 56;

    mapping(address => uint256) public allocations;
    mapping(address => bool) public claimed;
    address[] public winnersList;

    uint256 public totalAllocated;
    uint256 public totalClaimed;
    bool public mainnetActive;

    event WinnerConfigured(address indexed winner, uint256 amount, uint256 newTotalAllocated);
    event MainnetActivated(uint256 timestamp);
    event RewardClaimed(address indexed winner, uint256 amount);
    event EmergencyWithdraw(address indexed to, uint256 amount);

    constructor(address _inayaToken) Ownable(msg.sender) {
        require(_inayaToken != address(0), "token address required");
        inayaToken = IERC20(_inayaToken);
    }

    /// @notice Configure (or correct) a single winner's allocation. Safe to re-run for the same
    ///         winner before they've claimed — the total allocation cap is enforced against the
    ///         delta, not the raw amount, so lowering an existing winner's allocation to raise
    ///         another's is always possible as long as the 100,000 cap holds overall.
    function configureWinner(address winner, uint256 amount) public onlyOwner {
        require(winner != address(0), "winner address required");
        require(!claimed[winner], "winner already claimed, allocation is final");

        uint256 previousAmount = allocations[winner];
        if (previousAmount == 0 && amount > 0) {
            winnersList.push(winner);
        }

        uint256 newTotal = totalAllocated - previousAmount + amount;
        require(newTotal <= MAX_TOTAL_ALLOCATION, "exceeds 100,000 INAYA prize pool cap");

        allocations[winner] = amount;
        totalAllocated = newTotal;

        emit WinnerConfigured(winner, amount, newTotal);
    }

    /// @notice Convenience batch wrapper around configureWinner — same rules apply per entry.
    function configureWinnersBatch(address[] calldata winners, uint256[] calldata amounts) external onlyOwner {
        require(winners.length == amounts.length, "array length mismatch");
        for (uint256 i = 0; i < winners.length; i++) {
            configureWinner(winners[i], amounts[i]);
        }
    }

    /// @notice One-way switch that unlocks claim(). Can only succeed on BSC Mainnet itself —
    ///         reverts on every other chain id, so this can never be accidentally called on
    ///         testnet or any dev network.
    function activateMainnet() external onlyOwner {
        require(block.chainid == MAINNET_CHAIN_ID, "mainnet only");
        require(!mainnetActive, "already active");
        mainnetActive = true;
        emit MainnetActivated(block.timestamp);
    }

    /// @notice Claim your configured allocation. Only callable once, only after mainnet
    ///         activation, and only once the contract actually holds enough $INAYA to pay out.
    function claim() external nonReentrant {
        require(mainnetActive, "rewards are not yet active");
        uint256 amount = allocations[msg.sender];
        require(amount > 0, "no allocation for this address");
        require(!claimed[msg.sender], "already claimed");
        require(inayaToken.balanceOf(address(this)) >= amount, "contract not yet funded for this claim");

        claimed[msg.sender] = true;
        totalClaimed += amount;

        emit RewardClaimed(msg.sender, amount);
        inayaToken.safeTransfer(msg.sender, amount);
    }

    /// @notice Token balance not earmarked to any configured-but-unclaimed winner. This is the
    ///         only balance emergency recovery can ever touch — funds owed to a winner can never
    ///         be pulled out from under them, even before they've claimed.
    function unallocatedBalance() public view returns (uint256) {
        uint256 balance = inayaToken.balanceOf(address(this));
        uint256 earmarked = totalAllocated - totalClaimed;
        if (balance <= earmarked) return 0;
        return balance - earmarked;
    }

    /// @notice Recover tokens sent to this contract beyond what's needed to cover every
    ///         configured winner's outstanding allocation.
    function emergencyWithdrawUnallocated(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "recipient address required");
        require(amount <= unallocatedBalance(), "amount exceeds unallocated balance");
        emit EmergencyWithdraw(to, amount);
        inayaToken.safeTransfer(to, amount);
    }

    function winnersCount() external view returns (uint256) {
        return winnersList.length;
    }
}
