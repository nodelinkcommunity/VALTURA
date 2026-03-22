// ══════════════════════════════════════
// Veltura — Blockchain Service (ethers.js v6)
// ══════════════════════════════════════

const { ethers } = require('ethers');
const config = require('../config');

// ── ABI fragments (only the functions we call from backend) ──

const ACCESS_CONTROL_ABI = [
  'function S_WALLET() view returns (address)',
  'function isAuthorized(address) view returns (bool)',
  'function isHidden(address user, uint256 posId) view returns (bool)',
  'function claimLocked(address) view returns (bool)',
  'function lockClaims(address user)',
  'function unlockClaims(address user)',
];

const VAULT_ABI = [
  'function deposit(uint256 amount, uint256 lockDays, uint8 tier, uint8 packageType)',
  'function grantLeaderPackage(address user, uint256 amount, bool hidden)',
  'function requestRedemption(uint256 posId)',
  'function getPosition(address user, uint256 posId) view returns (uint256 amount, uint256 startTime, uint256 lockDays, uint8 tier, uint8 packageType, bool active, bool isGranted)',
  'function getUserPositionCount(address user) view returns (uint256)',
  'function totalDeposited(address) view returns (uint256)',
  'function totalValueLocked() view returns (uint256)',
  'function positions(address, uint256) view returns (uint256 amount, uint256 startTime, uint256 lockDays, uint8 tier, uint8 packageType, bool active, bool isGranted)',
  'function packageLockDays(uint8) view returns (uint256)',
];

const ROI_DISTRIBUTOR_ABI = [
  'function distributeROI(address[] users, uint256[] amounts, uint256 epoch)',
  'function claimROI()',
  'function getPendingROI(address user) view returns (uint256)',
  'function totalDistributed() view returns (uint256)',
];

const COMMISSION_PAYOUT_ABI = [
  'function distributeCommissions(address[] users, uint8[] types, uint256[] amounts, uint256 epoch)',
  'function claimAllEarnings()',
  'function setVIPInvestment(address user, uint256 amount)',
  'function getUnclaimedEarnings(address user) view returns (uint256[5] unclaimed, uint256 total)',
  'function getEarningsCapStatus(address user) view returns (uint256 investment, uint256 capLimit, uint256 totalEarned, uint256 remaining)',
  'function vipInvestment(address) view returns (uint256)',
];

const REDEMPTION_MANAGER_ABI = [
  'function createOrder(address user, uint256 posId, uint256 amount)',
  'function approveRedemption(uint256 orderId)',
  'function rejectRedemption(uint256 orderId, uint8 reason)',
  'function getOrder(uint256 orderId) view returns (address user, uint256 posId, uint256 amount, uint256 createdAt, uint8 status)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

// ── Provider & Signer ──

let provider = null;
let signer = null;

function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(config.polygon.rpc, {
      chainId: config.polygon.chainId,
      name: config.polygon.chainId === 137 ? 'polygon' : 'polygon-amoy',
    });
  }
  return provider;
}

function getSigner() {
  if (!signer) {
    if (!config.polygon.privateKey) {
      throw new Error('BACKEND_PRIVATE_KEY not configured');
    }
    signer = new ethers.Wallet(config.polygon.privateKey, getProvider());
  }
  return signer;
}

// ── Contract instances ──

const contracts = {};

function getContract(name, address, abi, useSigner = false) {
  const key = `${name}_${useSigner ? 'w' : 'r'}`;
  if (!contracts[key]) {
    if (!address) {
      throw new Error(`Contract address not configured for ${name}`);
    }
    const providerOrSigner = useSigner ? getSigner() : getProvider();
    contracts[key] = new ethers.Contract(address, abi, providerOrSigner);
  }
  return contracts[key];
}

function getAccessControl(write = false) {
  return getContract('accessControl', config.polygon.contracts.accessControl, ACCESS_CONTROL_ABI, write);
}

function getVault(write = false) {
  return getContract('vault', config.polygon.contracts.valturVault, VAULT_ABI, write);
}

function getROIDistributor(write = false) {
  return getContract('roiDistributor', config.polygon.contracts.roiDistributor, ROI_DISTRIBUTOR_ABI, write);
}

function getCommissionPayout(write = false) {
  return getContract('commissionPayout', config.polygon.contracts.commissionPayout, COMMISSION_PAYOUT_ABI, write);
}

function getRedemptionManager(write = false) {
  return getContract('redemptionManager', config.polygon.contracts.redemptionManager, REDEMPTION_MANAGER_ABI, write);
}

function getUSDT(write = false) {
  return getContract('usdt', config.polygon.usdtAddress, ERC20_ABI, write);
}

// ── Helpers ──

