// ══════════════════════════════════════
// Valtura — Admin Routes
// ══════════════════════════════════════

const router = require('express').Router();
const db = require('../config/db');
const config = require('../config');
const { authenticate, requireRegistered, requireAdmin, requireSuperWallet } = require('../middleware/auth');
const blockchain = require('../services/blockchain');
const roiService = require('../services/roi');
const treeService = require('../services/tree');

// All admin routes require admin auth
router.use(authenticate, requireRegistered, requireAdmin);

// ── GET /api/admin/lookup/:query ──
// Search by wallet address or @username
router.get('/lookup/:query', async (req, res) => {
  try {
    const query = req.params.query.trim();
    const isSuperWallet = req.user.isSuperWallet;

    let userQuery;
    let userParam;

    if (query.startsWith('0x') && query.length === 42) {
      // Search by wallet
      userQuery = 'SELECT * FROM users WHERE LOWER(wallet) = $1';
      userParam = query.toLowerCase();
    } else {
      // Search by username (strip leading @)
      const username = query.replace(/^@/, '').toLowerCase();
      userQuery = 'SELECT * FROM users WHERE LOWER(username) = $1';
      userParam = username;
    }

    const { rows: userRows } = await db.query(userQuery, [userParam]);
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userRows[0];
    const userId = user.id;

    // Get positions (filter hidden unless Super Wallet)
    let posQuery = `
      SELECT id, package_id, amount, tier, daily_rate, lock_days, status, started_at, expires_at, tx_hash
      FROM positions WHERE user_id = $1 ORDER BY started_at DESC
    `;
    const { rows: positions } = await db.query(posQuery, [userId]);

    // Filter hidden positions for non-Super callers
    let filteredPositions = positions;
    if (!isSuperWallet) {
      const visiblePositions = [];
      for (const pos of positions) {
        // Hidden positions are exclusive360_leader that were marked hidden
        // Check on-chain if possible, otherwise check by package type
        if (pos.package_id === 'exclusive360_leader') {
          try {
            const hidden = await blockchain.isPositionHidden(user.wallet, pos.id);
            if (hidden) continue;
          } catch (err) {
            // If on-chain check fails, include it
          }
        }
        visiblePositions.push(pos);
      }
      filteredPositions = visiblePositions;
    }

    // Get earnings
    const { rows: earnings } = await db.query(
      `SELECT income_type,
              SUM(total_earned) as total_earned,
              SUM(total_claimed) as total_claimed,
              SUM(total_earned - total_claimed) as unclaimed
       FROM earnings WHERE user_id = $1
       GROUP BY income_type`,
      [userId]
    );

    // Get claim history
    const { rows: claims } = await db.query(
      `SELECT id, gross_amount, fee_amount, net_amount, breakdown, status, tx_hash, created_at
       FROM claim_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );

    // Get Earnings Cap
    const capStatus = await roiService.getEarningsCapStatus(userId);

    // Get binary tree info
    const volumes = await treeService.getLeftRightVolumes(userId);
    const teamCounts = await treeService.getTeamCounts(userId);
    const directReferrals = await treeService.getDirectReferrals(userId);

    // Get referrer
    let referrer = null;
    if (user.referrer_id) {
      const { rows: refRows } = await db.query(
        'SELECT username, wallet FROM users WHERE id = $1',
        [user.referrer_id]
      );
      if (refRows.length > 0) referrer = refRows[0];
    }

    // Check claim lock status
    let claimLocked = false;
    try {
      claimLocked = await blockchain.isClaimLocked(user.wallet);
    } catch (err) {
      // Ignore on-chain check failure
    }

    res.json({
      user: {
        id: user.id,
        wallet: user.wallet,
        username: user.username,
        referrer,
        placement: user.placement,
        createdAt: user.created_at,
        claimLocked,
      },
      positions: filteredPositions.map((p) => ({
        id: p.id,
        packageId: p.package_id,
        packageName: config.packages[p.package_id]?.name || p.package_id,
        amount: parseFloat(p.amount),
        tier: p.tier,
        dailyRate: parseFloat(p.daily_rate),
        lockDays: p.lock_days,
        status: p.status,
        startedAt: p.started_at,
        expiresAt: p.expires_at,
      })),
      earnings: {
        breakdown: earnings.map((e) => ({
          type: e.income_type,
          earned: parseFloat(e.total_earned) || 0,
          claimed: parseFloat(e.total_claimed) || 0,
          unclaimed: parseFloat(e.unclaimed) || 0,
        })),
        cap: capStatus,
      },
      claims: claims.map((c) => ({
        id: c.id,
        gross: parseFloat(c.gross_amount),
        fee: parseFloat(c.fee_amount),
        net: parseFloat(c.net_amount),
        breakdown: c.breakdown,
        status: c.status,
        txHash: c.tx_hash,
        date: c.created_at,
      })),
      network: {
        directReferrals: directReferrals.length,
        totalMembers: teamCounts.total,
        leftLeg: {
          members: teamCounts.leftCount,
          volume: volumes.leftVolume,
          vipVolume: volumes.leftVipVolume,
          vipCount: volumes.leftVipCount,
        },
        rightLeg: {
          members: teamCounts.rightCount,
          volume: volumes.rightVolume,
          vipVolume: volumes.rightVipVolume,
          vipCount: volumes.rightVipCount,
        },
      },
    });
  } catch (err) {
    console.error('[Admin] Lookup error:', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ── GET /api/admin/user/:id/earnings ──
// User earnings breakdown for admin view
router.get('/user/:id/earnings', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);

    const { rows: user } = await db.query(
      'SELECT id, wallet, username FROM users WHERE id = $1',
      [userId]
    );
    if (user.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { rows: earnings } = await db.query(
      `SELECT e.income_type, e.position_id, e.total_earned, e.total_claimed, e.unclaimed, e.updated_at,
              p.package_id, p.amount as position_amount
       FROM earnings e
       JOIN positions p ON p.id = e.position_id
       WHERE e.user_id = $1
       ORDER BY e.income_type, e.position_id`,
      [userId]
    );

    const capStatus = await roiService.getEarningsCapStatus(userId);

    // Recent commission logs
    const { rows: recentCommissions } = await db.query(
      `SELECT type, amount, description, created_at
       FROM commissions WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );

    res.json({
      user: user[0],
      earnings: earnings.map((e) => ({
        incomeType: e.income_type,
        positionId: e.position_id,
        packageId: e.package_id,
        positionAmount: parseFloat(e.position_amount),
        totalEarned: parseFloat(e.total_earned),
        totalClaimed: parseFloat(e.total_claimed),
        unclaimed: parseFloat(e.unclaimed),
        updatedAt: e.updated_at,
      })),
      earningsCap: capStatus,
      recentCommissions: recentCommissions.map((c) => ({
        type: c.type,
        amount: parseFloat(c.amount),
        description: c.description,
        date: c.created_at,
      })),
    });
  } catch (err) {
    console.error('[Admin] User earnings error:', err.message);
    res.status(500).json({ error: 'Failed to load user earnings' });
  }
});

