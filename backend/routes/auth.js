// ══════════════════════════════════════
// Valtura — Auth Routes (In-Memory)
// ══════════════════════════════════════

const router = require('express').Router();
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../config/db');
const blockchain = require('../services/blockchain');
const treeService = require('../services/tree');
const { authenticate } = require('../middleware/auth');

// ── POST /api/auth/connect ──
// Connect wallet — verify signature, issue JWT, return user profile if registered
router.post('/connect', (req, res) => {
  try {
    const { wallet, signature, message } = req.body;

    if (!wallet || !signature || !message) {
      return res.status(400).json({ error: 'Wallet, signature, and message are required' });
    }

    // Verify signature
    let recoveredAddress;
    try {
      recoveredAddress = blockchain.verifySignature(message, signature);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (recoveredAddress.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(400).json({ error: 'Signature does not match wallet' });
    }

    // Check if user exists
    const user = db.findUser((u) => u.wallet.toLowerCase() === wallet.toLowerCase());

    const token = jwt.sign(
      { wallet: wallet.toLowerCase(), userId: user ? user.id : null },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    if (!user) {
      return res.json({
        connected: true,
        registered: false,
        token,
        user: null,
      });
    }

    // Get active positions summary
    const activePositions = db.store.positions.filter(
      (p) => p.user_id === user.id && p.status === 'active'
    );
    const totalInvested = activePositions.reduce((sum, p) => sum + p.amount, 0);

    res.json({
      connected: true,
      registered: true,
      token,
      user: {
        id: user.id,
        wallet: user.wallet,
        username: user.username,
        totalInvested,
        activePositions: activePositions.length,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('[Auth] Connect error:', err.message);
    res.status(500).json({ error: 'Connection failed' });
  }
});

// ── POST /api/auth/register ──
// Register a new user with wallet + username + referrer
router.post('/register', (req, res) => {
  try {
    const { wallet, username, signature, message, referrer, side } = req.body;

    // Validate wallet address
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Validate username
    if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({
        error: 'Username must be 3-20 characters, alphanumeric and underscore only',
      });
    }

    // Validate signature
    if (!signature || !message) {
      return res.status(400).json({ error: 'Signature and message are required' });
    }

    // Verify EIP-191 signature
    let recoveredAddress;
    try {
      recoveredAddress = blockchain.verifySignature(message, signature);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (recoveredAddress.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(400).json({ error: 'Signature does not match wallet' });
    }

    // Check if wallet already registered
    if (db.findUser((u) => u.wallet.toLowerCase() === wallet.toLowerCase())) {
      return res.status(409).json({ error: 'Wallet already registered' });
    }

    // Check username uniqueness
    if (db.findUser((u) => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Find referrer
    let referrerId = null;
    if (referrer) {
      const refValue = referrer.toLowerCase().replace(/^@/, '');
      const refUser = referrer.startsWith('0x')
        ? db.findUser((u) => u.wallet.toLowerCase() === refValue)
        : db.findUser((u) => u.username.toLowerCase() === refValue);
      if (!refUser) {
        return res.status(400).json({ error: 'Referrer not found' });
      }
      referrerId = refUser.id;
    }

    // Create user
    const placement = side === 'right' ? 'right' : 'left';
    const userId = db.nextUserId();
    const user = {
      id: userId,
      wallet,
      username: username.toLowerCase(),
      referrer_id: referrerId,
      placement,
      created_at: new Date().toISOString(),
    };
    db.store.users.push(user);

    // Place in binary tree
    treeService.placeMember(userId, referrerId, placement);

    // Issue JWT
    const token = jwt.sign(
      { wallet: user.wallet, userId: user.id },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      token,
      user: {
        id: user.id,
        wallet: user.wallet,
        username: user.username,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── GET /api/auth/check-username/:username ──
router.get('/check-username/:username', (req, res) => {
  try {
    const { username } = req.params;

    if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.json({ available: false, reason: 'Invalid format' });
    }

    const exists = db.findUser((u) => u.username.toLowerCase() === username.toLowerCase());

    res.json({
      available: !exists,
      username: username.toLowerCase(),
    });
  } catch (err) {
    console.error('[Auth] Check username error:', err.message);
    res.status(500).json({ error: 'Check failed' });
  }
});

// ── GET /api/auth/me ──
// Get current user profile from JWT
router.get('/me', authenticate, (req, res) => {
  if (!req.user || !req.user.registered) {
    return res.json({ registered: false, wallet: req.user?.wallet || null });
  }

  const activePositions = db.store.positions.filter(
    (p) => p.user_id === req.user.id && p.status === 'active'
  );
  const totalInvested = activePositions.reduce((sum, p) => sum + p.amount, 0);

  // Get referrer
  let referrer = null;
  if (req.user.referrerId) {
    const refUser = db.findUser((u) => u.id === req.user.referrerId);
    if (refUser) referrer = { username: refUser.username, wallet: refUser.wallet };
  }

  res.json({
    registered: true,
    id: req.user.id,
    wallet: req.user.wallet,
    username: req.user.username,
    referrer,
    totalInvested,
    activePositions: activePositions.length,
    createdAt: req.user.createdAt,
  });
});

module.exports = router;
