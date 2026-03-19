// ══════════════════════════════════════
// Valtura — Investment Routes
// ══════════════════════════════════════

const router = require('express').Router();
const db = require('../config/db');
const config = require('../config');
const { authenticate, requireRegistered } = require('../middleware/auth');
const treeService = require('../services/tree');
const blockchain = require('../services/blockchain');

// ── GET /api/invest/packages ──
// Return all available package configurations (public)
router.get('/packages', (req, res) => {
  const packages = Object.entries(config.packages)
    .filter(([id]) => id !== 'exclusive360_leader') // Leader is admin-only
    .map(([id, pkg]) => ({
      id,
      name: pkg.name,
      lock: pkg.lock,
      tiers: pkg.tiers,
      min: pkg.min,
      affiliate: pkg.affiliate,
      earningsCap: pkg.earningsCap || null,
      packageType: pkg.packageType,
    }));

  res.json(packages);
});

// Remaining routes require authentication
router.use(authenticate, requireRegistered);

// ── POST /api/invest/deposit ──
// Create a new investment position
router.post('/deposit', async (req, res) => {
  try {
    const { packageType, amount, tier, txHash } = req.body;
    const userId = req.user.id;
    const wallet = req.user.wallet;

    // Validate package
    const pkg = config.packages[packageType];
    if (!pkg) {
      return res.status(400).json({ error: 'Invalid package type' });
    }

    // Cannot directly invest in leader package
    if (packageType === 'exclusive360_leader') {
      return res.status(400).json({ error: 'Leader packages can only be granted by admin' });
    }

    // Validate amount
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < pkg.min) {
      return res.status(400).json({ error: `Minimum investment is $${pkg.min}` });
    }
    if (amountNum % 10 !== 0) {
      return res.status(400).json({ error: 'Amount must be a multiple of $10' });
    }

    // Validate tier
    const tierNum = parseInt(tier, 10) || 1;
    if (tierNum < 1 || tierNum > 3) {
      return res.status(400).json({ error: 'Invalid tier (1-3)' });
    }

    // Daily rate from package tiers
    const dailyRate = pkg.tiers[tierNum - 1];

    // Validate txHash (on-chain deposit confirmation)
    if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return res.status(400).json({ error: 'Valid transaction hash is required' });
    }

    // Check for duplicate txHash
    const { rows: existingTx } = await db.query(
      'SELECT id FROM positions WHERE tx_hash = $1',
      [txHash]
    );
    if (existingTx.length > 0) {
      return res.status(409).json({ error: 'Transaction already processed' });
    }

    // Calculate expiry
    const lockDays = pkg.lock;
    const expiresAt = lockDays > 0
      ? new Date(Date.now() + lockDays * 24 * 60 * 60 * 1000)
      : null;

    // Determine if this is a VIP package (Signature or Exclusive)
    const isVip = ['signature180', 'exclusive360'].includes(packageType);

    // Insert position and update tree in transaction
    const result = await db.transaction(async (client) => {
      // Insert position
      const { rows } = await client.query(
        `INSERT INTO positions (user_id, package_id, amount, tier, daily_rate, lock_days, status, expires_at, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
         RETURNING id, started_at`,
        [userId, packageType, amountNum, tierNum, dailyRate, lockDays, expiresAt, txHash]
      );
      const position = rows[0];

      // Update binary tree volumes
      await treeService.updateVolumes(userId, amountNum, isVip, client);

      // If Exclusive package, update VIP investment on-chain for Earnings Cap
      if (['exclusive360', 'exclusive360_leader'].includes(packageType)) {
        try {
          // Get total Exclusive investment for the user
          const { rows: vipRows } = await client.query(
            `SELECT COALESCE(SUM(amount), 0) as total
             FROM positions
             WHERE user_id = $1 AND status = 'active'
               AND package_id IN ('exclusive360', 'exclusive360_leader')`,
            [userId]
          );
          const vipTotal = parseFloat(vipRows[0]?.total) || 0;
          // Non-blocking on-chain update
          blockchain.setVIPInvestment(wallet, vipTotal).catch((err) => {
            console.error('[Invest] Failed to set VIP investment on-chain:', err.message);
          });
        } catch (err) {
          console.warn('[Invest] On-chain VIP update skipped:', err.message);
        }
      }

      return position;
    });

    res.status(201).json({
      success: true,
      positionId: result.id,
      packageType,
      amount: amountNum,
      tier: tierNum,
      dailyRate,
      lockDays,
      startedAt: result.started_at,
      expiresAt,
    });
  } catch (err) {
    console.error('[Invest] Deposit error:', err.message);
    res.status(500).json({ error: 'Deposit failed' });
  }
});

