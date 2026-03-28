// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAccessControl {
    function isAdmin(address account) external view returns (bool);
    function isAuthorized(address account) external view returns (bool);
    function isHidden(address user, uint256 posId) external view returns (bool);
}

contract VelturVault {
    // ── Reentrancy guard ────────────────────────────────────────────
    bool private _locked;
    modifier nonReentrant() {
        require(!_locked, "ReentrancyGuard");
        _locked = true;
        _;
        _locked = false;
    }

    // ── State ───────────────────────────────────────────────────────
    IERC20 public usdt;
    IAccessControl public accessControl;
    address public owner;

    address public tradingFundAddress;

    uint256 public totalDeposited;
    uint256 public totalValueLocked;

    struct Position {
        uint256 amount;
        uint256 startTime;
        uint256 lockDays;
        uint8 tier;
        uint8 packageType;
        bool active;
        bool isGranted;
    }

    // user => positionId => Position
    mapping(address => mapping(uint256 => Position)) public positions;
    mapping(address => uint256) public positionCount;

    // ── Events ──────────────────────────────────────────────────────
    event Deposited(address indexed user, uint256 amount, uint8 packageType, uint8 tier);
    event RedemptionRequested(address indexed user, uint256 posId);
    event LeaderGranted(address indexed user, uint256 amount, bool hidden);
    event TradingFundAddressSet(address indexed newAddr);
    event WithdrawnToTradingFund(uint256 amount);
    event AdminWithdraw(address indexed to, uint256 amount);

    // ── Modifiers ───────────────────────────────────────────────────
    modifier onlyAdmin() {
        require(accessControl.isAdmin(msg.sender), "Not admin");
        _;
    }

    modifier onlyAuthorized() {
        require(accessControl.isAuthorized(msg.sender), "Not authorized");
        _;
    }

    // ── Constructor ─────────────────────────────────────────────────
    constructor(address _usdt, address _accessControl) {
        usdt = IERC20(_usdt);
        accessControl = IAccessControl(_accessControl);
        owner = msg.sender;
    }

    // ── User deposit ────────────────────────────────────────────────
    function deposit(
        uint256 amount,
        uint256 lockDays,
        uint8 tier,
        uint8 packageType
    ) external nonReentrant {
        require(amount > 0, "Zero amount");
        require(usdt.transferFrom(msg.sender, address(this), amount), "Transfer failed");

        uint256 posId = positionCount[msg.sender];
        positions[msg.sender][posId] = Position({
            amount: amount,
            startTime: block.timestamp,
            lockDays: lockDays,
            tier: tier,
            packageType: packageType,
            active: true,
            isGranted: false
        });
        positionCount[msg.sender]++;

        totalDeposited += amount;
        totalValueLocked += amount;

        emit Deposited(msg.sender, amount, packageType, tier);
    }

    // ── Admin: grant leader package ─────────────────────────────────
    function grantLeaderPackage(
        address user,
        uint256 amount,
        bool hidden
    ) external onlyAdmin {
        require(user != address(0), "Zero address");

        uint256 posId = positionCount[user];
        positions[user][posId] = Position({
            amount: amount,
            startTime: block.timestamp,
            lockDays: 0,
            tier: 0,
            packageType: 6,
            active: true,
            isGranted: true
        });
        positionCount[user]++;

        // hidden flag is handled off-chain via AccessControl.setHiddenPosition
        emit LeaderGranted(user, amount, hidden);
    }

    // ── Backend/admin: request redemption ───────────────────────────
    function requestRedemption(address user, uint256 posId) external onlyAuthorized {
        Position storage pos = positions[user][posId];
        require(pos.active, "Not active");
        pos.active = false;

        if (pos.amount <= totalValueLocked) {
            totalValueLocked -= pos.amount;
        } else {
            totalValueLocked = 0;
        }

        emit RedemptionRequested(user, posId);
    }

    // ── Trading fund management ─────────────────────────────────────
    function setTradingFundAddress(address _new) external onlyAdmin {
        require(_new != address(0), "Zero address");
        tradingFundAddress = _new;
        emit TradingFundAddressSet(_new);
    }

    function withdrawToTradingFund(uint256 amount) external onlyAuthorized nonReentrant {
        require(tradingFundAddress != address(0), "Trading fund not set");
        require(amount > 0, "Zero amount");
        require(usdt.transfer(tradingFundAddress, amount), "Transfer failed");
        emit WithdrawnToTradingFund(amount);
    }

    // ── Admin withdraw ──────────────────────────────────────────────
    function withdrawAdmin(address to, uint256 amount) external onlyAdmin nonReentrant {
        require(to != address(0), "Zero address");
        require(amount > 0, "Zero amount");
        require(usdt.transfer(to, amount), "Transfer failed");
        emit AdminWithdraw(to, amount);
    }


    // ── Approve payout contracts to spend Vault USDT ────────────────
    function approvePayoutContract(address contractAddr, uint256 amount) external {
        require(msg.sender == owner || accessControl.isAdmin(msg.sender), "Not admin");
        require(usdt.approve(contractAddr, amount), "Approve failed");
    }

    // ── View functions ──────────────────────────────────────────────
    function getUserPositionCount(address user) external view returns (uint256) {
        return positionCount[user];
    }

    function getPosition(address user, uint256 posId)
        external
        view
        returns (
            uint256 amount,
            uint256 startTime,
            uint256 lockDays,
            uint8 tier,
            uint8 packageType,
            bool active,
            bool isGranted
        )
    {
        Position storage p = positions[user][posId];
        return (p.amount, p.startTime, p.lockDays, p.tier, p.packageType, p.active, p.isGranted);
    }

    function getVaultBalance() external view returns (uint256) {
        return usdt.balanceOf(address(this));
    }
}
