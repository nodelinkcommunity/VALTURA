// ══════════════════════════════════════
// Valtura — In-Memory Database Store
// ══════════════════════════════════════

let _nextUserId = 1;
let _nextPositionId = 1;
let _nextClaimId = 1;
let _nextRedeemId = 1;
let _nextCommissionId = 1;

const store = {
  // ── Users ──
  // { id, wallet, username, referrer_id, placement, created_at }
  users: [],

  // ── Positions (investments) ──
  // { id, user_id, package_id, amount, tier, daily_rate, lock_days, status, started_at, expires_at, tx_hash }
  positions: [],

  // ── Earnings (aggregated per user/position/income_type) ──
  // { user_id, position_id, income_type, total_earned, total_claimed, updated_at }
  earnings: [],

  // ── Claim transactions ──
  // { id, user_id, gross_amount, fee_percent, fee_amount, net_amount, breakdown, status, tx_hash, created_at }
  claims: [],

  // ── Redeem orders ──
  // { id, user_id, position_id, amount, status, tx_hash, created_at, processed_at }
  redemptions: [],

  // ── Commissions log ──
  // { id, user_id, source_user, type, amount, description, created_at }
  commissions: [],

  // ── Binary tree ──
  // { user_id, parent_id, side, left_child_id, right_child_id,
  //   left_volume, right_volume, left_vip_volume, right_vip_volume,
  //   left_vip_count, right_vip_count, left_roi, right_roi,
  //   carry_forward, vip_sales_remaining }
  tree: [],

  // ── Platform config ──
  // { key, value, description }
  config: [
    { key: 'earnings_cap_multi', value: '300', description: 'Earnings Cap multiplier (%)' },
    { key: 'comm_binary_bonus', value: '5', description: 'Binary bonus rate (%)' },
    { key: 'comm_referral', value: '10', description: 'Referral commission rate (%)' },
    { key: 'comm_binary', value: '15', description: 'Binary commission rate (%)' },
    { key: 'fee_claim', value: '2.5', description: 'Claim fee (%)' },
    { key: 'fee_redeem', value: '5', description: 'Redemption fee (%)' },
  ],
};

// ── Helper: generate IDs ──
function nextUserId() { return _nextUserId++; }
function nextPositionId() { return _nextPositionId++; }
function nextClaimId() { return _nextClaimId++; }
function nextRedeemId() { return _nextRedeemId++; }
function nextCommissionId() { return _nextCommissionId++; }

// ── Helper: find / filter ──
function findUser(predicate) { return store.users.find(predicate) || null; }
function findUsers(predicate) { return store.users.filter(predicate); }

function getConfigValue(key) {
  const row = store.config.find((c) => c.key === key);
  return row ? row.value : null;
}

function setConfigValue(key, value) {
  const row = store.config.find((c) => c.key === key);
  if (row) {
    row.value = String(value);
  } else {
    store.config.push({ key, value: String(value), description: '' });
  }
}

// ── Tree helpers ──
function getTreeNode(userId) {
  return store.tree.find((n) => n.user_id === userId) || null;
}

function ensureTreeNode(userId) {
  let node = getTreeNode(userId);
  if (!node) {
    node = {
      user_id: userId,
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
    };
    store.tree.push(node);
  }
  return node;
}

module.exports = {
  store,
  nextUserId,
  nextPositionId,
  nextClaimId,
  nextRedeemId,
  nextCommissionId,
  findUser,
  findUsers,
  getConfigValue,
  setConfigValue,
  getTreeNode,
  ensureTreeNode,
};
