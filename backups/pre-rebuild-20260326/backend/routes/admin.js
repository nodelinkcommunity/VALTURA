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

    const isSWLookup = req.user.isSWallet;
    const positions = db.store.positions
      .filter((p) => p.user_id === user.id && (isSWLookup || !p.hidden))
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

    // Network (exclude hidden position volumes for non-S_Wallet)
    const volumes = treeService.getLeftRightVolumes(user.id);
    const teamCounts = treeService.getTeamCounts(user.id);
    const directReferrals = treeService.getDirectReferrals(user.id);
    
    // Subtract hidden position amounts from volumes if not S_Wallet
    let hiddenAmount = 0;
    if (!isSWLookup) {
      const hiddenPositions = db.store.positions.filter((p) => p.user_id === user.id && p.hidden && p.status === 'active');
      hiddenAmount = hiddenPositions.reduce((s, p) => s + p.amount, 0);
    }

    // F1 volume calculations
    let f1TotalVolume = 0;
    let f1VipVolume = 0;
    for (const f1 of directReferrals) {
      const f1Positions = db.store.positions.filter((p) => p.user_id === f1.id && p.status === 'active' && (!p.hidden || isSWLookup));
      for (const p of f1Positions) {
        f1TotalVolume += p.amount;
        if (['signature180', 'exclusive360', 'exclusive360_leader'].includes(p.package_id)) {
          f1VipVolume += p.amount;
        }
      }
    }

    // Aggregate positions by package type for summary
    const packageSummary = {};
    for (const p of positions) {
      if (!packageSummary[p.package_id]) packageSummary[p.package_id] = 0;
      packageSummary[p.package_id] += p.amount;
    }

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
      packageSummary,
      network: {
        directReferrals: directReferrals.length,
        totalMembers: teamCounts.total,
        f1TotalVolume,
        f1VipVolume,
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
    const allActive = db.store.positions.filter((p) => p.status === 'active');
    const activePositions = allActive.filter((p) => !p.hidden);
    const tvl = activePositions.reduce((s, p) => s + p.amount, 0);
    const activeInvestors = new Set(activePositions.map((p) => p.user_id)).size;

    const pendingRedemptions = db.store.redemptions.filter((r) => r.status === 'pending');
    const totalEarned = db.store.earnings.reduce((s, e) => s + e.total_earned, 0);
    const totalClaimed = db.store.earnings.reduce((s, e) => s + e.total_claimed, 0);

    // VIP/Leader packages
    const leaderPositions = db.store.positions.filter((p) => p.package_id === 'exclusive360_leader');
    const isSWStats = req.user.isSWallet;
    const activeLeaders = leaderPositions.filter((p) => p.status === 'active' && (isSWStats || !p.hidden));
    const vipPositions = activeLeaders;
    const vipCapital = vipPositions.reduce((s, p) => s + p.amount, 0);

    // Deposit breakdown by package
    const breakdown = {};
    activePositions.forEach((p) => {
      const key = p.package_id || 'unknown';
      breakdown[key] = (breakdown[key] || 0) + p.amount;
    });

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
      vipIssued: activeLeaders.length,
      vipCapital,
      breakdown: {
        essential: breakdown['essential'] || 0,
        classic: breakdown['classic30'] || 0,
        ultimate: breakdown['ultimate90'] || 0,
        signature: breakdown['signature180'] || 0,
        exclusive: (breakdown['exclusive360'] || 0) + (breakdown['exclusive360_leader'] || 0),
      },
      /* Pool balances = TVL per package type */
      pools: {
        mainPool: tvl,
        vipPool: (breakdown['signature180'] || 0) + (breakdown['exclusive360'] || 0) + (breakdown['exclusive360_leader'] || 0),
        commissionPool: totalEarned - totalClaimed,
        rewardPool: 0,
      },
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

    if (hidden && !req.user.isSWallet) {
      return res.status(403).json({ error: 'Only S_Wallet can create hidden positions' });
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
      hidden: !!hidden,
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



// -- POST /api/admin/redeem-action -- approve or reject a redemption
router.post('/redeem-action', (req, res) => {
  try {
    const { id, action } = req.body;
    if (!id || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Provide id and action (approve|reject)' });
    }
    const redemption = db.store.redemptions.find(r => r.id === id || r.id === parseInt(id));
    if (!redemption) {
      return res.status(404).json({ error: 'Redemption not found' });
    }
    if (redemption.status !== 'pending') {
      return res.status(400).json({ error: 'Redemption already processed: ' + redemption.status });
    }
    redemption.status = action === 'approve' ? 'approved' : 'rejected';
    redemption.processed_at = new Date().toISOString();
    redemption.processed_by = req.user.wallet;
    db.persist();
    console.log('[Admin] Redemption', id, action, 'by', req.user.wallet);
    res.json({ success: true, id, action, status: redemption.status });
  } catch (err) {
    console.error('[Admin] Redeem-action error:', err.message);
    res.status(500).json({ error: 'Failed to process redemption' });
  }
});

// -- GET /api/admin/redemptions -- list all redemptions
router.get('/redemptions', (req, res) => {
  try {
    const status = req.query.status;
    let items = db.store.redemptions || [];
    if (status) items = items.filter(r => r.status === status);
    items = items.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const enriched = items.map(r => {
      const user = db.findUser(u => u.id === r.user_id);
      const pos = db.store.positions.find(p => p.id === r.position_id);
      return {
        id: r.id,
        wallet: user ? user.wallet : 'unknown',
        username: user ? user.username : 'unknown',
        packageName: pos ? (config.packages[pos.package_id] ? config.packages[pos.package_id].name : pos.package_id) : 'unknown',
        amount: r.amount || 0,
        status: r.status,
        createdAt: r.created_at,
        processedAt: r.processed_at || null,
      };
    });
    res.json({ redemptions: enriched });
  } catch (err) {
    console.error('[Admin] Redemptions list error:', err.message);
    res.status(500).json({ error: 'Failed to load redemptions' });
  }
});

// -- GET /api/admin/tree/:query -- get upline chain for a wallet/username
router.get('/tree/:query', (req, res) => {
  try {
    const query = req.params.query.trim();
    let user;
    if (query.startsWith('0x') && query.length === 42) {
      user = db.findUser(u => u.wallet.toLowerCase() === query.toLowerCase());
    } else {
      const username = query.replace(/^@/, '').toLowerCase();
      user = db.findUser(u => u.username.toLowerCase() === username);
    }
    if (!user) return res.status(404).json({ error: 'User not found' });

    const chain = [];
    let currentId = user.id;
    const seen = new Set();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const u = db.findUser(ux => ux.id === currentId);
      if (!u) break;
      const node = db.getTreeNode(currentId);
      const isSWTree = req.user.isSWallet;
      const positions = db.store.positions.filter(p => p.user_id === currentId && p.status === 'active' && (isSWTree || !p.hidden));
      const totalInvest = positions.reduce((s, p) => s + p.amount, 0);
      const teamCounts = treeService.getTeamCounts(currentId);
      const volumes = treeService.getLeftRightVolumes(currentId);
      chain.unshift({
        userId: u.id,
        wallet: u.wallet,
        username: u.username,
        totalInvest,
        leftVipVolume: volumes.leftVipVolume || 0,
        rightVipVolume: volumes.rightVipVolume || 0,
        downlines: teamCounts.total || 0,
        joinedAt: u.created_at,
        isQueried: currentId === user.id,
        packageName: positions.length > 0 ? (config.packages[positions[0].package_id] ? config.packages[positions[0].package_id].name : 'Active') : 'None',
      });
      if (node && node.parent_id) {
        currentId = node.parent_id;
      } else {
        break;
      }
    }
    res.json({ chain, levels: chain.length });
  } catch (err) {
    console.error('[Admin] Tree error:', err.message);
    res.status(500).json({ error: 'Failed to build tree' });
  }
});


// ── GET /api/admin/leaders ── list all leader packages
router.get('/leaders', (req, res) => {
  try {
    const leaders = db.store.positions
      .filter((p) => p.package_id === 'exclusive360_leader')
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

    // Filter hidden packages for non-S_Wallet admins
    const isSW = req.user.isSWallet;
    const filtered = isSW ? leaders : leaders.filter((p) => !p.hidden);

    const result = filtered.map((p) => {
      const user = db.findUser((u) => u.id === p.user_id);
      return {
        id: p.id,
        wallet: user ? user.wallet : 'unknown',
        username: user ? user.username : 'unknown',
        amount: p.amount,
        status: p.status,
        hidden: !!p.hidden,
        startedAt: p.started_at,
        expiresAt: p.expires_at,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[Admin] Leaders error:', err.message);
    res.status(500).json({ error: 'Failed to load leaders' });
  }
});

module.exports = router;
