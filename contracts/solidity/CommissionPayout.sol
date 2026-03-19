// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./ValturAccessControl.sol";

/**
 * @title CommissionPayout (TESTNET — Polygon Amoy)
 * @notice 5 income sources + Earnings Cap 300% + Claim All
 *
 * Income Types:
 *   1 = Daily Profit
 *   2 = Binary Bonus (5% on Signature + Exclusive volume)
 *   3 = Referral Commission (10% on F1 daily profit)
 *   4 = Binary Commission (15% on weak leg daily profit)
 *   5 = Momentum Rewards
 */
contract CommissionPayout is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20; // C-1

    ValturAccessControl public immutable accessControl; // L-4: immutable
    IERC20 public immutable usdt;

    // Per-user per-type earnings
    mapping(address => mapping(uint8 => uint256)) public earned;   // total earned
    mapping(address => mapping(uint8 => uint256)) public claimed;  // total claimed

    // Earnings Cap
    mapping(address => uint256) public vipInvestment; // Exclusive package amount
    uint256 public earningsCapMultiplier = 300; // 300%
    uint256 public claimFeeBps = 250; // 2.5%

    // M-2: Epoch guard
    mapping(uint256 => bool) public distributedEpochs;

    // M-3: Batch size limit
    uint256 public constant MAX_BATCH = 200;

    event CommissionDistributed(address indexed user, uint8 incomeType, uint256 amount);
    event AllEarningsClaimed(address indexed user, uint256 gross, uint256 fee, uint256 net);
    event VIPInvestmentUpdated(address indexed user, uint256 amount);
    event EarningsCapMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier); // L-1

    constructor(address _usdt, address _accessControl) {
        usdt = IERC20(_usdt);
        accessControl = ValturAccessControl(_accessControl);
    }

    modifier onlyAdmin() {
        require(accessControl.isAuthorized(msg.sender), "Not authorized");
        _;
    }

    modifier onlyOwnerOrSuper() {
        require(
            msg.sender == accessControl.SUPER_WALLET() ||
            msg.sender == accessControl.owner(),
            "Not owner or super"
        );
        _;
    }

    // ── L-3: Pausable ──
    function pause() external onlyOwnerOrSuper {
        _pause();
    }

    function unpause() external onlyOwnerOrSuper {
        _unpause();
    }

    // ── Set VIP investment for Earnings Cap calculation ──
    function setVIPInvestment(address user, uint256 amount) external onlyAdmin {
        vipInvestment[user] = amount;
        emit VIPInvestmentUpdated(user, amount);
    }

    // ── Batch distribute commissions (backend cron) ──
    function distributeCommissions(
        address[] calldata users,
        uint8[] calldata types,
        uint256[] calldata amounts,
        uint256 epoch // M-2
    ) external onlyAdmin whenNotPaused {
        require(users.length == types.length && types.length == amounts.length, "Length mismatch");
        require(users.length <= MAX_BATCH, "Exceeds max batch size"); // M-3
        require(!distributedEpochs[epoch], "Epoch already distributed"); // M-2
        distributedEpochs[epoch] = true;

        for (uint256 i = 0; i < users.length; i++) {
            require(types[i] >= 1 && types[i] <= 5, "Invalid type");

            // C-3: Fix Earnings Cap zero bypass
            uint256 capLimit = (vipInvestment[users[i]] * earningsCapMultiplier) / 100;
            if (capLimit == 0) continue; // no VIP = no earnings
            uint256 totalEarned = _totalEarned(users[i]);
            if (totalEarned >= capLimit) continue;
            if (totalEarned + amounts[i] > capLimit) {
                uint256 partial = capLimit - totalEarned;
                earned[users[i]][types[i]] += partial;
                emit CommissionDistributed(users[i], types[i], partial);
                continue;
            }

            earned[users[i]][types[i]] += amounts[i];
            emit CommissionDistributed(users[i], types[i], amounts[i]);
        }
    }

    // ── Claim all unclaimed earnings ──
    function claimAllEarnings() external nonReentrant whenNotPaused {
        require(!accessControl.claimLocked(msg.sender), "Claims locked");

        uint256 totalUnclaimed = 0;
        for (uint8 t = 1; t <= 5; t++) {
            uint256 uncl = earned[msg.sender][t] - claimed[msg.sender][t];
            if (uncl > 0) {
                claimed[msg.sender][t] = earned[msg.sender][t];
                totalUnclaimed += uncl;
            }
        }
        require(totalUnclaimed > 0, "Nothing to claim");

        uint256 fee = (totalUnclaimed * claimFeeBps) / 10000;
        uint256 net = totalUnclaimed - fee;
        require(usdt.balanceOf(address(this)) >= net, "Insufficient balance");

        usdt.safeTransfer(msg.sender, net); // C-1
        emit AllEarningsClaimed(msg.sender, totalUnclaimed, fee, net);
    }

    // ── H-1: Withdraw accumulated fees ──
    function withdrawFees(address to, uint256 amount) external onlyOwnerOrSuper {
        require(to != address(0), "Zero address");
        usdt.safeTransfer(to, amount);
    }

    // ── View: unclaimed per type ──
    function getUnclaimedEarnings(address user) external view returns (
        uint256[5] memory unclaimed_,
        uint256 total
    ) {
        for (uint8 t = 1; t <= 5; t++) {
            unclaimed_[t - 1] = earned[user][t] - claimed[user][t];
            total += unclaimed_[t - 1];
        }
    }

    // ── View: Earnings Cap status ──
    function getEarningsCapStatus(address user) external view returns (
        uint256 investment, uint256 capLimit, uint256 totalEarned_, uint256 remaining
    ) {
        investment = vipInvestment[user];
        capLimit = (investment * earningsCapMultiplier) / 100;
        totalEarned_ = _totalEarned(user);
        remaining = capLimit > totalEarned_ ? capLimit - totalEarned_ : 0;
    }

    // ── Admin config ──
    function setEarningsCapMultiplier(uint256 multi) external onlyOwnerOrSuper {
        require(multi >= 100 && multi <= 1000, "100-1000%"); // M-4
        uint256 old = earningsCapMultiplier;
        earningsCapMultiplier = multi;
        emit EarningsCapMultiplierUpdated(old, multi); // L-1
    }

    function setClaimFee(uint256 bps) external onlyOwnerOrSuper {
        require(bps <= 1000, "Max 10%");
        claimFeeBps = bps;
    }

    // ── Internal: total earned across all 5 types ──
    function _totalEarned(address user) internal view returns (uint256 total) {
        for (uint8 t = 1; t <= 5; t++) {
            total += earned[user][t];
        }
    }
}
