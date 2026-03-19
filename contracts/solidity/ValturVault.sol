// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./ValturAccessControl.sol";

/**
 * @title ValturVault (TESTNET — Polygon Amoy)
 * @notice Core vault: deposits, positions, leader grants, redemption requests
 * @dev Uses test USDT on Amoy testnet
 */
contract ValturVault is ReentrancyGuard {
    ValturAccessControl public accessControl;
    IERC20 public immutable usdt;

    struct Position {
        uint256 amount;
        uint256 startTime;
        uint256 lockDays;
        uint8 tier;
        uint8 packageType; // 1=essential, 2=classic, 3=ultimate, 4=signature, 5=exclusive, 6=exclusive_leader
        bool active;
        bool isGranted;    // true = admin-granted (no USDT from user)
    }

    mapping(address => Position[]) public positions;
    mapping(address => uint256) public totalDeposited;
    uint256 public totalValueLocked;

    event Deposited(address indexed user, uint256 amount, uint8 packageType, uint8 tier);
    event LeaderGranted(address indexed user, uint256 amount, bool hidden);
    event RedemptionRequested(address indexed user, uint256 posId);

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

    // ── User deposit ──
    function deposit(uint256 amount, uint256 lockDays, uint8 tier, uint8 packageType) external nonReentrant {
        require(amount >= 10e6, "Min $10");
        require(amount % 10e6 == 0, "Must be multiple of $10");
        require(packageType >= 1 && packageType <= 5, "Invalid package");

        usdt.transferFrom(msg.sender, address(this), amount);
        positions[msg.sender].push(Position({
            amount: amount,
            startTime: block.timestamp,
            lockDays: lockDays,
            tier: tier,
            packageType: packageType,
            active: true,
            isGranted: false
        }));
        totalDeposited[msg.sender] += amount;
        totalValueLocked += amount;
        emit Deposited(msg.sender, amount, packageType, tier);
    }

    // ── Grant Exclusive Leader (free, no USDT from user) ──
    function grantLeaderPackage(address user, uint256 amount, bool hidden) external onlyAdmin {
        if (hidden) {
            require(msg.sender == accessControl.SUPER_WALLET(), "Only Super can set hidden");
        }

        uint256 posId = positions[user].length;
        positions[user].push(Position({
            amount: amount,
            startTime: block.timestamp,
            lockDays: 360,
            tier: 3,
            packageType: 6,
            active: true,
            isGranted: true
        }));

        if (hidden) {
            accessControl.setHidden(user, posId, true);
        }

        emit LeaderGranted(user, amount, hidden);
    }

    // ── Get position (filters hidden for non-Super) ──
    function getPosition(address user, uint256 posId) external view returns (
        uint256 amount, uint256 startTime, uint256 lockDays,
        uint8 tier, uint8 packageType, bool active, bool isGranted
    ) {
        if (accessControl.isHidden(user, posId) && msg.sender != accessControl.SUPER_WALLET()) {
            return (0, 0, 0, 0, 0, false, false);
        }
        Position storage p = positions[user][posId];
        return (p.amount, p.startTime, p.lockDays, p.tier, p.packageType, p.active, p.isGranted);
    }

    function getUserPositionCount(address user) external view returns (uint256) {
        return positions[user].length;
    }

    // ── Request redemption ──
    function requestRedemption(uint256 posId) external {
        Position storage p = positions[msg.sender][posId];
        require(p.active, "Not active");
        require(!p.isGranted, "Granted packages: no capital redemption");
        require(block.timestamp >= p.startTime + (p.lockDays * 1 days), "Lock period active");
        emit RedemptionRequested(msg.sender, posId);
    }
}