// ── POST /api/invest/redeem ──
// Request redemption after lock period
router.post('/redeem', async (req, res) => {
  try {
    const { positionId } = req.body;
    const userId = req.user.id;

    if (!positionId) {
      return res.status(400).json({ error: 'Position ID is required' });
    }

    // Get position
    const { rows } = await db.query(
      `SELECT id, package_id, amount, lock_days, status, started_at, expires_at
       FROM positions WHERE id = $1 AND user_id = $2`,
      [positionId, userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Position not found' });
    }

    const position = rows[0];

    if (position.status !== 'active') {
      return res.status(400).json({ error: 'Position is not active' });
    }

    // Check if it was a granted (leader) package — no capital redemption
    const pkg = config.packages[position.package_id];
    if (position.package_id === 'exclusive360_leader') {
      return res.status(400).json({ error: 'Granted packages cannot be redeemed' });
    }

    // Check lock period
    if (position.lock_days > 0) {
      const lockEnd = new Date(position.started_at);
      lockEnd.setDate(lockEnd.getDate() + position.lock_days);
      if (new Date() < lockEnd) {
        const daysLeft = Math.ceil((lockEnd - new Date()) / (1000 * 60 * 60 * 24));
        return res.status(400).json({
          error: `Lock period has not expired. ${daysLeft} days remaining.`,
          lockEnd: lockEnd.toISOString(),
          daysRemaining: daysLeft,
        });
      }
    }

    // Create redeem order in transaction
    const result = await db.transaction(async (client) => {
      // Mark position as completed
      await client.query(
        "UPDATE positions SET status = 'completed' WHERE id = $1",
        [positionId]
      );

      // Create redeem order
      const { rows: orderRows } = await client.query(
        `INSERT INTO redeem_orders (user_id, position_id, amount, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING id, created_at`,
        [userId, positionId, position.amount]
      );

      return orderRows[0];
    });

    // Trigger on-chain redemption request (non-blocking)
    try {
      blockchain.createRedemptionOrder(req.user.wallet, positionId, parseFloat(position.amount)).catch((err) => {
        console.error('[Invest] On-chain redemption request failed:', err.message);
      });
    } catch (err) {
      console.warn('[Invest] On-chain redemption skipped:', err.message);
    }

    // Get redemption fee
    const { rows: feeRows } = await db.query(
      "SELECT value FROM platform_config WHERE key = 'fee_redeem'"
    );
    const feePercent = parseFloat(feeRows[0]?.value) || 5;
    const feeAmount = (parseFloat(position.amount) * feePercent) / 100;

    res.json({
      success: true,
      orderId: result.id,
      positionId,
      amount: parseFloat(position.amount),
      feePercent,
      feeAmount,
      netAmount: parseFloat(position.amount) - feeAmount,
      status: 'pending',
      createdAt: result.created_at,
      message: 'Redemption request submitted. Processing within 12 hours.',
    });
  } catch (err) {
    console.error('[Invest] Redeem error:', err.message);
    res.status(500).json({ error: 'Redemption failed' });
  }
});

// ── GET /api/invest/positions ──
// Get user's investment positions
router.get('/positions', async (req, res) => {
  try {
    const userId = req.user.id;
    const status = req.query.status; // optional filter

    let query = `
      SELECT p.id, p.package_id, p.amount, p.tier, p.daily_rate, p.lock_days,
             p.status, p.started_at, p.expires_at, p.tx_hash,
             COALESCE(SUM(e.total_earned) FILTER (WHERE e.income_type = 'daily_profit'), 0) as total_roi,
             COALESCE(SUM(e.total_claimed) FILTER (WHERE e.income_type = 'daily_profit'), 0) as claimed_roi
      FROM positions p
      LEFT JOIN earnings e ON e.user_id = p.user_id AND e.position_id = p.id
      WHERE p.user_id = $1
    `;
    const params = [userId];

    if (status) {
      query += ' AND p.status = $2';
      params.push(status);
    }

    query += ' GROUP BY p.id ORDER BY p.started_at DESC';

    const { rows } = await db.query(query, params);

    const positions = rows.map((p) => {
      const pkg = config.packages[p.package_id];
      return {
        id: p.id,
        packageId: p.package_id,
        packageName: pkg?.name || p.package_id,
        amount: parseFloat(p.amount),
        tier: p.tier,
        dailyRate: parseFloat(p.daily_rate),
        lockDays: p.lock_days,
        status: p.status,
        startedAt: p.started_at,
        expiresAt: p.expires_at,
        txHash: p.tx_hash,
        totalROI: parseFloat(p.total_roi) || 0,
        claimedROI: parseFloat(p.claimed_roi) || 0,
        unclaimedROI: (parseFloat(p.total_roi) || 0) - (parseFloat(p.claimed_roi) || 0),
        canRedeem: p.status === 'active' && p.lock_days > 0 && p.expires_at && new Date(p.expires_at) <= new Date(),
      };
    });

    res.json({
      total: positions.length,
      active: positions.filter((p) => p.status === 'active').length,
      positions,
    });
  } catch (err) {
    console.error('[Invest] Positions error:', err.message);
    res.status(500).json({ error: 'Failed to load positions' });
  }
});

module.exports = router;
