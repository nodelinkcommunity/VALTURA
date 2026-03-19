module.exports = {
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'valtura',
    user: process.env.DB_USER || 'valtura',
    password: process.env.DB_PASS || ''
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
    expiresIn: '7d'
  },
  polygon: {
    rpc: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
    contractAddress: process.env.CONTRACT_ADDRESS || '',
    usdtAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
  },
  packages: {
    essential: { lock: 0, tiers: [0.20, 0.25, 0.35], min: 10, affiliate: false },
    classic30: { lock: 30, tiers: [0.25, 0.35, 0.45], min: 10, affiliate: false },
    ultimate90: { lock: 90, tiers: [0.40, 0.50, 0.60], min: 10, affiliate: false },
    signature180: { lock: 180, tiers: [0.60, 0.70, 0.80], min: 10, affiliate: false },
    exclusive360: { lock: 360, tiers: [0.80, 1.00, 1.20], min: 10, affiliate: true, earningsCap: 300 }
  }
};
