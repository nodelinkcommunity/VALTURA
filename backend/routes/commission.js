// ══════════════════════════════════════
// Veltura — Commission Routes (In-Memory)
// ══════════════════════════════════════

const router = require('express').Router();
const db = require('../config/db');
const config = require('../config');
const { authenticate, requireRegistered } = require('../middleware/auth');
const treeService = require('../services/tree');

// All commission routes require authentication
router.use(authenticate, requireRegistered);

// ── GET /api/commission/overview ──
router.get('/overview', (req, res) => {
  try {
    const userId = req.user.id;

    // Check if user has active Exclusive package
    const hasExclusive = db.store.positions.some(
      (p) =>
        p.user_id === userId &&
        p.status === 'active' &&
        ['exclusive360', 'exclusive360_leader'].includes(p.package_id)
    );

    // Earnings Cap
    const vipPositions = db.store.positions.filter(
      (p) =>
        p.user_id === userId &&
        p.status === 'active' &&
        ['exclusive360', 'exclusive360_leader'].includes(p.package_id)
    );
    const vipTotal = vipPositions.reduce((s, p) => s + p.amount, 0);
    const multiplier = parseFloat(db.getConfigValue('earnings_cap_multi')) || 300;
    const capLimit = (vipTotal * multiplier) / 100;
    const totalEarned = db.store.earnings
      .filter((e) => e.user_id === userId)
      .reduce((s, e) => s + e.total_earned, 0);

    // Commission breakdown
    const types = ['daily_profit', 'binary_bonus', 'referral_commission', 'binary_commission', 'momentum_rewards'];
    const breakdown = {};
    for (const type of types) {
      const rows = db.store.earnings.filter(
        (e) => e.user_id === userId && e.income_type === type
      );
      breakdown[type] = {
        total: rows.reduce((s, e) => s + e.total_earned, 0),
        claimed: rows.reduce((s, e) => s + e.total_claimed, 0),
        unclaimed: rows.reduce((s, e) => s + (e.total_earned - e.total_claimed), 0),
      };
    }

    // Binary tree volumes
    const volumes = treeService.getWeakLeg(userId);

    res.json({
      eligible: hasExclusive,
      eligibilityNote: hasExclusive
        ? 'You are eligible for all 5 income types'
        : 'Activate an Exclusive (VIP-360) package to unlock commissions',
      earningsCap: {
        hasExclusive: vipTotal > 0,
        vipInvestment: vipTotal,
        limit: capLimit,
        earned: totalEarned,
        remaining: vipTotal > 0 ? Math.max(0, capLimit - totalEarned) : null,
        progress: capLimit > 0 ? Math.min(100, (totalEarned / capLimit) * 100) : 0,
      },
      breakdown,
      binaryInfo: {
        weakLeg: volumes.weakSide,
        leftVipVolume: volumes.leftVipVolume,
        rightVipVolume: volumes.rightVipVolume,
        carryForward: volumes.carryForward,
      },
    });
  } catch (err) {
    console.error('[Commission] Overview error:', err.message);
    res.status(500).json({ error: 'Failed to load commission overview' });
  }
});

// ── GET /api/commission/network ──
router.get('/network', (req, res) => {
  try {
    const userId = req.user.id;

    const volumes = treeService.getLeftRightVolumes(userId);
    const weakLeg = treeService.getWeakLeg(userId);
    const teamCounts = treeService.getTeamCounts(userId);
    const directReferrals = treeService.getDirectReferrals(userId);

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
    });
  } catch (err) {
    console.error('[Commission] Network error:', err.message);
    res.status(500).json({ error: 'Failed to load network data' });
  }
});

module.exports = router;
