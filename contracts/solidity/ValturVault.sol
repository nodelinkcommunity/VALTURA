// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title ValturVault
 * @notice Core vault contract for Valtura yield platform on Polygon
 * @dev Handles USDT deposits, withdrawals, and earnings claims
 */
contract ValturVault is Ownable, ReentrancyGuard {
    IERC20 public immutable usdt;

    struct Position {
        uint256 amount;
        uint256 startTime;
        uint256 lockDays;
        uint8 tier;
        bool active;
    }

    mapping(address => Position[]) public positions;
    mapping(address => uint256) public totalDeposited;
    mapping(address => uint256) public totalClaimed;

    uint256 public earningsCapMultiplier = 300; // 300%
    uint256 public totalValueLocked;

    event Deposited(address indexed user, uint256 amount, uint256 lockDays);
    event Claimed(address indexed user, uint256 amount, uint256 fee);
    event Redeemed(address indexed user, uint256 amount);

    constructor(address _usdt) Ownable(msg.sender) {
        usdt = IERC20(_usdt);
    }

    function deposit(uint256 amount, uint256 lockDays, uint8 tier) external nonReentrant {
        require(amount >= 10e6, "Min $10");
        require(amount % 10e6 == 0, "Must be multiple of $10");
        usdt.transferFrom(msg.sender, address(this), amount);
        positions[msg.sender].push(Position(amount, block.timestamp, lockDays, tier, true));
        totalDeposited[msg.sender] += amount;
        totalValueLocked += amount;
        emit Deposited(msg.sender, amount, lockDays);
    }

    function claimAllEarnings(uint256 grossAmount, uint256 feeAmount) external nonReentrant {
        uint256 net = grossAmount - feeAmount;
        require(usdt.balanceOf(address(this)) >= net, "Insufficient vault balance");
        totalClaimed[msg.sender] += grossAmount;
        usdt.transfer(msg.sender, net);
        emit Claimed(msg.sender, net, feeAmount);
    }

    function redeem(uint256 positionIndex) external nonReentrant {
        Position storage p = positions[msg.sender][positionIndex];
        require(p.active, "Not active");
        require(block.timestamp >= p.startTime + (p.lockDays * 1 days), "Lock period active");
        p.active = false;
        totalValueLocked -= p.amount;
        usdt.transfer(msg.sender, p.amount);
        emit Redeemed(msg.sender, p.amount);
    }

    function getEarningsCapStatus(address user) external view returns (
        uint256 deposited, uint256 capLimit, uint256 claimed, uint256 remaining
    ) {
        deposited = totalDeposited[user];
        capLimit = (deposited * earningsCapMultiplier) / 100;
        claimed = totalClaimed[user];
        remaining = capLimit > claimed ? capLimit - claimed : 0;
    }

    function setEarningsCapMultiplier(uint256 _multi) external onlyOwner {
        earningsCapMultiplier = _multi;
    }
}