// ── POST /api/admin/rewards ──
// Update reward settings (Earnings Cap multiplier, commission rates)
router.post('/rewards', async (req, res) => {
  try {
    const { earningsCapMultiplier, binaryBonus, referralCommission, binaryCommission, claimFee, redeemFee } = req.body;

    const updates = [];

    if (earningsCapMultiplier !== undefined) {
      const val = parseFloat(earningsCapMultiplier);
      if (val < 100 || val > 1000) {
        return res.status(400).json({ error: 'Earnings Cap multiplier must be between 100 and 1000' });
      }
      updates.push({ key: 'earnings_cap_multi', value: String(val) });
    }

    if (binaryBonus !== undefined) {
      updates.push({ key: 'comm_binary_bonus', value: String(parseFloat(binaryBonus)) });
    }

    if (referralCommission !== undefined) {
      updates.push({ key: 'comm_referral', value: String(parseFloat(referralCommission)) });
    }

    if (binaryCommission !== undefined) {
      updates.push({ key: 'comm_binary', value: String(parseFloat(binaryCommission)) });
    }

    if (claimFee !== undefined) {
      updates.push({ key: 'fee_claim', value: String(parseFloat(claimFee)) });
    }

    if (redeemFee !== undefined) {
      updates.push({ key: 'fee_redeem', value: String(parseFloat(redeemFee)) });
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No settings to update' });
    }

    for (const update of updates) {
      await db.query(
        'UPDATE platform_config SET value = $1 WHERE key = $2',
        [update.value, update.key]
      );
    }

    // Read back all config
    const { rows: allConfig } = await db.query('SELECT key, value FROM platform_config');
    const currentConfig = {};
    for (const row of allConfig) {
      currentConfig[row.key] = row.value;
    }

    res.json({ success: true, config: currentConfig });
  } catch (err) {
    console.error('[Admin] Update rewards error:', err.message);
    res.status(500).json({ error: 'Failed to update reward settings' });
  }
});

