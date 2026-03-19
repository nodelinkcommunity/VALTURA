// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ValturAccessControl
 * @notice Role-based access: Super Wallet → Owner → Admin
 * @dev Super Wallet is hardcoded and IRREVOCABLE
 */
contract ValturAccessControl is Ownable {
    // ── Super Wallet (immutable, highest privilege) ──
    address public constant SUPER_WALLET = 0x031eA4bA7E1C5729C352e846549E9B5745f3C66E;

    // ── Admins ──
    mapping(address => bool) public admins;

    // ── Hidden positions (only Super can set) ──
    mapping(bytes32 => bool) private _hidden; // keccak256(user, posId) => hidden

    // ── Claim locks ──
    mapping(address => bool) public claimLocked;

    event AdminGranted(address indexed admin);
    event AdminRevoked(address indexed admin);
    event ClaimLocked(address indexed user);
    event ClaimUnlocked(address indexed user);
    event HiddenSet(address indexed user, uint256 posId, bool hidden);

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

    // ── Hidden flag (SUPER ONLY) ──
    function setHidden(address user, uint256 posId, bool hidden) external onlySuper {
        bytes32 key = keccak256(abi.encodePacked(user, posId));
        _hidden[key] = hidden;
        emit HiddenSet(user, posId, hidden);
    }

    function isHidden(address user, uint256 posId) external view returns (bool) {
        bytes32 key = keccak256(abi.encodePacked(user, posId));
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