function toUSDT(amount) {
  return ethers.parseUnits(String(amount), config.USDT_DECIMALS);
}

function fromUSDT(amount) {
  return parseFloat(ethers.formatUnits(amount, config.USDT_DECIMALS));
}

async function getUSDTBalance(address) {
  const usdt = getUSDT();
  const balance = await usdt.balanceOf(address);
  return fromUSDT(balance);
}

async function getOnChainPositions(userAddress) {
  const vault = getVault();
  const count = await vault.getUserPositionCount(userAddress);
  const positions = [];
  for (let i = 0; i < Number(count); i++) {
    const p = await vault.positions(userAddress, i);
    positions.push({
      index: i,
      amount: fromUSDT(p.amount),
      startTime: Number(p.startTime),
      lockDays: Number(p.lockDays),
      tier: Number(p.tier),
      packageType: Number(p.packageType),
      active: p.active,
      isGranted: p.isGranted,
    });
  }
  return positions;
}

async function getEarningsCapStatus(userAddress) {
  const cp = getCommissionPayout();
  const result = await cp.getEarningsCapStatus(userAddress);
  return {
    investment: fromUSDT(result.investment),
    capLimit: fromUSDT(result.capLimit),
    totalEarned: fromUSDT(result.totalEarned),
    remaining: fromUSDT(result.remaining),
  };
}

async function getUnclaimedEarnings(userAddress) {
  const cp = getCommissionPayout();
  const result = await cp.getUnclaimedEarnings(userAddress);
  const types = ['daily_profit', 'binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards'];
  const breakdown = {};
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const val = fromUSDT(result.unclaimed[i]);
    breakdown[types[i]] = val;
    total += val;
  }
  return { breakdown, total };
}

async function distributeROI(users, amounts, epoch) {
  const roi = getROIDistributor(true);
  const tx = await roi.distributeROI(users, amounts.map((a) => toUSDT(a)), epoch);
  return tx.wait();
}

async function distributeCommissions(users, types, amounts, epoch) {
  const cp = getCommissionPayout(true);
  const tx = await cp.distributeCommissions(users, types, amounts.map((a) => toUSDT(a)), epoch);
  return tx.wait();
}

async function setVIPInvestment(userAddress, amount) {
  const cp = getCommissionPayout(true);
  const tx = await cp.setVIPInvestment(userAddress, toUSDT(amount));
  return tx.wait();
}

async function grantLeaderPackage(userAddress, amount, hidden = false) {
  const vault = getVault(true);
  const tx = await vault.grantLeaderPackage(userAddress, toUSDT(amount), hidden);
  return tx.wait();
}

async function createRedemptionOrder(userAddress, posId, amount) {
  const rm = getRedemptionManager(true);
  const tx = await rm.createOrder(userAddress, posId, toUSDT(amount));
  return tx.wait();
}

async function approveRedemption(orderId) {
  const rm = getRedemptionManager(true);
  const tx = await rm.approveRedemption(orderId);
  return tx.wait();
}

async function rejectRedemption(orderId, reason = 4) {
  const rm = getRedemptionManager(true);
  const tx = await rm.rejectRedemption(orderId, reason);
  return tx.wait();
}

async function lockClaims(userAddress) {
  const ac = getAccessControl(true);
  const tx = await ac.lockClaims(userAddress);
  return tx.wait();
}

async function unlockClaims(userAddress) {
  const ac = getAccessControl(true);
  const tx = await ac.unlockClaims(userAddress);
  return tx.wait();
}

async function isClaimLocked(userAddress) {
  const ac = getAccessControl();
  return ac.claimLocked(userAddress);
}

async function isPositionHidden(userAddress, posId) {
  const ac = getAccessControl();
  return ac.isHidden(userAddress, posId);
}

async function getTotalValueLocked() {
  const vault = getVault();
  const tvl = await vault.totalValueLocked();
  return fromUSDT(tvl);
}

/**
 * Verify EIP-191 signature — returns the recovered address.
 */
function verifySignature(message, signature) {
  return ethers.verifyMessage(message, signature);
}

module.exports = {
  getProvider,
  getSigner,
  getAccessControl,
  getVault,
  getROIDistributor,
  getCommissionPayout,
  getRedemptionManager,
  getUSDT,
  toUSDT,
  fromUSDT,
  getUSDTBalance,
  getOnChainPositions,
  getEarningsCapStatus,
  getUnclaimedEarnings,
  distributeROI,
  distributeCommissions,
  setVIPInvestment,
  grantLeaderPackage,
  createRedemptionOrder,
  approveRedemption,
  rejectRedemption,
  lockClaims,
  unlockClaims,
  isClaimLocked,
  isPositionHidden,
  getTotalValueLocked,
  verifySignature,
};
