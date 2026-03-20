// ══════════════════════════════════════
// Valtura — User Routes (In-Memory)
// ══════════════════════════════════════

const router = require('express').Router();
const db = require('../config/db');
const config = require('../config');
const { authenticate, requireRegistered } = require('../middleware/auth');
const treeService = require('../services/tree');

// All user routes require authentication + registration
router.use(authenticate, requireRegistered);

// ── GET /api/user/earnings ──
router.get('/earnings', (req, res) => {
  try {
    const userId = req.user.id;

    const types = ['daily_profit', 'binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards'];
    const breakdown = {};
    let totalEarned = 0;
    let totalClaimed = 0;
    let totalUnclaimed = 0;

    for (const type of types) {
      const rows = db.store.earnings.filter(
        (e) => e.user_id === userId && e.income_type === type
      );
      const earned = rows.reduce((s, e) => s + e.total_earned, 0);
      const claimed = rows.reduce((s, e) => s + e.total_claimed, 0);
      breakdown[type] = {
        total: earned,
        claimed,
        unclaimed: earned - claimed,
      };
      totalEarned += earned;
      totalClaimed += claimed;
      totalUnclaimed += earned - claimed;
    }

    // Earnings Cap status
    const capStatus = getLocalEarningsCapStatus(userId);

    const claimFee = parseFloat(db.getConfigValue('fee_claim')) || 2.5;

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
router.post('/claim', (req, res) => {
  try {
    const userId = req.user.id;

    // Check if user has active Exclusive package
    const hasExclusive = hasActiveExclusive(userId);

    // Get unclaimed earnings
    const types = ['daily_profit', 'binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards'];
    const breakdown = {};
    let grossAmount = 0;

    for (const type of types) {
      const rows = db.store.earnings.filter(
        (e) => e.user_id === userId && e.income_type === type && e.total_earned > e.total_claimed
      );
      const unclaimed = rows.reduce((s, e) => s + (e.total_earned - e.total_claimed), 0);

      // Without Exclusive, only daily profit is claimable
      if (!hasExclusive && type !== 'daily_profit') continue;
      if (unclaimed <= 0) continue;

      breakdown[type] = unclaimed;
      grossAmount += unclaimed;
    }

    if (grossAmount <= 0) {
      return res.status(400).json({ error: 'No claimable earnings' });
    }

    const feePercent = parseFloat(db.getConfigValue('fee_claim')) || 2.5;
    const feeAmount = Math.round(grossAmount * feePercent) / 100;
    const netAmount = grossAmount - feeAmount;

    // Mark earnings as claimed
    for (const type of Object.keys(breakdown)) {
      db.store.earnings
        .filter((e) => e.user_id === userId && e.income_type === type && e.total_earned > e.total_claimed)
        .forEach((e) => {
          e.total_claimed = e.total_earned;
          e.updated_at = new Date().toISOString();
        });
    }

    // Create claim record
    const claimId = db.nextClaimId();
    db.store.claims.push({
      id: claimId,
      user_id: userId,
      gross_amount: grossAmount,
      fee_percent: feePercent,
      fee_amount: feeAmount,
      net_amount: netAmount,
      breakdown: JSON.stringify(breakdown),
      status: 'processing',
      tx_hash: null,
      created_at: new Date().toISOString(),
    });
    db.persist();

    res.json({
      success: true,
      claimId,
      grossAmount,
      feePercent,
      feeAmount,
      netAmount,
      breakdown,
      txHash: 'pending-user-tx',
      message: 'Claim initiated. Please confirm the on-chain transaction in your wallet.',
    });
  } catch (err) {
    console.error('[User] Claim error:', err.message);
    res.status(500).json({ error: 'Claim failed' });
  }
});

// ── GET /api/user/dashboard ──
router.get('/dashboard', (req, res) => {
  try {
    const userId = req.user.id;

    // Active positions
    const activePositions = db.store.positions.filter(
      (p) => p.user_id === userId && p.status === 'active'
    );
    const totalInvested = activePositions.reduce((s, p) => s + p.amount, 0);

    // Earnings summary
    const allEarnings = db.store.earnings.filter((e) => e.user_id === userId);
    const totalEarned = allEarnings.reduce((s, e) => s + e.total_earned, 0);
    const totalClaimed = allEarnings.reduce((s, e) => s + e.total_claimed, 0);
    const totalUnclaimed = totalEarned - totalClaimed;

    // Network stats
    const teamCounts = treeService.getTeamCounts(userId);
    const directReferrals = treeService.getDirectReferrals(userId);

    // Referrer
    let referrer = null;
    if (req.user.referrerId) {
      const refUser = db.findUser((u) => u.id === req.user.referrerId);
      if (refUser) referrer = { username: refUser.username, wallet: refUser.wallet };
    }

    // Earnings Cap
    const capStatus = getLocalEarningsCapStatus(userId);

    res.json({
      user: {
        id: req.user.id,
        wallet: req.user.wallet,
        username: req.user.username,
        referrer,
        createdAt: req.user.createdAt,
      },
      investment: {
        totalInvested,
        activePositions: activePositions.length,
        packages: activePositions.map((p) => ({
          id: p.id,
          packageId: p.package_id,
          name: config.packages[p.package_id]?.name || p.package_id,
          amount: p.amount,
          tier: p.tier,
          dailyRate: p.daily_rate,
          lockDays: p.lock_days,
          startedAt: p.started_at,
          expiresAt: p.expires_at,
        })),
      },
      earnings: {
        total: totalEarned,
        claimed: totalClaimed,
        unclaimed: totalUnclaimed,
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
    console.error('[User] Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ── Helpers ──

function hasActiveExclusive(userId) {
  return db.store.positions.some(
    (p) =>
      p.user_id === userId &&
      p.status === 'active' &&
      ['exclusive360', 'exclusive360_leader'].includes(p.package_id)
  );
}

function getLocalEarningsCapStatus(userId) {
  const vipPositions = db.store.positions.filter(
    (p) =>
      p.user_id === userId &&
      p.status === 'active' &&
      ['exclusive360', 'exclusive360_leader'].includes(p.package_id)
  );
  const vipTotal = vipPositions.reduce((s, p) => s + p.amount, 0);
  const hasVip = vipTotal > 0;

  if (!hasVip) {
    return { hasExclusive: false, capLimit: 0, totalEarned: 0, remaining: null };
  }

  const multiplier = parseFloat(db.getConfigValue('earnings_cap_multi')) || 300;
  const capLimit = (vipTotal * multiplier) / 100;

  const totalEarned = db.store.earnings
    .filter((e) => e.user_id === userId)
    .reduce((s, e) => s + e.total_earned, 0);

  return {
    hasExclusive: true,
    vipTotal,
    capLimit,
    totalEarned,
    remaining: Math.max(0, capLimit - totalEarned),
    progress: capLimit > 0 ? Math.min(100, (totalEarned / capLimit) * 100) : 0,
  };
}

module.exports = router;
