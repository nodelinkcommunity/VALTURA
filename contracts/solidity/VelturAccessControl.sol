// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract VelturAccessControl {
    // ── Immutable S_WALLET ──────────────────────────────────────────
    address public constant S_WALLET = 0x031eA4bA7E1C5729C352e846549E9B5745f3C66E;

    // ── Owner ───────────────────────────────────────────────────────
    address public owner;

    // ── Admins ──────────────────────────────────────────────────────
    mapping(address => bool) public admins;

    // ── Claim locking ───────────────────────────────────────────────
    mapping(address => bool) public claimLocked;

    // ── Hidden positions: user => posId => hidden ───────────────────
    mapping(address => mapping(uint256 => bool)) public hiddenPositions;

    // ── Authorized contracts for cross-contract calls ───────────────
    mapping(address => bool) public authorizedContracts;

    // ── Events ──────────────────────────────────────────────────────
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AdminGranted(address indexed account);
    event AdminRevoked(address indexed account);
    event ClaimLockSet(address indexed user, bool locked);
    event PositionHiddenSet(address indexed user, uint256 posId, bool hidden);
    event ContractAuthorized(address indexed contractAddr, bool authorized);

    // ── Modifiers ───────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyOwnerOrSWallet() {
        require(msg.sender == owner || msg.sender == S_WALLET, "Not owner/S_WALLET");
        _;
    }

    modifier onlyAdmin() {
        require(
            msg.sender == owner || msg.sender == S_WALLET || admins[msg.sender], "Not admin");
        _;
    }

    modifier onlyAuthorized() {
        require(
            msg.sender == owner ||
            msg.sender == S_WALLET ||
            admins[msg.sender] ||
            authorizedContracts[msg.sender], "Not authorized");
        _;
    }

    // ── Constructor ─────────────────────────────────────────────────
    constructor() {
        owner = msg.sender;
        admins[msg.sender] = true;
        admins[S_WALLET] = true;
    }

    // ── Ownership ───────────────────────────────────────────────────
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
        admins[newOwner] = true;
    }

    // ── Admin management ────────────────────────────────────────────
    function grantAdmin(address account) external onlyOwnerOrSWallet {
        require(account != address(0), "Zero address");
        admins[account] = true;
        emit AdminGranted(account);
    }

    function revokeAdmin(address account) external onlyOwnerOrSWallet {
        require(account != S_WALLET, "Cannot revoke S_WALLET");
        require(account != owner, "Cannot revoke owner");
        admins[account] = false;
        emit AdminRevoked(account);
    }

    // ── Claim locking ───────────────────────────────────────────────
    function setClaimLock(address user, bool locked) external onlyAdmin {
        claimLocked[user] = locked;
        emit ClaimLockSet(user, locked);
    }

    // ── Hidden positions (S_WALLET only) ────────────────────────────
    function setHiddenPosition(address user, uint256 posId, bool hidden) external {
        require(msg.sender == S_WALLET, "Only S_WALLET");
        hiddenPositions[user][posId] = hidden;
        emit PositionHiddenSet(user, posId, hidden);
    }

    function isHidden(address user, uint256 posId) external view returns (bool) {
        return hiddenPositions[user][posId];
    }

    // ── Authorized contracts ────────────────────────────────────────
    function setAuthorizedContract(address contractAddr, bool authorized) external onlyOwnerOrSWallet {
        authorizedContracts[contractAddr] = authorized;
        emit ContractAuthorized(contractAddr, authorized);
    }

    // ── View helpers ────────────────────────────────────────────────
    function isAdmin(address account) external view returns (bool) {
        return account == owner || account == S_WALLET || admins[account];
    }

    function isAuthorized(address account) external view returns (bool) {
        return account == owner || account == S_WALLET || admins[account] || authorizedContracts[account];
    }

    function isClaimLocked(address user) external view returns (bool) {
        return claimLocked[user];
    }
}
