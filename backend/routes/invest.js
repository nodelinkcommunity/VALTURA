// ══════════════════════════════════════
// Valtura — Investment Routes (In-Memory)
// ══════════════════════════════════════

const router = require('express').Router();
const db = require('../config/db');
const config = require('../config');
const { authenticate, requireRegistered } = require('../middleware/auth');
const treeService = require('../services/tree');

// ── GET /api/invest/packages ──
router.get('/packages', (req, res) => {
  const packages = Object.entries(config.packages)
    .filter(([id]) => id !== 'exclusive360_leader')
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
router.post('/deposit', (req, res) => {
  try {
    const { amount, tier, txHash } = req.body;
    const packageKey = req.body.package || req.body.packageType;
    const userId = req.user.id;

    // Resolve package by key or by packageType number
    let pkg = null;
    let pkgId = null;
    if (typeof packageKey === 'string' && config.packages[packageKey]) {
      pkg = config.packages[packageKey];
      pkgId = packageKey;
    } else {
      // Find by packageType number
      const entry = Object.entries(config.packages).find(
        ([, p]) => p.packageType === parseInt(packageKey, 10)
      );
      if (entry) {
        pkgId = entry[0];
        pkg = entry[1];
      }
    }

    if (!pkg) {
      return res.status(400).json({ error: 'Invalid package type' });
    }

    if (pkgId === 'exclusive360_leader') {
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

    const dailyRate = pkg.tiers[tierNum - 1];

    // Validate txHash
    if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return res.status(400).json({ error: 'Valid transaction hash is required' });
    }

    // Check duplicate
    if (db.store.positions.find((p) => p.tx_hash === txHash)) {
      return res.status(409).json({ error: 'Transaction already processed' });
    }

    const lockDays = pkg.lock;
    const now = new Date();
    const expiresAt = lockDays > 0
      ? new Date(now.getTime() + lockDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const posId = db.nextPositionId();
    const position = {
      id: posId,
      user_id: userId,
      package_id: pkgId,
      amount: amountNum,
      tier: tierNum,
      daily_rate: dailyRate,
      lock_days: lockDays,
      status: 'active',
      started_at: now.toISOString(),
      expires_at: expiresAt,
      tx_hash: txHash,
    };
    db.store.positions.push(position);

    // Update binary tree volumes
    const isVip = ['signature180', 'exclusive360'].includes(pkgId);
    treeService.updateVolumes(userId, amountNum, isVip);

    res.status(201).json({
      success: true,
      positionId: posId,
      packageType: pkgId,
      amount: amountNum,
      tier: tierNum,
      dailyRate,
      lockDays,
      startedAt: position.started_at,
      expiresAt,
    });
  } catch (err) {
    console.error('[Invest] Deposit error:', err.message);
    res.status(500).json({ error: 'Deposit failed' });
  }
});

// ── GET /api/invest/positions ──
router.get('/positions', (req, res) => {
  try {
    const userId = req.user.id;
    const statusFilter = req.query.status;

    let positions = db.store.positions.filter((p) => p.user_id === userId);
    if (statusFilter) {
      positions = positions.filter((p) => p.status === statusFilter);
    }

    const result = positions.map((p) => {
      const pkg = config.packages[p.package_id];
      // Get earnings for this position
      const earningRows = db.store.earnings.filter(
        (e) => e.user_id === userId && e.position_id === p.id && e.income_type === 'daily_profit'
      );
      const totalROI = earningRows.reduce((s, e) => s + e.total_earned, 0);
      const claimedROI = earningRows.reduce((s, e) => s + e.total_claimed, 0);

      return {
        id: p.id,
        packageId: p.package_id,
        packageName: pkg?.name || p.package_id,
        amount: p.amount,
        tier: p.tier,
        dailyRate: p.daily_rate,
        lockDays: p.lock_days,
        status: p.status,
        startedAt: p.started_at,
        expiresAt: p.expires_at,
        txHash: p.tx_hash,
        totalROI,
        claimedROI,
        unclaimedROI: totalROI - claimedROI,
        canRedeem: p.status === 'active' && p.lock_days > 0 && p.expires_at && new Date(p.expires_at) <= new Date(),
      };
    });

    res.json({
      total: result.length,
      active: result.filter((p) => p.status === 'active').length,
      positions: result.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)),
    });
  } catch (err) {
    console.error('[Invest] Positions error:', err.message);
    res.status(500).json({ error: 'Failed to load positions' });
  }
});

// ── POST /api/invest/redeem ──
router.post('/redeem', (req, res) => {
  try {
    const { positionId } = req.body;
    const userId = req.user.id;

    if (!positionId) {
      return res.status(400).json({ error: 'Position ID is required' });
    }

    const position = db.store.positions.find(
      (p) => p.id === parseInt(positionId, 10) && p.user_id === userId
    );

    if (!position) {
      return res.status(404).json({ error: 'Position not found' });
    }

    if (position.status !== 'active') {
      return res.status(400).json({ error: 'Position is not active' });
    }

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

    // Mark position as completed
    position.status = 'completed';

    // Create redeem order
    const orderId = db.nextRedeemId();
    const order = {
      id: orderId,
      user_id: userId,
      position_id: position.id,
      amount: position.amount,
      status: 'pending',
      tx_hash: null,
      created_at: new Date().toISOString(),
      processed_at: null,
    };
    db.store.redemptions.push(order);

    const feePercent = parseFloat(db.getConfigValue('fee_redeem')) || 5;
    const feeAmount = (position.amount * feePercent) / 100;

    res.json({
      success: true,
      orderId,
      positionId: position.id,
      amount: position.amount,
      feePercent,
      feeAmount,
      netAmount: position.amount - feeAmount,
      status: 'pending',
      createdAt: order.created_at,
      message: 'Redemption request submitted. Processing within 12 hours.',
    });
  } catch (err) {
    console.error('[Invest] Redeem error:', err.message);
    res.status(500).json({ error: 'Redemption failed' });
  }
});

module.exports = router;