// ── POST /api/admin/grant-leader ──
// Grant Exclusive Leader package to a user
router.post('/grant-leader', async (req, res) => {
  try {
    const { wallet, amount, hidden } = req.body;
    const isSuperWallet = req.user.isSuperWallet;

    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const amountNum = parseFloat(amount) || 0;
    if (amountNum < 10) {
      return res.status(400).json({ error: 'Minimum amount is $10' });
    }

    // Only Super Wallet can set hidden flag
    if (hidden && !isSuperWallet) {
      return res.status(403).json({ error: 'Only Super Wallet can create hidden positions' });
    }

    // Find user
    const { rows: userRows } = await db.query(
      'SELECT id, username FROM users WHERE LOWER(wallet) = $1',
      [wallet.toLowerCase()]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = userRows[0].id;

    // Insert leader position in DB
    const result = await db.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO positions (user_id, package_id, amount, tier, daily_rate, lock_days, status, expires_at)
         VALUES ($1, 'exclusive360_leader', $2, 3, 1.20, 360, 'active', NOW() + INTERVAL '360 days')
         RETURNING id, started_at`,
        [userId, amountNum]
      );

      // Update binary tree volumes (VIP)
      await treeService.updateVolumes(userId, amountNum, true, client);

      return rows[0];
    });

    // Grant on-chain (non-blocking)
    try {
      blockchain.grantLeaderPackage(wallet, amountNum, !!hidden).catch((err) => {
        console.error('[Admin] On-chain leader grant failed:', err.message);
      });
    } catch (err) {
      console.warn('[Admin] On-chain grant skipped:', err.message);
    }

    // Update VIP investment on-chain for Earnings Cap
    try {
      const { rows: vipRows } = await db.query(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM positions WHERE user_id = $1 AND status = 'active'
           AND package_id IN ('exclusive360', 'exclusive360_leader')`,
        [userId]
      );
      const vipTotal = parseFloat(vipRows[0]?.total) || 0;
      blockchain.setVIPInvestment(wallet, vipTotal).catch((err) => {
        console.error('[Admin] On-chain VIP investment update failed:', err.message);
      });
    } catch (err) {
      console.warn('[Admin] VIP investment update skipped:', err.message);
    }

    res.json({
      success: true,
      positionId: result.id,
      user: { id: userId, username: userRows[0].username, wallet },
      amount: amountNum,
      hidden: !!hidden,
      startedAt: result.started_at,
    });
  } catch (err) {
    console.error('[Admin] Grant leader error:', err.message);
    res.status(500).json({ error: 'Failed to grant leader package' });
  }
});

