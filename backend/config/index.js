// ══════════════════════════════════════
// Valtura — Platform Configuration
// ══════════════════════════════════════

require('dotenv').config();

const SUPER_WALLET = '0x031eA4bA7E1C5729C352e846549E9B5745f3C66E';

module.exports = {
  // ── Database ──
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'valtura',
    user: process.env.DB_USER || 'valtura',
    password: process.env.DB_PASS || '',
    max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },

  // ── JWT ──
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
    expiresIn: '7d',
  },

  // ── Server ──
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    env: process.env.NODE_ENV || 'development',
  },

  // ── Polygon / Blockchain ──
  polygon: {
    rpc: process.env.POLYGON_RPC || 'https://rpc-amoy.polygon.technology',
    chainId: parseInt(process.env.CHAIN_ID, 10) || 80002, // Amoy testnet
    privateKey: process.env.BACKEND_PRIVATE_KEY || '', // backend signer for on-chain calls
    // USDT address — testnet uses MockUSDT, mainnet uses real USDT
    usdtAddress: process.env.USDT_ADDRESS || '0x72695afc10147b50C404F4FC9bFeab78F3B06f21',
    // Contract addresses — defaults match Amoy testnet deployment
    contracts: {
      accessControl: process.env.ACCESS_CONTROL_ADDRESS || '0xb00eCFbf743CDE003c5C3637608b869550Aa7a67',
      valturVault: process.env.VALTUR_VAULT_ADDRESS || '0x690611828a631C3753c675e38244b8E010d8EB44',
      roiDistributor: process.env.ROI_DISTRIBUTOR_ADDRESS || '0xCC6D035a198799dA150c28eC1e5F1946A6a8fee1',
      commissionPayout: process.env.COMMISSION_PAYOUT_ADDRESS || '0xcEaeb03c9DCC954e4A520F0c6B773644ed9ce730',
      redemptionManager: process.env.REDEMPTION_MANAGER_ADDRESS || '0x4bc65f438521527972d413812CfAaeabD6ffcd53',
    },
  },

  // ── Super Wallet ──
  superWallet: SUPER_WALLET,

  // ── Package definitions ──
  packages: {
    essential:           { id: 'essential',           name: 'Essential',           lock: 0,   tiers: [0.20, 0.25, 0.35], min: 10, affiliate: false, packageType: 1 },
    classic30:           { id: 'classic30',           name: 'Classic',             lock: 30,  tiers: [0.25, 0.35, 0.45], min: 10, affiliate: false, packageType: 2 },
    ultimate90:          { id: 'ultimate90',          name: 'Ultimate',            lock: 90,  tiers: [0.40, 0.50, 0.60], min: 10, affiliate: false, packageType: 3 },
    signature180:        { id: 'signature180',        name: 'Signature',           lock: 180, tiers: [0.60, 0.70, 0.80], min: 10, affiliate: false, packageType: 4 },
    exclusive360:        { id: 'exclusive360',        name: 'Exclusive (VIP-360)', lock: 360, tiers: [0.80, 1.00, 1.20], min: 10, affiliate: true,  packageType: 5, earningsCap: 300 },
    exclusive360_leader: { id: 'exclusive360_leader', name: 'Exclusive Leader',    lock: 360, tiers: [0.80, 1.00, 1.20], min: 10, affiliate: true,  packageType: 6, earningsCap: 300 },
  },

  // ── Commission rates (defaults, can be overridden in platform_config) ──
  commissionRates: {
    binaryBonus: 5,       // 5% on Signature + Exclusive investment volume (weak leg)
    referral: 10,         // 10% on F1 daily profit
    binaryCommission: 15, // 15% on weak leg daily profit
  },

  // ── Momentum levels ──
  momentum: [
    { level: 1,  threshold: 10000,    reward: 250 },
    { level: 2,  threshold: 25000,    reward: 500 },
    { level: 3,  threshold: 50000,    reward: 1000 },
    { level: 4,  threshold: 100000,   reward: 2500 },
    { level: 5,  threshold: 250000,   reward: 5000 },
    { level: 6,  threshold: 500000,   reward: 10000 },
    { level: 7,  threshold: 1000000,  reward: 25000 },
    { level: 8,  threshold: 2500000,  reward: 50000 },
    { level: 9,  threshold: 5000000,  reward: 100000 },
    { level: 10, threshold: 10000000, reward: 250000 },
  ],

  // ── Fees ──
  fees: {
    claim: 2.5,   // 2.5% claim fee
    redeem: 5,    // 5% redemption fee
  },

  // ── USDT decimals ──
  USDT_DECIMALS: 6,

  // ── Tier thresholds (total team volume for tier upgrades) ──
  tierThresholds: {
    1: 0,       // default
    2: 50000,   // $50K team volume
    3: 250000,  // $250K team volume
  },
};
