// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title InayaEgressTimelockVault
 * @notice Holds Egress fees ($INAYA) in a 180-day (6-month) timelock epoch.
 *         Once an epoch matures, accumulated $INAYA is injected into the Staking Pool.
 *         Also safely routes incoming USDT to the operational protocol treasury.
 */
contract InayaEgressTimelockVault is Ownable, ReentrancyGuard {
    IERC20 public immutable inayaToken;
    IERC20 public immutable usdtToken;
    
    address public stakingContract;
    address public operationalTreasury;

    uint256 public constant EPOCH_DURATION = 180 days; // 6-Month Timelock
    uint256 public currentEpochStart;
    uint256 public epochNumber;

    event EpochHarvestExecuted(
        uint256 indexed epoch,
        uint256 amountInjected,
        uint256 nextEpochStart
    );
    event UsdtForwarded(address indexed treasury, uint256 amount);
    event StakingContractUpdated(address indexed newStakingContract);
    event OperationalTreasuryUpdated(address indexed newTreasury);

    constructor(
        address _inayaToken,
        address _usdtToken,
        address _stakingContract,
        address _operationalTreasury
    ) Ownable(msg.sender) {
        require(
            _inayaToken != address(0) && 
            _usdtToken != address(0) && 
            _stakingContract != address(0) && 
            _operationalTreasury != address(0), 
            "Zero address not allowed"
        );

        inayaToken = IERC20(_inayaToken);
        usdtToken = IERC20(_usdtToken);
        stakingContract = _stakingContract;
        operationalTreasury = _operationalTreasury;
        
        currentEpochStart = block.timestamp;
        epochNumber = 1;
    }

    // ============================================================
    // 🔁 6-MONTH HARVEST EXECUTION (Publicly Callable After 180 Days)
    // ============================================================
    /**
     * @notice Injects all accumulated $INAYA into the Staking Contract once the 180-day epoch completes.
     */
    function executeSemiAnnualHarvest() external nonReentrant {
        require(
            block.timestamp >= currentEpochStart + EPOCH_DURATION,
            "Timelock Active: 180-day epoch cycle has not completed yet!"
        );

        uint256 accumulatedVaultBalance = inayaToken.balanceOf(address(this));
        require(accumulatedVaultBalance > 0, "No INAYA tokens accumulated in this epoch.");

        currentEpochStart = block.timestamp;
        epochNumber++;

        require(
            inayaToken.transfer(stakingContract, accumulatedVaultBalance),
            "Transfer to Staking Contract failed"
        );

        emit EpochHarvestExecuted(
            epochNumber - 1,
            accumulatedVaultBalance,
            currentEpochStart + EPOCH_DURATION
        );
    }

    // ============================================================
    // 💵 USDT FORWARDING (Instant Protocol Revenue Release)
    // ============================================================
    /**
     * @notice Forwards any accumulated USDT from storage sales to the operational treasury.
     */
    function forwardUSDT() public nonReentrant {
        uint256 usdtBalance = usdtToken.balanceOf(address(this));
        require(usdtBalance > 0, "No USDT to forward");

        require(
            usdtToken.transfer(operationalTreasury, usdtBalance),
            "USDT transfer failed"
        );

        emit UsdtForwarded(operationalTreasury, usdtBalance);
    }

    // ============================================================
    // 👁️ FRONTEND VIEW FUNCTIONS
    // ============================================================
    /**
     * @notice Returns countdown details and current INAYA vault balance for dApp UI display.
     */
    function getNextHarvestCountdown() external view returns (
        uint256 secondsRemaining,
        uint256 currentInayaBalance,
        uint256 currentUsdtBalance,
        uint256 nextEpochTimestamp,
        uint256 currentEpoch
    ) {
        uint256 unlockTime = currentEpochStart + EPOCH_DURATION;
        secondsRemaining = block.timestamp >= unlockTime ? 0 : unlockTime - block.timestamp;
        currentInayaBalance = inayaToken.balanceOf(address(this));
        currentUsdtBalance = usdtToken.balanceOf(address(this));
        nextEpochTimestamp = unlockTime;
        currentEpoch = epochNumber;
    }

    // ============================================================
    // 🛠️ ADMIN SETTERS
    // ============================================================
    function setStakingContract(address _stakingContract) external onlyOwner {
        require(_stakingContract != address(0), "Zero address not allowed");
        stakingContract = _stakingContract;
        emit StakingContractUpdated(_stakingContract);
    }

    function setOperationalTreasury(address _operationalTreasury) external onlyOwner {
        require(_operationalTreasury != address(0), "Zero address not allowed");
        operationalTreasury = _operationalTreasury;
        emit OperationalTreasuryUpdated(_operationalTreasury);
    }
}