// ══════════════════════════════════════
// Veltura — Blockchain Service (ethers.js v6)
// ══════════════════════════════════════

const { ethers } = require('ethers');
const config = require('../config');

// ── ABI fragments (only the functions we call from backend) ──

const ACCESS_CONTROL_ABI = [
  'function owner() view returns (address)',
  'function admins(address) view returns (bool)',
  'function S_WALLET() view returns (address)',
  'function isAuthorized(address) view returns (bool)',
  'function isHidden(address user, uint256 posId) view returns (bool)',
  'function claimLocked(address) view returns (bool)',
  'function setClaimLock(address user, bool locked)',
];

const VAULT_ABI = [
  'function deposit(uint256 amount, uint256 lockDays, uint8 tier, uint8 packageType)',
  'function grantLeaderPackage(address user, uint256 amount, bool hidden)',
  'function requestRedemption(address user, uint256 posId)',
  'function withdrawToTradingFund(uint256 amount)',
  'function setTradingFundAddress(address _new)',
  'function getPosition(address user, uint256 posId) view returns (uint256 amount, uint256 startTime, uint256 lockDays, uint8 tier, uint8 packageType, bool active, bool isGranted)',
  'function getUserPositionCount(address user) view returns (uint256)',
  'function totalDeposited() view returns (uint256)',
  'function totalValueLocked() view returns (uint256)',
  'function positions(address, uint256) view returns (uint256 amount, uint256 startTime, uint256 lockDays, uint8 tier, uint8 packageType, bool active, bool isGranted)',
  'event Deposited(address indexed user, uint256 amount, uint8 packageType, uint8 tier)',
  'function approvePayoutContract(address contractAddr, uint256 amount)',
];

const TRADING_FUNDS_ABI = [
  'function withdraw(address to, uint256 amount)',
  'function transferToVault(address vault, uint256 amount)',
  'function getBalance() view returns (uint256)',
];

const ROI_DISTRIBUTOR_ABI = [
  'function distributeROI(address[] users, uint256[] amounts, uint256 epoch)',
  'function claimROI()',
  'function getPendingROI(address user) view returns (uint256)',
  'function totalDistributed() view returns (uint256)',
  'function setClaimFee(uint256 _bps)',
  'function vault() view returns (address)',
  'function setVault(address _vault)',
  'event ROIClaimed(address indexed user, uint256 gross, uint256 fee, uint256 net)',
];

const COMMISSION_PAYOUT_ABI = [
  'function distributeCommissions(address[] users, uint8[] types, uint256[] amounts, uint256 epoch)',
  'function claimAllEarnings()',
  'function setVIPInvestment(address user, uint256 amount)',
  'function getUnclaimedEarnings(address user) view returns (uint256[5] unclaimed, uint256 total)',
  'function getEarningsCapStatus(address user) view returns (uint256 investment, uint256 capLimit, uint256 totalEarned, uint256 remaining)',
  'function vipInvestment(address) view returns (uint256)',
  'function setEarningsCapMultiplier(uint256 _multiplier)',
  'function setClaimFee(uint256 _bps)',
  'function vault() view returns (address)',
  'function setVault(address _vault)',
  'event EarningsClaimed(address indexed user, uint256 gross, uint256 fee, uint256 net)',
];

