// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title VelturAccessControl (TESTNET — Polygon Amoy)
 * @notice Role-based access: Super Wallet → Owner → Admin
 * @dev Super Wallet is hardcoded and IRREVOCABLE
 */
contract VelturAccessControl is Ownable {
    // ── Super Wallet (immutable, highest privilege) ──
    address public constant SUPER_WALLET = 0x031eA4bA7E1C5729C352e846549E9B5745f3C66E;

    // ── Admins ──
    mapping(address => bool) public admins;

    // ── Authorized contracts (C-4: cross-contract setHidden) ──
    mapping(address => bool) public authorizedContracts;

    // ── Hidden positions (only Super can set) ──
    mapping(bytes32 => bool) private _hidden; // keccak256(abi.encode(user, posId)) => hidden

    // ── Claim locks ──
    mapping(address => bool) public claimLocked;

    event AdminGranted(address indexed admin);
    event AdminRevoked(address indexed admin);
    event ClaimLocked(address indexed user);
    event ClaimUnlocked(address indexed user);
    event HiddenSet(address indexed user, uint256 posId, bool hidden);
    event ContractAuthorized(address indexed addr, bool authorized);

    constructor() Ownable(msg.sender) {}

    // ── Modifiers ──
    modifier onlySuper() {
        require(msg.sender == SUPER_WALLET, "Not Super Wallet");
        _;
    }

    modifier onlyAdmin() {
        require(
            msg.sender == SUPER_WALLET ||
            msg.sender == owner() ||
            admins[msg.sender],
            "Not authorized"
        );
        _;
    }

    modifier onlyOwnerOrSuper() {
        require(
            msg.sender == SUPER_WALLET ||
            msg.sender == owner(),
            "Not owner or super"
        );
        _;
    }

    // ── Admin management ──
    function grantAdmin(address addr) external onlyOwnerOrSuper {
        admins[addr] = true;
        emit AdminGranted(addr);
    }

    function revokeAdmin(address addr) external onlyOwnerOrSuper {
        require(addr != SUPER_WALLET, "Cannot revoke Super Wallet");
        admins[addr] = false;
        emit AdminRevoked(addr);
    }

    // ── Claim lock/unlock ──
    function lockClaims(address user) external onlyAdmin {
        claimLocked[user] = true;
        emit ClaimLocked(user);
    }

    function unlockClaims(address user) external onlyAdmin {
        claimLocked[user] = false;
        emit ClaimUnlocked(user);
    }

    // ── Contract authorization (C-4) ──
    function authorizeContract(address addr) external onlyOwnerOrSuper {
        authorizedContracts[addr] = true;
        emit ContractAuthorized(addr, true);
    }

    function revokeContract(address addr) external onlyOwnerOrSuper {
        authorizedContracts[addr] = false;
        emit ContractAuthorized(addr, false);
    }

    // ── Hidden flag (SUPER ONLY — direct calls) ──
    function setHidden(address user, uint256 posId, bool hidden) external onlySuper {
        bytes32 key = keccak256(abi.encode(user, posId)); // L-2: abi.encode instead of abi.encodePacked
        _hidden[key] = hidden;
        emit HiddenSet(user, posId, hidden);
    }

    // ── Hidden flag (C-4: from authorized contracts) ──
    function setHiddenFromContract(address user, uint256 posId, bool hidden) external {
        require(authorizedContracts[msg.sender], "Not authorized contract");
        bytes32 key = keccak256(abi.encode(user, posId)); // L-2: abi.encode
        _hidden[key] = hidden;
        emit HiddenSet(user, posId, hidden);
    }

    function isHidden(address user, uint256 posId) external view returns (bool) {
        bytes32 key = keccak256(abi.encode(user, posId)); // L-2: abi.encode
        return _hidden[key];
    }

    // ── View helpers ──
    function isSuperWallet(address addr) external pure returns (bool) {
        return addr == SUPER_WALLET;
    }

    function isAuthorized(address addr) external view returns (bool) {
        return addr == SUPER_WALLET || addr == owner() || admins[addr];
    }

    // ── Override transferOwnership (Super Wallet unaffected) ──
    function transferOwnership(address newOwner) public override onlyOwnerOrSuper {
        require(newOwner != address(0), "Zero address");
        _transferOwnership(newOwner);
    }
}
