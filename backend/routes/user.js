// ══════════════════════════════════════
// Valtura — User Routes
// ══════════════════════════════════════

const router = require('express').Router();
const db = require('../config/db');
const config = require('../config');
const { authenticate, requireRegistered } = require('../middleware/auth');
const roiService = require('../services/roi');
const treeService = require('../services/tree');
const blockchain = require('../services/blockchain');

// All user routes require authentication + registration
router.use(authenticate, requireRegistered);

// ── GET /api/user/profile ──
// Full user profile with packages and earnings summary
router.get('/profile', async (req, res) => {
  try {
    const userId = req.user.id;

    // Get active positions/packages
    const { rows: positions } = await db.query(
      `SELECT id, package_id, amount, tier, daily_rate, lock_days, status, started_at, expires_at
       FROM positions WHERE user_id = $1 ORDER BY started_at DESC`,
      [userId]
    );

    // Get earnings summary
    const { rows: earnings } = await db.query(
      `SELECT income_type,
              SUM(total_earned) as total_earned,
              SUM(total_claimed) as total_claimed,
              SUM(total_earned - total_claimed) as unclaimed
       FROM earnings WHERE user_id = $1
       GROUP BY income_type`,
      [userId]
    );

    const earningsSummary = {};
    let totalEarned = 0;
    let totalClaimed = 0;
    let totalUnclaimed = 0;

    for (const e of earnings) {
      earningsSummary[e.income_type] = {
        earned: parseFloat(e.total_earned) || 0,
        claimed: parseFloat(e.total_claimed) || 0,
        unclaimed: parseFloat(e.unclaimed) || 0,
      };
      totalEarned += parseFloat(e.total_earned) || 0;
      totalClaimed += parseFloat(e.total_claimed) || 0;
      totalUnclaimed += parseFloat(e.unclaimed) || 0;
    }

    // Get Earnings Cap status
    const capStatus = await roiService.getEarningsCapStatus(userId);

    // Get total invested
    const totalInvested = positions
      .filter((p) => p.status === 'active')
      .reduce((sum, p) => sum + parseFloat(p.amount), 0);

    // Get referrer
    let referrer = null;
    if (req.user.referrerId) {
      const { rows: refRows } = await db.query(
        'SELECT username, wallet FROM users WHERE id = $1',
        [req.user.referrerId]
      );
      if (refRows.length > 0) {
        referrer = { username: refRows[0].username, wallet: refRows[0].wallet };
      }
    }

    // Get network stats
    const teamCounts = await treeService.getTeamCounts(userId);
    const directReferrals = await treeService.getDirectReferrals(userId);

    res.json({
      id: req.user.id,
      wallet: req.user.wallet,
      username: req.user.username,
      referrer,
      createdAt: req.user.createdAt,
      totalInvested,
      activePositions: positions.filter((p) => p.status === 'active').length,
      packages: positions.map((p) => ({
        id: p.id,
        packageId: p.package_id,
        name: config.packages[p.package_id]?.name || p.package_id,
        amount: parseFloat(p.amount),
        tier: p.tier,
        dailyRate: parseFloat(p.daily_rate),
        lockDays: p.lock_days,
        status: p.status,
        startedAt: p.started_at,
        expiresAt: p.expires_at,
      })),
      earnings: {
        total: totalEarned,
        claimed: totalClaimed,
        unclaimed: totalUnclaimed,
        breakdown: earningsSummary,
      },
      earningsCap: capStatus,
      network: {
        directReferrals: directReferrals.length,
        totalMembers: teamCounts.total,
        leftCount: teamCounts.leftCount,
        rightCount: teamCounts.rightCount,
      },
    });
  } catch (err) {
    console.error('[User] Profile error:', err.message);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ── GET /api/user/earnings ──
// Full earnings breakdown with all 5 income types
router.get('/earnings', async (req, res) => {
  try {
    const userId = req.user.id;

    // Get detailed earnings per income type
    const { rows: earnings } = await db.query(
      `SELECT income_type,
              SUM(total_earned) as total_earned,
              SUM(total_claimed) as total_claimed,
              SUM(total_earned - total_claimed) as unclaimed
       FROM earnings WHERE user_id = $1
       GROUP BY income_type`,
      [userId]
    );

    const types = ['daily_profit', 'binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards'];
    const breakdown = {};
    let totalEarned = 0;
    let totalClaimed = 0;
    let totalUnclaimed = 0;

    for (const type of types) {
      const found = earnings.find((e) => e.income_type === type);
      breakdown[type] = {
        total: parseFloat(found?.total_earned) || 0,
        claimed: parseFloat(found?.total_claimed) || 0,
        unclaimed: parseFloat(found?.unclaimed) || 0,
      };
      totalEarned += breakdown[type].total;
      totalClaimed += breakdown[type].claimed;
      totalUnclaimed += breakdown[type].unclaimed;
    }

    // Earnings Cap status
    const capStatus = await roiService.getEarningsCapStatus(userId);

    // Claim fee from config
    const { rows: feeRows } = await db.query(
      "SELECT value FROM platform_config WHERE key = 'fee_claim'"
    );
    const claimFee = parseFloat(feeRows[0]?.value) || 2.5;

    res.json({
      totalEarned,
      totalClaimed,
      totalUnclaimed,
      claimable: totalUnclaimed,
      claimFee,
      netClaimable: totalUnclaimed > 0 ? totalUnclaimed * (1 - claimFee / 100) : 0,
      earningsCap: capStatus,
      breakdown,
    });
  } catch (err) {
    console.error('[User] Earnings error:', err.message);
    res.status(500).json({ error: 'Failed to load earnings' });
  }
});

// ── POST /api/user/claim ──
// Claim all pending earnings
router.post('/claim', async (req, res) => {
  try {
    const userId = req.user.id;
    const wallet = req.user.wallet;

    // Check if claims are locked on-chain
    try {
      const locked = await blockchain.isClaimLocked(wallet);
      if (locked) {
        return res.status(403).json({ error: 'Claims are currently locked for your account' });
      }
    } catch (err) {
      console.warn('[User] Could not check claim lock on-chain:', err.message);
    }

    // Check if user has active Exclusive package (forfeiture rule for commissions)
    const hasExclusive = await roiService.hasActiveExclusive(userId);

    // Get all unclaimed earnings
    const { rows: earnings } = await db.query(
      `SELECT income_type,
              SUM(total_earned - total_claimed) as unclaimed
       FROM earnings WHERE user_id = $1
       GROUP BY income_type
       HAVING SUM(total_earned - total_claimed) > 0`,
      [userId]
    );

    if (earnings.length === 0) {
      return res.status(400).json({ error: 'No earnings to claim' });
    }

    // Build breakdown
    const breakdown = {};
    let grossAmount = 0;

    for (const e of earnings) {
      const unclaimed = parseFloat(e.unclaimed) || 0;
      // If no Exclusive, only daily profit is claimable (commissions forfeited)
      if (!hasExclusive && e.income_type !== 'daily_profit') {
        continue;
      }
      breakdown[e.income_type] = unclaimed;
      grossAmount += unclaimed;
    }

    if (grossAmount <= 0) {
      return res.status(400).json({ error: 'No claimable earnings' });
    }

    // Calculate fee
    const { rows: feeRows } = await db.query(
      "SELECT value FROM platform_config WHERE key = 'fee_claim'"
    );
    const feePercent = parseFloat(feeRows[0]?.value) || 2.5;
    const feeAmount = Math.round(grossAmount * feePercent) / 100;
    const netAmount = grossAmount - feeAmount;

    // Execute claim in transaction
    const result = await db.transaction(async (client) => {
      // Update earnings as claimed
      for (const [type, amount] of Object.entries(breakdown)) {
        await client.query(
          `UPDATE earnings
           SET total_claimed = total_earned, updated_at = NOW()
           WHERE user_id = $1 AND income_type = $2 AND total_earned > total_claimed`,
          [userId, type]
        );
      }

      // Insert claim transaction
      const { rows } = await client.query(
        `INSERT INTO claim_transactions (user_id, gross_amount, fee_percent, fee_amount, net_amount, breakdown, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'processing')
         RETURNING id`,
        [userId, grossAmount, feePercent, feeAmount, netAmount, JSON.stringify(breakdown)]
      );

      return rows[0];
    });

    // Trigger on-chain claim (non-blocking — actual USDT transfer)
    let txHash = null;
    try {
      // The on-chain claim is initiated by the user's wallet directly
      // Backend records the intent; frontend calls claimAllEarnings() on CommissionPayout
      txHash = 'pending-user-tx';
    } catch (err) {
      console.error('[User] On-chain claim error:', err.message);
    }

    res.json({
      success: true,
      claimId: result.id,
      grossAmount,
      feePercent,
      feeAmount,
      netAmount,
      breakdown,
      txHash,
      message: 'Claim initiated. Please confirm the on-chain transaction in your wallet.',
    });
  } catch (err) {
    console.error('[User] Claim error:', err.message);
    res.status(500).json({ error: 'Claim failed' });
  }
});

// ── GET /api/user/network ──
// Binary tree stats (left/right legs, volumes, VIP sales, team members)
router.get('/network', async (req, res) => {
  try {
    const userId = req.user.id;

    // Get volumes
    const volumes = await treeService.getLeftRightVolumes(userId);
    const weakLeg = await treeService.getWeakLeg(userId);

    // Get team counts
    const teamCounts = await treeService.getTeamCounts(userId);

    // Get direct referrals
    const directReferrals = await treeService.getDirectReferrals(userId);

    res.json({
      directReferrals: directReferrals.length,
      directReferralsList: directReferrals,
      totalMembers: teamCounts.total,
      leftLeg: {
        members: teamCounts.leftCount,
        volume: volumes.leftVolume,
        vipVolume: volumes.leftVipVolume,
        vipCount: volumes.leftVipCount,
        roi: volumes.leftRoi,
      },
      rightLeg: {
        members: teamCounts.rightCount,
        volume: volumes.rightVolume,
        vipVolume: volumes.rightVipVolume,
        vipCount: volumes.rightVipCount,
        roi: volumes.rightRoi,
      },
      weakLeg: weakLeg.weakSide,
      carryForward: volumes.carryForward,
      vipSalesRemaining: volumes.vipSalesRemaining,
    });
  } catch (err) {
    console.error('[User] Network error:', err.message);
    res.status(500).json({ error: 'Failed to load network data' });
  }
});

// ── GET /api/user/tree ──
// Binary tree nodes for UI rendering
router.get('/tree', async (req, res) => {
  try {
    const userId = req.user.id;
    const depth = Math.min(parseInt(req.query.depth, 10) || 4, 8);

    const nodes = await treeService.getTreeNodes(userId, depth);

    res.json({
      rootUserId: userId,
      depth,
      nodes,
      totalNodes: nodes.length,
    });
  } catch (err) {
    console.error('[User] Tree error:', err.message);
    res.status(500).json({ error: 'Failed to load tree data' });
  }
});

module.exports = router;