const REDEMPTION_MANAGER_ABI = [
  'function createOrder(address user, uint256 posId, uint256 amount)',
  'function approveRedemption(uint256 orderId)',
  'function rejectRedemption(uint256 orderId, uint8 reason)',
  'function getOrder(uint256 orderId) view returns (address user, uint256 posId, uint256 amount, uint256 createdAt, uint8 status)',
  'function setRedemptionFee(uint256 _bps)',
  'event OrderCreated(uint256 indexed orderId, address indexed user, uint256 posId, uint256 amount)',
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

function getTradingFunds(write = false) {
  return getContract('tradingFunds', config.polygon.contracts.tradingFunds, TRADING_FUNDS_ABI, write);
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

async function getUserPositionCount(userAddress) {
  const vault = getVault();
  const count = await vault.getUserPositionCount(userAddress);
  return Number(count);
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
  const receipt = await tx.wait();
  const orderCreated = receipt.logs.map((log) => {
    try { return rm.interface.parseLog(log); } catch (e) { return null; }
  }).find((event) => event && event.name === 'OrderCreated');

  return {
    receipt,
    orderId: orderCreated ? Number(orderCreated.args[0]) : null,
  };
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
  const tx = await ac.setClaimLock(userAddress, true);
  return tx.wait();
}

async function unlockClaims(userAddress) {
  const ac = getAccessControl(true);
  const tx = await ac.setClaimLock(userAddress, false);
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


// ── Check if wallet has admin role on-chain ──
async function checkAdminRole(wallet) {
  try {
    const provider = getProvider();
    const ac = new ethers.Contract(config.polygon.contracts.accessControl, ACCESS_CONTROL_ABI, provider);
    const w = wallet.toLowerCase();

    // Check if owner
    const owner = await ac.owner();
    if (owner.toLowerCase() === w) return true;

    // Check if admin
    const isAdmin = await ac.admins(wallet);
    if (isAdmin) return true;

    return false;
  } catch (e) {
    console.warn('[Blockchain] checkAdminRole error:', e.message);
    return false;
  }
}


// ── Verify deposit transaction on-chain ──
async function verifyDepositTransaction(txHash, expectedAmount, userWallet) {
  try {
    const provider = getProvider();
    const [receipt, tx] = await Promise.all([
      provider.getTransactionReceipt(txHash),
      provider.getTransaction(txHash),
    ]);
    if (!receipt || receipt.status !== 1) {
      throw new Error('Transaction failed or not found');
    }

    const vaultAddr = config.polygon.contracts.valturVault.toLowerCase();
    const usdtAddr = config.polygon.usdtAddress.toLowerCase();
    const normalizedUserWallet = userWallet ? userWallet.toLowerCase() : null;
    const vault = getVault();
    const usdt = getUSDT();

    function buildVerifiedResult(amount, user) {
      if (Math.abs(amount - expectedAmount) > 0.01) {
        throw new Error('Amount mismatch');
      }
      const normalizedUser = user ? user.toLowerCase() : null;
      if (normalizedUserWallet && normalizedUser && normalizedUser !== normalizedUserWallet) {
        throw new Error('User wallet mismatch');
      }
      return { verified: true, amount, user: normalizedUser };
    }

    // Parse Deposited event from Vault
    const depositedEvents = receipt.logs.map(log => {
      try { return vault.interface.parseLog(log); } catch(e) { return null; }
    }).filter(e => e && e.name === 'Deposited');

    if (depositedEvents.length > 0) {
      const event = depositedEvents[0];
      return buildVerifiedResult(fromUSDT(event.args[1]), event.args[0]);
    }

    if (tx) {
      const txTo = tx.to ? tx.to.toLowerCase() : null;

      if (txTo === usdtAddr) {
        try {
          const parsedUsdtTx = usdt.interface.parseTransaction({ data: tx.data, value: tx.value });
          if (parsedUsdtTx && parsedUsdtTx.name === 'approve') {
            throw new Error('Approve transaction provided; expected Vault.deposit transaction');
          }
        } catch (parseErr) {
          if (parseErr.message === 'Approve transaction provided; expected Vault.deposit transaction') {
            throw parseErr;
          }
        }
      }

      if (txTo && txTo !== vaultAddr && txTo !== usdtAddr) {
        throw new Error('Transaction was not sent to Vault');
      }

      if (txTo === vaultAddr) {
        try {
          const parsedVaultTx = vault.interface.parseTransaction({ data: tx.data, value: tx.value });
          if (parsedVaultTx && parsedVaultTx.name === 'deposit') {
            return buildVerifiedResult(fromUSDT(parsedVaultTx.args[0]), tx.from);
          }
        } catch (e) { /* keep falling back to logs */ }
      }
    }

    // Final fallback: check USDT Transfer to vault
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    let depositAmount = 0;
    let fromAddress = null;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === usdtAddr && log.topics[0] === transferTopic) {
        try {
          const to = ethers.getAddress("0x" + log.topics[2].slice(26));
          const from = ethers.getAddress("0x" + log.topics[1].slice(26));
          const value = ethers.toBigInt(log.data);
          if (to.toLowerCase() === vaultAddr) {
            depositAmount = fromUSDT(value);
            fromAddress = from;
          }
        } catch (e) { /* skip */ }
      }
    }

    if (depositAmount === 0) {
      throw new Error('No Deposited event found');
    }
    return buildVerifiedResult(depositAmount, fromAddress || (tx ? tx.from : null));
  } catch (err) {
    console.error("[Blockchain] Verify deposit tx error:", err.message);
    throw err;
  }
}

async function verifyClaimTx(txHash, userWallet, kind) {
  const provider = getProvider();
  const [receipt, tx] = await Promise.all([
    provider.getTransactionReceipt(txHash),
    provider.getTransaction(txHash),
  ]);

  if (!receipt || receipt.status !== 1) {
    throw new Error('Claim transaction failed or not found');
  }

  const normalizedUser = userWallet.toLowerCase();
  const isCommission = kind === 'commission';
  const address = isCommission
    ? config.polygon.contracts.commissionPayout
    : config.polygon.contracts.roiDistributor;
  const contract = isCommission ? getCommissionPayout() : getROIDistributor();
  const expectedMethod = isCommission ? 'claimAllEarnings' : 'claimROI';
  const expectedEvent = isCommission ? 'EarningsClaimed' : 'ROIClaimed';

  if (!tx || !tx.to || tx.to.toLowerCase() !== address.toLowerCase()) {
    throw new Error('Claim transaction target mismatch');
  }
  if (!tx.from || tx.from.toLowerCase() !== normalizedUser) {
    throw new Error('Claim transaction wallet mismatch');
  }

  const parsedTx = contract.interface.parseTransaction({ data: tx.data, value: tx.value });
  if (!parsedTx || parsedTx.name !== expectedMethod) {
    throw new Error(`Expected ${expectedMethod} transaction`);
  }

  const claimEvent = receipt.logs.map((log) => {
    try { return contract.interface.parseLog(log); } catch (e) { return null; }
  }).find((event) => event && event.name === expectedEvent);

  if (!claimEvent) {
    throw new Error(`No ${expectedEvent} event found`);
  }

  if (claimEvent.args[0].toLowerCase() !== normalizedUser) {
    throw new Error('Claim event wallet mismatch');
  }

  return {
    txHash,
    gross: fromUSDT(claimEvent.args[1]),
    fee: fromUSDT(claimEvent.args[2]),
    net: fromUSDT(claimEvent.args[3]),
  };
}

async function verifyCommissionClaimTransaction(txHash, userWallet) {
  return verifyClaimTx(txHash, userWallet, 'commission');
}

async function verifyROIClaimTransaction(txHash, userWallet) {
  return verifyClaimTx(txHash, userWallet, 'roi');
}


// ── TradingFunds operations ──
async function withdrawToTradingFund(amount) {
  const vault = getVault(true);
  const tx = await vault.withdrawToTradingFund(toUSDT(amount));
  return tx.wait();
}

async function tradingFundsWithdraw(toWallet, amount) {
  const tf = getTradingFunds(true);
  const tx = await tf.withdraw(toWallet, toUSDT(amount));
  return tx.wait();
}

async function tradingFundsTransferToVault(amount) {
  const tf = getTradingFunds(true);
  const vaultAddress = config.polygon.contracts.valturVault;
  const tx = await tf.transferToVault(vaultAddress, toUSDT(amount));
  return tx.wait();
}

async function getTradingFundsBalance() {
  const tf = getTradingFunds();
  const balance = await tf.getBalance();
  return fromUSDT(balance);
}

// ── On-chain config sync ──
async function setCommissionClaimFee(bps) {
  const cp = getCommissionPayout(true);
  const tx = await cp.setClaimFee(bps);
  return tx.wait();
}

async function setROIClaimFee(bps) {
  const roi = getROIDistributor(true);
  const tx = await roi.setClaimFee(bps);
  return tx.wait();
}

async function setRedemptionFee(bps) {
  const rm = getRedemptionManager(true);
  const tx = await rm.setRedemptionFee(bps);
  return tx.wait();
}

async function setEarningsCapMultiplier(value) {
  const cp = getCommissionPayout(true);
  const tx = await cp.setEarningsCapMultiplier(value);
  return tx.wait();
}

// ── Vault requestRedemption (admin calls with user address) ──
async function vaultRequestRedemption(userWallet, onChainIndex) {
  const vault = getVault(true);
  // Use the overload that takes (address, uint256)
  const tx = await vault['requestRedemption(address,uint256)'](userWallet, onChainIndex);
  return tx.wait();
}


module.exports = {
  checkAdminRole,
  getProvider,
  getSigner,
  getAccessControl,
  getVault,
  getTradingFunds,
  getROIDistributor,
  getCommissionPayout,
  getRedemptionManager,
  getUSDT,
  toUSDT,
  fromUSDT,
  getUSDTBalance,
  getOnChainPositions,
  getUserPositionCount,
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
  verifyDepositTransaction,
  verifyCommissionClaimTransaction,
  verifyROIClaimTransaction,
  withdrawToTradingFund,
  tradingFundsWithdraw,
  tradingFundsTransferToVault,
  getTradingFundsBalance,
  setCommissionClaimFee,
  setROIClaimFee,
  setRedemptionFee,
  setEarningsCapMultiplier,
  vaultRequestRedemption,
};
