// ══════════════════════════════════════
// Veltura — Persistent JSON Database Store
// Saves to data/db.json on every write, restores on startup
// ══════════════════════════════════════

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

// Default empty store
const DEFAULT_STORE = {
  users: [],
  positions: [],
  earnings: [],
  claims: [],
  redemptions: [],
  commissions: [],
  tree: [],
  config: [
    { key: 'earnings_cap_multi', value: '300', description: 'Earnings Cap multiplier (%)' },
    { key: 'comm_binary_bonus', value: '5', description: 'Binary bonus rate (%)' },
    { key: 'comm_referral', value: '10', description: 'Referral commission rate (%)' },
    { key: 'comm_binary', value: '15', description: 'Binary commission rate (%)' },
    { key: 'comm_momentum', value: '10', description: 'Momentum rewards rate (%)' },
    { key: 'fee_claim', value: '2.5', description: 'Claim fee (%)' },
    { key: 'fee_redeem', value: '5', description: 'Redemption fee (%)' },
  ],
  _counters: { userId: 1, positionId: 1, claimId: 1, redeemId: 1, commissionId: 1 }
};

// ── Load from disk ──
function loadStore() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const data = JSON.parse(raw);
      console.log(`[DB] Loaded ${data.users?.length || 0} users, ${data.positions?.length || 0} positions from disk`);
      return { ...DEFAULT_STORE, ...data };
    }
  } catch (e) {
    console.warn('[DB] Failed to load db.json, starting fresh:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_STORE));
}

// ── Save to disk ──
function saveStore() {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.warn('[DB] Failed to save db.json:', e.message);
  }
}

// Debounced save (max every 500ms)
let _saveTimer = null;
function debouncedSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveStore, 500);
}

const store = loadStore();

// ── Helper: generate IDs (persistent counters) ──
function nextUserId() { const id = store._counters.userId++; debouncedSave(); return id; }
function nextPositionId() { const id = store._counters.positionId++; debouncedSave(); return id; }
function nextClaimId() { const id = store._counters.claimId++; debouncedSave(); return id; }
function nextRedeemId() { const id = store._counters.redeemId++; debouncedSave(); return id; }
function nextCommissionId() { const id = store._counters.commissionId++; debouncedSave(); return id; }

// ── Helper: find / filter ──
function findUser(predicate) { return store.users.find(predicate) || null; }
function findUsers(predicate) { return store.users.filter(predicate); }

function getConfigValue(key) {
  const row = store.config.find((c) => c.key === key);
  return row ? row.value : null;
}

function setConfigValue(key, value) {
  const row = store.config.find((c) => c.key === key);
  if (row) { row.value = String(value); }
  else { store.config.push({ key, value: String(value), description: '' }); }
  debouncedSave();
}

// ── Tree helpers ──
function getTreeNode(userId) {
  return store.tree.find((n) => n.user_id === userId) || null;
}

function ensureTreeNode(userId) {
  let node = getTreeNode(userId);
  if (!node) {
    node = {
      user_id: userId, parent_id: null, side: null,
      left_child_id: null, right_child_id: null,
      left_volume: 0, right_volume: 0,
      left_vip_volume: 0, right_vip_volume: 0,
      left_vip_count: 0, right_vip_count: 0,
      left_roi: 0, right_roi: 0,
      carry_forward: 0, vip_sales_remaining: 0,
    };
    store.tree.push(node);
    debouncedSave();
  }
  return node;
}

// ── Explicit save (call after bulk writes like register, deposit, etc.) ──
function persist() { saveStore(); }

module.exports = {
  store, persist,
  nextUserId, nextPositionId, nextClaimId, nextRedeemId, nextCommissionId,
  findUser, findUsers,
  getConfigValue, setConfigValue,
  getTreeNode, ensureTreeNode,
};