// ── GET /api/admin/stats ──
// Platform overview stats
router.get('/stats', async (req, res) => {
  try {
    // Total Value Locked
    const { rows: tvlRows } = await db.query(
      "SELECT COALESCE(SUM(amount), 0) as tvl FROM positions WHERE status = 'active'"
    );

    // Active investors
    const { rows: investorRows } = await db.query(
      "SELECT COUNT(DISTINCT user_id) as count FROM positions WHERE status = 'active'"
    );

    // Total users
    const { rows: userRows } = await db.query('SELECT COUNT(*) as count FROM users');

    // Total packages
    const { rows: packageRows } = await db.query(
      "SELECT package_id, COUNT(*) as count, SUM(amount) as volume FROM positions WHERE status = 'active' GROUP BY package_id"
    );

    // Pending redemptions
    const { rows: redeemRows } = await db.query(
      "SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM redeem_orders WHERE status = 'pending'"
    );

    // Total distributed (earnings)
    const { rows: earningsRows } = await db.query(
      'SELECT COALESCE(SUM(total_earned), 0) as total FROM earnings'
    );

    // Total claimed
    const { rows: claimedRows } = await db.query(
      'SELECT COALESCE(SUM(total_claimed), 0) as total FROM earnings'
    );

    res.json({
      totalValueLocked: parseFloat(tvlRows[0]?.tvl) || 0,
      activeInvestors: parseInt(investorRows[0]?.count, 10) || 0,
      totalUsers: parseInt(userRows[0]?.count, 10) || 0,
      totalPackages: packageRows.reduce((sum, r) => sum + parseInt(r.count, 10), 0),
      packageBreakdown: packageRows.map((r) => ({
        packageId: r.package_id,
        count: parseInt(r.count, 10),
        volume: parseFloat(r.volume) || 0,
      })),
      pendingRedemptions: {
        count: parseInt(redeemRows[0]?.count, 10) || 0,
        total: parseFloat(redeemRows[0]?.total) || 0,
      },
      totalDistributed: parseFloat(earningsRows[0]?.total) || 0,
      totalClaimed: parseFloat(claimedRows[0]?.total) || 0,
    });
  } catch (err) {
    console.error('[Admin] Stats error:', err.message);
    res.status(500).json({ error: 'Failed to load platform stats' });
  }
});

// ── GET /api/admin/redemptions ──
// List pending redemption orders
router.get('/redemptions', async (req, res) => {
  try {
    const isSuperWallet = req.user.isSuperWallet;
    const status = req.query.status || 'pending';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const offset = (page - 1) * limit;

    let query = `
      SELECT ro.id, ro.user_id, ro.position_id, ro.amount, ro.status, ro.tx_hash, ro.created_at, ro.processed_at,
             u.wallet, u.username,
             p.package_id
      FROM redeem_orders ro
      JOIN users u ON u.id = ro.user_id
      JOIN positions p ON p.id = ro.position_id
      WHERE ro.status = $1
    `;

    // Filter hidden positions for non-Super
    if (!isSuperWallet) {
      query += " AND p.package_id != 'exclusive360_leader'";
    }

    query += ' ORDER BY ro.created_at ASC LIMIT $2 OFFSET $3';

    const { rows } = await db.query(query, [status, limit, offset]);

    // Count total
    let countQuery = "SELECT COUNT(*) as total FROM redeem_orders WHERE status = $1";
    if (!isSuperWallet) {
      countQuery += " AND position_id NOT IN (SELECT id FROM positions WHERE package_id = 'exclusive360_leader')";
    }
    const { rows: countRows } = await db.query(countQuery, [status]);

    res.json({
      total: parseInt(countRows[0].total, 10),
      page,
      limit,
      redemptions: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        wallet: r.wallet,
        username: r.username,
        positionId: r.position_id,
        packageId: r.package_id,
        amount: parseFloat(r.amount),
        status: r.status,
        txHash: r.tx_hash,
        createdAt: r.created_at,
        processedAt: r.processed_at,
      })),
    });
  } catch (err) {
    console.error('[Admin] Redemptions error:', err.message);
    res.status(500).json({ error: 'Failed to load redemptions' });
  }
});

