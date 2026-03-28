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
}

contract TradingFunds {
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

    // ── Events ──────────────────────────────────────────────────────
    event FundsWithdrawn(address indexed to, uint256 amount);
    event FundsTransferred(address indexed vault, uint256 amount);

    // ── Modifiers ───────────────────────────────────────────────────
    modifier onlyAdmin() {
        require(accessControl.isAdmin(msg.sender), "Not admin");
        _;
    }

    // ── Constructor ─────────────────────────────────────────────────
    constructor(address _usdt, address _accessControl) {
        usdt = IERC20(_usdt);
        accessControl = IAccessControl(_accessControl);
    }

    // ── Withdraw USDT to any wallet for trading ─────────────────────
    function withdraw(address to, uint256 amount) external onlyAdmin nonReentrant {
        require(to != address(0), "Zero address");
        require(amount > 0, "Zero amount");
        require(usdt.transfer(to, amount), "Transfer failed");
        emit FundsWithdrawn(to, amount);
    }

    // ── Transfer USDT back to Vault (Reward Fund) ───────────────────
    function transferToVault(address vault, uint256 amount) external onlyAdmin nonReentrant {
        require(vault != address(0), "Zero address");
        require(amount > 0, "Zero amount");
        require(usdt.transfer(vault, amount), "Transfer failed");
        emit FundsTransferred(vault, amount);
    }

    // ── View ────────────────────────────────────────────────────────
    function getBalance() external view returns (uint256) {
        return usdt.balanceOf(address(this));
    }
}
