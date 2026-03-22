// ══════════════════════════════════════
// Veltura — Admin Routes (In-Memory)
// ══════════════════════════════════════

const router = require('express').Router();
const db = require('../config/db');
const config = require('../config');
const { authenticate, requireRegistered, requireAdmin } = require('../middleware/auth');
const blockchain = require('../services/blockchain');
const treeService = require('../services/tree');

// All admin routes require admin auth
router.use(authenticate, requireRegistered, requireAdmin);

// ── GET /api/admin/lookup/:query ──
router.get('/lookup/:query', (req, res) => {
  try {
    const query = req.params.query.trim();

    let user;
    if (query.startsWith('0x') && query.length === 42) {
      user = db.findUser((u) => u.wallet.toLowerCase() === query.toLowerCase());
    } else {
      const username = query.replace(/^@/, '').toLowerCase();
      user = db.findUser((u) => u.username.toLowerCase() === username);
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const positions = db.store.positions
      .filter((p) => p.user_id === user.id)
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

    // Get referrer
    let referrer = null;
    if (user.referrer_id) {
      const refUser = db.findUser((u) => u.id === user.referrer_id);
      if (refUser) referrer = { username: refUser.username, wallet: refUser.wallet };
    }

    // Get earnings
    const types = ['daily_profit', 'binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards'];
    const earningsBreakdown = types.map((type) => {
      const rows = db.store.earnings.filter((e) => e.user_id === user.id && e.income_type === type);
      return {
        type,
        earned: rows.reduce((s, e) => s + e.total_earned, 0),
        claimed: rows.reduce((s, e) => s + e.total_claimed, 0),
        unclaimed: rows.reduce((s, e) => s + (e.total_earned - e.total_claimed), 0),
      };
    });

    // Claims
    const claims = db.store.claims
      .filter((c) => c.user_id === user.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 20);

    // Network
    const volumes = treeService.getLeftRightVolumes(user.id);
    const teamCounts = treeService.getTeamCounts(user.id);
    const directReferrals = treeService.getDirectReferrals(user.id);

    res.json({
      user: {
        id: user.id,
        wallet: user.wallet,
        username: user.username,
        referrer,
        placement: user.placement,
        createdAt: user.created_at,
      },
      positions: positions.map((p) => ({
        id: p.id,
        packageId: p.package_id,
        packageName: config.packages[p.package_id]?.name || p.package_id,
        amount: p.amount,
        tier: p.tier,
        dailyRate: p.daily_rate,
        lockDays: p.lock_days,
        status: p.status,
        startedAt: p.started_at,
        expiresAt: p.expires_at,
      })),
      earnings: { breakdown: earningsBreakdown },
      claims: claims.map((c) => ({
        id: c.id,
        gross: c.gross_amount,
        fee: c.fee_amount,
        net: c.net_amount,
        breakdown: c.breakdown,
        status: c.status,
        txHash: c.tx_hash,
        date: c.created_at,
      })),
      network: {
        directReferrals: directReferrals.length,
        totalMembers: teamCounts.total,
        leftLeg: { members: teamCounts.leftCount, volume: volumes.leftVolume, vipVolume: volumes.leftVipVolume },
        rightLeg: { members: teamCounts.rightCount, volume: volumes.rightVolume, vipVolume: volumes.rightVipVolume },
      },
    });
  } catch (err) {
    console.error('[Admin] Lookup error:', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ── GET /api/admin/stats ──
router.get('/stats', (req, res) => {
  try {
    const activePositions = db.store.positions.filter((p) => p.status === 'active');
    const tvl = activePositions.reduce((s, p) => s + p.amount, 0);
    const activeInvestors = new Set(activePositions.map((p) => p.user_id)).size;

    const pendingRedemptions = db.store.redemptions.filter((r) => r.status === 'pending');
    const totalEarned = db.store.earnings.reduce((s, e) => s + e.total_earned, 0);
    const totalClaimed = db.store.earnings.reduce((s, e) => s + e.total_claimed, 0);

    res.json({
      totalValueLocked: tvl,
      activeInvestors,
      totalUsers: db.store.users.length,
      totalPackages: activePositions.length,
      pendingRedemptions: {
        count: pendingRedemptions.length,
        total: pendingRedemptions.reduce((s, r) => s + r.amount, 0),
      },
      totalDistributed: totalEarned,
      totalClaimed,
    });
  } catch (err) {
    console.error('[Admin] Stats error:', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── POST /api/admin/grant-leader ──
router.post('/grant-leader', (req, res) => {
  try {
    const { wallet, amount, hidden } = req.body;

    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const amountNum = parseFloat(amount) || 0;
    if (amountNum < 10) {
      return res.status(400).json({ error: 'Minimum amount is $10' });
    }

    if (hidden && !req.user.isSuperWallet) {
      return res.status(403).json({ error: 'Only Super Wallet can create hidden positions' });
    }

    const user = db.findUser((u) => u.wallet.toLowerCase() === wallet.toLowerCase());
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const now = new Date();
    const posId = db.nextPositionId();
    db.store.positions.push({
      id: posId,
      user_id: user.id,
      package_id: 'exclusive360_leader',
      amount: amountNum,
      tier: 3,
      daily_rate: 1.20,
      lock_days: 360,
      status: 'active',
      started_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 360 * 24 * 60 * 60 * 1000).toISOString(),
      tx_hash: null,
    });

    treeService.updateVolumes(user.id, amountNum, true);
    db.persist();

    // Non-blocking on-chain grant
    blockchain.grantLeaderPackage(wallet, amountNum, !!hidden).catch((err) => {
      console.error('[Admin] On-chain leader grant failed:', err.message);
    });

    res.json({
      success: true,
      positionId: posId,
      user: { id: user.id, username: user.username, wallet },
      amount: amountNum,
      hidden: !!hidden,
    });
  } catch (err) {
    console.error('[Admin] Grant leader error:', err.message);
    res.status(500).json({ error: 'Failed to grant leader package' });
  }
});

// ── GET /api/admin/config ── read all commission/fee settings
router.get('/config', (req, res) => {
  try {
    const keys = ['comm_binary_bonus', 'comm_referral', 'comm_binary', 'comm_momentum', 'earnings_cap_multi', 'fee_claim', 'fee_redeem'];
    const config = {};
    keys.forEach(k => {
      config[k] = parseFloat(db.getConfigValue(k)) || 0;
    });
    res.json(config);
  } catch (err) {
    console.error('[Admin] Config read error:', err.message);
    res.status(500).json({ error: 'Failed to load config' });
  }
});

// ── POST /api/admin/config ── update commission/fee settings
router.post('/config', (req, res) => {
  try {
    const allowed = {
      comm_binary_bonus:  { min: 0, max: 20, label: 'Binary Bonus' },
      comm_referral:      { min: 0, max: 30, label: 'Referral Commission' },
      comm_binary:        { min: 0, max: 30, label: 'Binary Commission' },
      comm_momentum:      { min: 0, max: 20, label: 'Momentum Rewards' },
      earnings_cap_multi: { min: 100, max: 1000, label: 'Earnings Cap' },
      fee_claim:          { min: 0, max: 10, label: 'Claim Fee' },
      fee_redeem:         { min: 0, max: 10, label: 'Redemption Fee' },
    };

    const updates = {};
    for (const [key, val] of Object.entries(req.body)) {
      if (!allowed[key]) continue;
      const num = parseFloat(val);
      if (isNaN(num)) return res.status(400).json({ error: `Invalid value for ${allowed[key].label}` });
      if (num < allowed[key].min || num > allowed[key].max) {
        return res.status(400).json({ error: `${allowed[key].label} must be ${allowed[key].min}-${allowed[key].max}%` });
      }
      updates[key] = num;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid config keys provided' });
    }

    for (const [key, val] of Object.entries(updates)) {
      db.setConfigValue(key, val);
    }

    console.log('[Admin] Config updated by', req.user.wallet, ':', updates);
    res.json({ success: true, updated: updates });
  } catch (err) {
    console.error('[Admin] Config update error:', err.message);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

module.exports = router;
