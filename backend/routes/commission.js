// ══════════════════════════════════════
// Valtura — Commission Routes
// ══════════════════════════════════════

const router = require('express').Router();
const db = require('../config/db');
const config = require('../config');
const { authenticate, requireRegistered } = require('../middleware/auth');
const roiService = require('../services/roi');
const treeService = require('../services/tree');

// All commission routes require authentication
router.use(authenticate, requireRegistered);

// ── GET /api/commission/overview ──
// Commission overview for the logged-in user
router.get('/overview', async (req, res) => {
  try {
    const userId = req.user.id;

    // Check if user has active Exclusive package
    const hasExclusive = await roiService.hasActiveExclusive(userId);

    // Get Earnings Cap status
    const capStatus = await roiService.getEarningsCapStatus(userId);

    // Get commission breakdown
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
    for (const type of types) {
      const found = earnings.find((e) => e.income_type === type);
      breakdown[type] = {
        total: parseFloat(found?.total_earned) || 0,
        claimed: parseFloat(found?.total_claimed) || 0,
        unclaimed: parseFloat(found?.unclaimed) || 0,
      };
    }

    // Get binary tree volumes for context
    const volumes = await treeService.getWeakLeg(userId);

    res.json({
      eligible: hasExclusive,
      eligibilityNote: hasExclusive
        ? 'You are eligible for all 5 income types'
        : 'Activate an Exclusive (VIP-360) package to unlock commissions',
      earningsCap: {
        hasExclusive: capStatus.hasExclusive,
        vipInvestment: capStatus.vipTotal || 0,
        limit: capStatus.capLimit,
        earned: capStatus.totalEarned,
        remaining: capStatus.remaining === Infinity ? null : capStatus.remaining,
        progress: capStatus.progress || 0,
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

// ── GET /api/commission/momentum ──
// Momentum rewards status and progress
router.get('/momentum', async (req, res) => {
  try {
    const userId = req.user.id;

    // Get weak leg volume (WLP — Weak Leg Points)
    const volumes = await treeService.getWeakLeg(userId);
    const wlp = volumes.weakVolume;

    // Get achieved momentum levels
    const { rows: achievedRows } = await db.query(
      `SELECT description, amount, created_at
       FROM commissions
       WHERE user_id = $1 AND type = 'momentum_rewards'
       ORDER BY created_at DESC`,
      [userId]
    );

    // Determine current level
    let currentLevel = 0;
    for (const milestone of config.momentum) {
      if (wlp >= milestone.threshold) {
        currentLevel = milestone.level;
      } else {
        break;
      }
    }

    // Check which levels have been claimed (reward distributed)
    const claimedLevels = new Set();
    for (const row of achievedRows) {
      const match = row.description?.match(/Level (\d+)/);
      if (match) claimedLevels.add(parseInt(match[1], 10));
    }

    const levels = config.momentum.map((m) => ({
      level: m.level,
      threshold: m.threshold,
      reward: m.reward,
      achieved: wlp >= m.threshold,
      claimed: claimedLevels.has(m.level),
      progress: Math.min(100, (wlp / m.threshold) * 100),
    }));

    // Next milestone
    const nextMilestone = config.momentum.find((m) => wlp < m.threshold);

    res.json({
      currentLevel,
      weakLegPoints: wlp,
      weakLeg: volumes.weakSide,
      nextMilestone: nextMilestone
        ? {
            level: nextMilestone.level,
            threshold: nextMilestone.threshold,
            reward: nextMilestone.reward,
            remaining: nextMilestone.threshold - wlp,
            progress: (wlp / nextMilestone.threshold) * 100,
          }
        : null,
      levels,
      history: achievedRows.map((r) => ({
        description: r.description,
        amount: parseFloat(r.amount),
        date: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[Commission] Momentum error:', err.message);
    res.status(500).json({ error: 'Failed to load momentum data' });
  }
});

// ── GET /api/commission/history ──
// Commission transaction history
router.get('/history', async (req, res) => {
  try {
    const userId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const type = req.query.type; // optional filter

    let countQuery = 'SELECT COUNT(*) as total FROM commissions WHERE user_id = $1';
    let dataQuery = `
      SELECT c.id, c.type, c.amount, c.description, c.created_at,
             su.username as source_username, su.wallet as source_wallet
      FROM commissions c
      LEFT JOIN users su ON su.id = c.source_user
      WHERE c.user_id = $1
    `;
    const params = [userId];

    if (type) {
      countQuery += ' AND type = $2';
      dataQuery += ' AND c.type = $2';
      params.push(type);
    }

    dataQuery += ' ORDER BY c.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);

    const [countResult, dataResult] = await Promise.all([
      db.query(countQuery, params),
      db.query(dataQuery, [...params, limit, offset]),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    res.json({
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      history: dataResult.rows.map((r) => ({
        id: r.id,
        type: r.type,
        amount: parseFloat(r.amount),
        description: r.description,
        sourceUser: r.source_username
          ? { username: r.source_username, wallet: r.source_wallet }
          : null,
        date: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[Commission] History error:', err.message);
    res.status(500).json({ error: 'Failed to load commission history' });
  }
});

module.exports = router;