// ── POST /api/admin/redemptions/:id/approve ──
// Approve a redemption order
router.post('/redemptions/:id/approve', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);

    const { rows } = await db.query(
      `SELECT ro.*, u.wallet
       FROM redeem_orders ro
       JOIN users u ON u.id = ro.user_id
       WHERE ro.id = $1 AND ro.status = 'pending'`,
      [orderId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pending redemption order not found' });
    }

    const order = rows[0];

    // Update status in DB
    await db.query(
      "UPDATE redeem_orders SET status = 'approved', processed_at = NOW() WHERE id = $1",
      [orderId]
    );

    // Update position status
    await db.query(
      "UPDATE positions SET status = 'redeemed' WHERE id = $1",
      [order.position_id]
    );

    // Approve on-chain (non-blocking)
    let txHash = null;
    try {
      const receipt = await blockchain.approveRedemption(orderId);
      txHash = receipt.hash;
      await db.query(
        'UPDATE redeem_orders SET tx_hash = $1 WHERE id = $2',
        [txHash, orderId]
      );
    } catch (err) {
      console.error('[Admin] On-chain approval failed:', err.message);
    }

    res.json({
      success: true,
      orderId,
      txHash,
      message: 'Redemption approved',
    });
  } catch (err) {
    console.error('[Admin] Approve redemption error:', err.message);
    res.status(500).json({ error: 'Failed to approve redemption' });
  }
});

// ── POST /api/admin/redemptions/:id/reject ──
// Reject a redemption order
router.post('/redemptions/:id/reject', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { reason } = req.body; // 1-4

    const { rows } = await db.query(
      "SELECT * FROM redeem_orders WHERE id = $1 AND status = 'pending'",
      [orderId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pending redemption order not found' });
    }

    const order = rows[0];

    // Update status in DB
    await db.query(
      "UPDATE redeem_orders SET status = 'rejected', processed_at = NOW() WHERE id = $1",
      [orderId]
    );

    // Reactivate position
    await db.query(
      "UPDATE positions SET status = 'active' WHERE id = $1",
      [order.position_id]
    );

    // Reject on-chain (non-blocking)
    try {
      blockchain.rejectRedemption(orderId, reason || 4).catch((err) => {
        console.error('[Admin] On-chain rejection failed:', err.message);
      });
    } catch (err) {
      console.warn('[Admin] On-chain reject skipped:', err.message);
    }

    res.json({
      success: true,
      orderId,
      message: 'Redemption rejected',
    });
  } catch (err) {
    console.error('[Admin] Reject redemption error:', err.message);
    res.status(500).json({ error: 'Failed to reject redemption' });
  }
});

// ── POST /api/admin/lock-claims/:wallet ──
// Lock claims for a user
router.post('/lock-claims/:wallet', async (req, res) => {
  try {
    const wallet = req.params.wallet;

    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Lock on-chain
    try {
      await blockchain.lockClaims(wallet);
    } catch (err) {
      console.error('[Admin] On-chain lock failed:', err.message);
      return res.status(500).json({ error: 'Failed to lock claims on-chain' });
    }

    res.json({ success: true, wallet, locked: true });
  } catch (err) {
    console.error('[Admin] Lock claims error:', err.message);
    res.status(500).json({ error: 'Failed to lock claims' });
  }
});

// ── POST /api/admin/unlock-claims/:wallet ──
// Unlock claims for a user
router.post('/unlock-claims/:wallet', async (req, res) => {
  try {
    const wallet = req.params.wallet;

    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Unlock on-chain
    try {
      await blockchain.unlockClaims(wallet);
    } catch (err) {
      console.error('[Admin] On-chain unlock failed:', err.message);
      return res.status(500).json({ error: 'Failed to unlock claims on-chain' });
    }

    res.json({ success: true, wallet, locked: false });
  } catch (err) {
    console.error('[Admin] Unlock claims error:', err.message);
    res.status(500).json({ error: 'Failed to unlock claims' });
  }
});

module.exports = router;
