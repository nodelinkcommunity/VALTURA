const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'backend', 'data', 'db.json');
const DEPLOYMENT_PATH = path.join(ROOT, 'deployment-amoy-v3.json');
const BACKUP_DIR = path.join(ROOT, 'backups', `reset-${new Date().toISOString().replace(/[:.]/g, '-')}`);

function buildDefaultConfig() {
  return [
    { key: 'earnings_cap_multi', value: '300', description: 'Earnings Cap multiplier (%)' },
    { key: 'comm_binary_bonus', value: '5', description: 'Binary bonus rate (%)' },
    { key: 'comm_referral', value: '10', description: 'Referral commission rate (%)' },
    { key: 'comm_binary', value: '15', description: 'Binary commission rate (%)' },
    { key: 'comm_momentum', value: '10', description: 'Momentum rewards rate (%)' },
    { key: 'fee_claim', value: '2.5', description: 'Claim fee (%)' },
    { key: 'fee_redeem', value: '5', description: 'Redemption fee (%)' },
    { key: 'fund_trading_pct', value: '85', description: 'Trading fund allocation (%)' },
    { key: 'fund_reward_pct', value: '15', description: 'Reward fund allocation (%)' },
    { key: 'maxout_essential', value: '300', description: 'Essential maxout (%)' },
    { key: 'maxout_classic', value: '300', description: 'Classic maxout (%)' },
    { key: 'maxout_ultimate', value: '300', description: 'Ultimate maxout (%)' },
    { key: 'maxout_signature', value: '300', description: 'Signature maxout (%)' },
    { key: 'maxout_exclusive', value: '300', description: 'Exclusive maxout (%)' },
    { key: 'maxout_leader', value: '300', description: 'Leader maxout (%)' },
  ];
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function main() {
  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error(`Missing deployment file: ${DEPLOYMENT_PATH}`);
  }

  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'));
  const ownerWallet = String(deployment.deployer || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(ownerWallet)) {
    throw new Error(`Invalid deployer/owner wallet in deployment file: ${ownerWallet}`);
  }

  ensureDir(BACKUP_DIR);
  if (fs.existsSync(DB_PATH)) {
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, 'db.json.backup'));
  }

  const now = new Date().toISOString();
  const cleanStore = {
    users: [
      {
        id: 1,
        wallet: ownerWallet,
        username: 'veltura',
        referrer_id: null,
        parent_id: null,
        leg: null,
        placement: null,
        created_at: now,
      },
    ],
    positions: [],
    earnings: [],
    claims: [],
    redemptions: [],
    commissions: [],
    transactions: [],
    earnings_lost: [],
    tree: [
      {
        user_id: 1,
        parent_id: null,
        side: null,
        left_child_id: null,
        right_child_id: null,
        left_volume: 0,
        right_volume: 0,
        left_vip_volume: 0,
        right_vip_volume: 0,
        left_vip_count: 0,
        right_vip_count: 0,
        left_roi: 0,
        right_roi: 0,
        carry_forward: 0,
        vip_sales_remaining: 0,
      },
    ],
    config: buildDefaultConfig(),
    _counters: {
      userId: 2,
      positionId: 1,
      claimId: 1,
      redeemId: 1,
      commissionId: 1,
      transactionId: 1,
    },
  };

  fs.writeFileSync(DB_PATH, JSON.stringify(cleanStore, null, 2));

  console.log('DB reset complete');
  console.log('Owner wallet:', ownerWallet);
  console.log('First user: veltura');
  console.log('Backup dir:', BACKUP_DIR);
}

main();
