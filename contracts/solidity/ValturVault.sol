// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./ValturAccessControl.sol";

/**
 * @title ValturVault (TESTNET — Polygon Amoy)
 * @notice Core vault: deposits, positions, leader grants, redemption requests
 * @dev Uses test USDT on Amoy testnet
 */
contract ValturVault is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20; // C-1

    ValturAccessControl public immutable accessControl; // L-4: immutable
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

    // H-2: Valid lockDays per packageType
    mapping(uint8 => uint256) public packageLockDays;

    event Deposited(address indexed user, uint256 amount, uint8 packageType, uint8 tier);
    event LeaderGranted(address indexed user, uint256 amount, bool hidden);
    event RedemptionRequested(address indexed user, uint256 posId);

    constructor(address _usdt, address _accessControl) {
        usdt = IERC20(_usdt);
        accessControl = ValturAccessControl(_accessControl);

        // H-2: Default lock days per package type
        packageLockDays[1] = 90;   // essential
        packageLockDays[2] = 180;  // classic
        packageLockDays[3] = 270;  // ultimate
        packageLockDays[4] = 360;  // signature
        packageLockDays[5] = 360;  // exclusive
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

    // ── User deposit ──
    function deposit(uint256 amount, uint256 lockDays, uint8 tier, uint8 packageType) external nonReentrant whenNotPaused {
        require(amount >= 10e6, "Min $10");
        require(amount % 10e6 == 0, "Must be multiple of $10");
        require(packageType >= 1 && packageType <= 5, "Invalid package");
        require(tier >= 1 && tier <= 3, "Invalid tier"); // H-2
        require(lockDays == packageLockDays[packageType], "Invalid lock days for package"); // H-2

        usdt.safeTransferFrom(msg.sender, address(this), amount); // C-1
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

    // ── H-2: Admin can update lock days per package ──
    function setPackageLockDays(uint8 packageType, uint256 lockDays) external onlyOwnerOrSuper {
        require(packageType >= 1 && packageType <= 5, "Invalid package");
        require(lockDays > 0, "Lock days must be > 0");
        packageLockDays[packageType] = lockDays;
    }

    // ── Grant Exclusive Leader (free, no USDT from user) ──
    function grantLeaderPackage(address user, uint256 amount, bool hidden) external onlyAdmin whenNotPaused {
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

        // C-2: Update accounting
        totalDeposited[user] += amount;
        totalValueLocked += amount;

        if (hidden) {
            accessControl.setHiddenFromContract(user, posId, true); // C-4
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
    function requestRedemption(uint256 posId) external whenNotPaused {
        Position storage p = positions[msg.sender][posId];
        require(p.active, "Not active");
        require(!p.isGranted, "Granted packages: no capital redemption");
        require(block.timestamp >= p.startTime + (p.lockDays * 1 days), "Lock period active");

        p.active = false; // H-3: prevent duplicate redemption requests
        totalValueLocked -= p.amount;
        emit RedemptionRequested(msg.sender, posId);
    }
}
